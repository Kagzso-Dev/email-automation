"""Call orchestration + real-time conversation engine.

Pipeline per customer turn (all async, nothing blocks the WebSocket loop):

    Plivo media (mu-law 8k) -> VAD endpointer -> [utterance]
        -> Sarvam STT -> LLM (streamed) -> sentence chunker
        -> Cartesia TTS (streamed, mu-law 8k) -> Plivo playAudio

Barge-in: when the VAD detects customer speech while the agent is generating
or playing audio, the in-flight turn is cancelled (LLM + TTS), Plivo's queued
audio is cleared with `clearAudio`, and the new utterance is processed.

Latency markers (per turn):
    T1 customer utterance received (end of speech)   T2 STT completed
    T3 LLM started   T4 LLM completed   T5 TTS started   T6 first TTS audio
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Protocol, Set, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings as default_settings
from app.core.logging import call_context, get_logger
from app.db import repositories as repo
from app.db.database import session_factory
from app.db.models import FINAL_CALL_STATUSES, LOCKED_OUTCOMES, Call, CallOutcome, CallStatus, utcnow
from app.flows.loader import FlowError, resolve_flow_agent
from app.schemas.calls import OutboundCallRequest
from app.services import audio_service as audio
from app.services import status_callback
from app.services.cartesia_tts import CartesiaTTS, TTSError, TTSProvider, create_tts_provider
from app.services.llm_service import (
    OUTCOME_SYSTEM,
    LLMError,
    LLMProvider,
    SentenceChunker,
    build_call_variables,
    clean_spoken_text,
    create_llm_provider,
    extract_end_call,
    parse_outcome,
    parse_reached,
    render_first_message,
    safe_variables,
)
from app.services.plivo_service import PlivoError, PlivoService, get_plivo_service
from app.services.twilio_service import TwilioService, get_twilio_service
from app.services.sarvam_stt import STTError, STTProvider, create_stt_provider
from app.services.session_store import SessionStore, get_session_store

log = get_logger("voice.pipeline")

GREETING_INSTRUCTION = (
    "(The customer has picked up the phone but has not said anything yet. "
    "Greet them warmly, introduce yourself in one sentence, and ask if now is a good time.)"
)
FALLBACK_REPLIES = {
    "en": "Sorry, I couldn't hear you clearly. Could you please repeat that?",
    "ta": "Sorry, clear-ஆ கேக்கல. கொஞ்சம் repeat பண்ணுங்க please.",
}
# Silence handling (script "SILENCE"): one re-prompt, then a polite close.
SILENCE_REPROMPTS = {"en": "Hello, can you hear me?", "ta": "Hello, கேக்குதா? Hear பண்றீங்களா?"}
SILENCE_CLOSINGS = {
    "en": "No problem. Thank you for your time. Have a nice day.",
    "ta": "No problem. Thank you for your time. Have a nice day.",
}


_VOICE_ROTATION_LOCK = asyncio.Lock()

# Short line checks / backchannels ("Hello?", "Yes", "Hmm", "Can you hear me?") said while the agent
# is talking or preparing a reply: the agent's reply already answers them, so they never interrupt.
_FILLER_WORDS = {
    "hello", "helo", "hallo", "hi", "hey", "yes", "yeah", "ya", "yep", "yup", "ok", "okay", "ha", "haan", "han",
    "hmm", "hm", "mm", "mhm", "uh", "um", "ah", "oh", "sir", "madam", "can", "you", "hear", "me", "are", "there",
}


def is_filler(text: str) -> bool:
    words = [w for w in "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()]
    return 0 < len(words) <= 7 and all(w in _FILLER_WORDS for w in words)


# A bare "Hello?" in answer to "Hi, is this <name>?" is not a yes - the customer is
# just checking the line. The identity question is asked once more before moving on.
_GREETING_ONLY_WORDS = {"hello", "helo", "hallo", "halo", "hi", "hey", "hmm", "hm"}
IDENTITY_REASK = "Sorry, am I speaking with {name}?"


def is_greeting_only(text: str) -> bool:
    words = "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()
    return 0 < len(words) <= 3 and all(w in _GREETING_ONLY_WORDS for w in words)


def _lang(language: Optional[str]) -> str:
    return (language or default_settings.CALL_LANGUAGE or "en").split("-")[0].lower()


def fallback_reply(language: Optional[str] = None) -> str:
    return FALLBACK_REPLIES.get(_lang(language), FALLBACK_REPLIES["en"])


def silence_reprompt(language: Optional[str] = None) -> str:
    return SILENCE_REPROMPTS.get(_lang(language), SILENCE_REPROMPTS["en"])


def silence_closing(language: Optional[str] = None) -> str:
    return SILENCE_CLOSINGS.get(_lang(language), SILENCE_CLOSINGS["en"])


_NAME_ALIAS_RE = re.compile(r"\{\{\s*name\s*\}\}")


def greeting_needs_name(first_message: str) -> bool:
    """The opening line speaks the customer's name, so a call without one is refused."""
    return "customer_name" in first_message or bool(_NAME_ALIAS_RE.search(first_message))


def _ms(a: Optional[float], b: Optional[float]) -> Optional[int]:
    return int((b - a) * 1000) if a is not None and b is not None else None


# ===========================================================================
# Provider container (overridable in tests)
# ===========================================================================
@dataclass
class Providers:
    stt: STTProvider
    llm: LLMProvider
    tts: TTSProvider
    plivo: PlivoService
    twilio: Optional[TwilioService] = None

    def telephony(self, name: Optional[str] = None):
        """Phone provider by name (default: TELEPHONY_PROVIDER)."""
        name = (name or default_settings.telephony_provider).lower()
        if name == "twilio":
            if self.twilio is None:
                self.twilio = get_twilio_service()
            return self.twilio
        return self.plivo

    def tts_for_voice(self, voice_id: Optional[str]) -> TTSProvider:
        if voice_id and isinstance(self.tts, CartesiaTTS) and voice_id != self.tts.voice_id:
            return CartesiaTTS(self.tts.cfg, voice_id=voice_id, client=self.tts._client)
        return self.tts

    async def aclose(self) -> None:
        for p in (self.stt, self.llm, self.tts, self.twilio):
            if p is None:
                continue
            try:
                await p.aclose()
            except Exception:
                pass


_providers: Optional[Providers] = None


def get_providers() -> Providers:
    global _providers
    if _providers is None:
        _providers = Providers(
            stt=create_stt_provider("sarvam"),
            llm=create_llm_provider(),
            tts=create_tts_provider("cartesia"),
            plivo=get_plivo_service(),
            twilio=get_twilio_service(),
        )
    return _providers


def set_providers(p: Optional[Providers]) -> None:
    global _providers
    _providers = p


# ===========================================================================
# Status transitions
# ===========================================================================
async def transition(
    db: AsyncSession, call: Call, status: CallStatus, payload: Optional[dict] = None, **fields: Any
) -> None:
    """Update call status (never regress from a final state) and persist an event."""
    current = CallStatus(call.status)
    if current in FINAL_CALL_STATUSES and status not in FINAL_CALL_STATUSES:
        if fields:
            await repo.update_call(db, call, **fields)
        return
    if current == CallStatus.completed and status in FINAL_CALL_STATUSES and status != CallStatus.completed:
        status = CallStatus.completed  # a conversation happened; keep "completed"
    await repo.update_call(db, call, status=status.value, **fields)
    if status in FINAL_CALL_STATUSES:
        _GREETING_AUDIO.pop(call.id, None)  # unanswered calls never use it
    await repo.add_event(db, call.id, f"status:{status.value}", payload)
    await get_session_store().set_fields(call.id, status=status.value)
    log.info("Call status -> %s", status.value)
    status_callback.notify(call)


# ===========================================================================
# Pre-rendered greeting
# ===========================================================================
# The fixed first sentence is synthesized while the phone is still ringing and
# played the moment the call is answered. Without this, the customer hears
# silence for the greeting delay plus a full TTS round-trip, and often hangs up.
_GREETING_AUDIO: Dict[str, Tuple[str, bytes]] = {}
_PRERENDER_TASKS: Set[asyncio.Task] = set()


async def prerender_greeting(call_id: str, text: str, voice_id: Optional[str]) -> None:
    try:
        mulaw = await asyncio.wait_for(get_providers().tts_for_voice(voice_id).synthesize(text), timeout=15)
    except Exception as exc:  # live TTS still works; never fail the call over this
        log.warning("Greeting pre-render failed (%s) - it will be streamed live", type(exc).__name__)
        return
    if mulaw:
        _GREETING_AUDIO[call_id] = (text, mulaw)
        log.info("Greeting pre-rendered (%.1fs of audio)", audio.mulaw_duration_seconds(len(mulaw)))


def schedule_greeting_prerender(call_id: str, text: str, voice_id: Optional[str]) -> None:
    task = asyncio.get_running_loop().create_task(prerender_greeting(call_id, text, voice_id))
    _PRERENDER_TASKS.add(task)
    task.add_done_callback(_PRERENDER_TASKS.discard)


def has_greeting_audio(call_id: str) -> bool:
    return call_id in _GREETING_AUDIO


def take_greeting_audio(call_id: str, text: str) -> Optional[bytes]:
    """The pre-rendered greeting, if it matches the text about to be spoken (used once)."""
    entry = _GREETING_AUDIO.pop(call_id, None)
    return entry[1] if entry and entry[0] == text else None


class CallError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ===========================================================================
# Outbound call
# ===========================================================================
async def start_outbound_call(db: AsyncSession, req: OutboundCallRequest, cfg: Settings = default_settings) -> Call:
    providers = get_providers()
    if not cfg.telephony_configured() or not cfg.PUBLIC_BASE_URL:
        raise CallError(503, f"{cfg.telephony_provider.title()} is not configured on the server (credentials / PUBLIC_BASE_URL)")

    if req.agent_id is not None:
        agent = await repo.get_agent(db, req.agent_id)
    else:
        agent = await repo.get_agent_by_name(db, req.agent_name or "")
    if agent is None:
        raise CallError(404, "Agent not found")
    if not agent.active:
        raise CallError(400, "Agent is not active")

    # A call flow from Dispatch replaces the agent; a missing / invalid flow falls back
    # to the agent requested above, so the call still goes out exactly as before.
    flow_vars: Dict[str, Optional[str]] = {}
    flow_event: Optional[Tuple[str, dict]] = None
    time_limit: Optional[int] = None
    if req.flow_id is not None:
        try:
            resolved = await resolve_flow_agent(db, req.flow_id, req.flow_version or 0, req.flow_draft, req.flow)
        except FlowError as exc:
            log.warning("Call flow %s v%s not used (%s) - falling back to agent '%s'",
                        req.flow_id, req.flow_version, exc.reason, agent.name)
            flow_vars = {"flow_id": req.flow_id, "flow_version": str(req.flow_version), "flow_fallback": exc.reason}
            flow_event = ("flow:fallback", {**flow_vars, "agent_id": agent.id, "errors": exc.errors[:5]})
        else:
            agent = resolved.agent
            flow_vars = {**resolved.info, "flow_silence_reprompt": resolved.flow.silence.reprompt,
                         "flow_silence_closing": resolved.flow.silence.closing}
            time_limit = min(resolved.flow.limits.max_duration_sec, cfg.MAX_CALL_DURATION_SECONDS)
            flow_event = ("flow:selected", {**resolved.info, "agent_id": agent.id, "time_limit": time_limit})

    existing = await repo.get_contact_by_phone(db, req.phone_number)
    if existing is not None and existing.dnd:
        raise CallError(409, "Contact is marked Do-Not-Disturb; call not placed")
    if agent.first_message and greeting_needs_name(agent.first_message) and not (req.name or (existing and existing.name)):
        # e.g. "Hi, is this {{customer_name}}?" cannot be spoken without a name, and we never invent one.
        raise CallError(422, f"customer_name is required for agent '{agent.name}' (its first sentence uses the name)")
    contact = await repo.upsert_contact(
        db, req.phone_number, req.name, req.company_name, req.email,
        gender=req.gender, business_type=req.business_type,
    )

    name = contact.name or req.name
    # Only an explicitly provided gender is used; never inferred.
    variables = build_call_variables(
        name,
        contact.gender,
        req.phone_number,
        follow_up_detail=req.follow_up_detail,
        company_name=contact.company_name or req.company_name,
        business_type=contact.business_type or req.business_type,
        run_id=req.run_id,
        log_id=req.log_id,
    )
    variables.update(flow_vars)
    rotation = cfg.voice_rotation
    async with _VOICE_ROTATION_LOCK:  # pick + insert together so concurrent calls get different voices
        voice_id = await repo.next_rotation_voice(db, rotation) if rotation else None
        call = await repo.create_call(
            db,
            voice_id=voice_id,
            agent_id=agent.id,
            contact_id=contact.id,
            from_number=cfg.telephony_from_number,
            telephony_provider=cfg.telephony_provider,
            to_number=req.phone_number,
            status=CallStatus.created.value,
            direction="outbound",
            variables=variables,
        )
    with call_context(call.id):
        await repo.add_event(db, call.id, "status:created", {"agent_id": agent.id, "voice_id": voice_id})
        if flow_event:
            await repo.add_event(db, call.id, *flow_event)
        if voice_id:
            log.info("Voice rotation: using voice %s", voice_id)
        await get_session_store().set_fields(call.id, status="created", agent_id=agent.id, processing_state="idle")
        await transition(db, call, CallStatus.initiating, started_at=utcnow())
        try:
            result = await providers.telephony(call.telephony_provider).make_outbound_call(
                call.id, req.phone_number, time_limit=time_limit)
        except PlivoError as exc:
            await transition(db, call, CallStatus.failed, {"error": exc.kind}, outcome=CallOutcome.call_failed.value, ended_at=utcnow())
            raise CallError(502 if exc.kind != "not_configured" else 503,
                            f"{call.telephony_provider.title()} call failed: {exc}") from None
        await repo.update_call(db, call, provider_request_id=result.request_uuid, provider_call_id=result.request_uuid)
        await repo.add_event(db, call.id, f"{call.telephony_provider}:call_fired", {"request_uuid": result.request_uuid})
        await get_session_store().set_fields(call.id, provider_request_id=result.request_uuid)
        log.info("Plivo outbound call fired")
        if cfg.GREETING_PRERENDER and agent.first_message:
            greeting = render_first_message(agent.first_message, variables)
            if greeting:
                schedule_greeting_prerender(call.id, greeting, call.voice_id or agent.voice_id)
    return call


# ===========================================================================
# Webhooks
# ===========================================================================
SAFE_WEBHOOK_KEYS = (
    "Event", "CallStatus", "CallUUID", "RequestUUID", "Direction", "HangupCause", "HangupCauseName",
    "HangupCauseCode", "HangupSource", "Duration", "BillDuration", "AnswerTime", "StartTime", "EndTime",
    "StreamID", "StreamId", "Status", "Error", "Machine",
)


def safe_params(params: Mapping[str, str]) -> Dict[str, str]:
    return {k: str(params[k])[:200] for k in SAFE_WEBHOOK_KEYS if k in params}


async def find_call(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> Optional[Call]:
    if call_id:
        call = await repo.get_call(db, call_id)
        if call:
            return call
    for key in ("CallUUID", "RequestUUID"):
        if params.get(key):
            call = await repo.get_call_by_provider_id(db, params[key])
            if call:
                return call
    return None


async def handle_answer(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> str:
    call = await find_call(db, call_id, params)
    plivo = get_providers().telephony(call.telephony_provider if call else None)
    if call is None:
        log.warning("Answer webhook for unknown call - hanging up")
        return plivo.hangup_xml()
    with call_context(call.id):
        if CallStatus(call.status) in FINAL_CALL_STATUSES:
            return plivo.hangup_xml()
        fields: Dict[str, Any] = {"answered_at": utcnow()}
        if params.get("CallUUID"):
            fields["provider_call_id"] = params["CallUUID"]
        await transition(db, call, CallStatus.answered, safe_params(params), **fields)
        await get_session_store().set_fields(call.id, provider_call_id=params.get("CallUUID", ""))
        return plivo.build_stream_xml(call.id)


def _parse_plivo_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:19], fmt)
        except ValueError:
            continue
    return None


def map_hangup_status(params: Mapping[str, str], answered: bool) -> CallStatus:
    status = (params.get("CallStatus") or "").lower()
    cause = f"{params.get('HangupCauseName', '')} {params.get('HangupCause', '')}".lower()
    if answered or (params.get("AnswerTime") and status == "completed"):
        return CallStatus.completed
    if "busy" in status or "busy" in cause or "rejected" in cause:
        return CallStatus.busy
    if status in ("no-answer", "timeout") or "no answer" in cause or "no_answer" in cause or "timeout" in cause:
        return CallStatus.no_answer
    if "cancel" in status or "cancel" in cause:
        return CallStatus.cancelled
    return CallStatus.failed


async def handle_machine_detection(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> None:
    """Plivo async AMD callback (Event=MachineDetection, Machine=true|false)."""
    call = await find_call(db, call_id, params)
    if call is None:
        return
    with call_context(call.id):
        is_machine = str(params.get("Machine", "")).lower() == "true"
        await repo.add_event(db, call.id, "plivo:machine_detection", {"machine": is_machine})
        if not is_machine:
            return
        log.info("Voicemail / answering machine detected - hanging up without the sales pitch")
        await repo.update_call(db, call, outcome=CallOutcome.voicemail.value)
        session = ACTIVE_SESSIONS.get(call.id)
        if session is not None:
            session.end_call_requested = True
            if session._turn_task and not session._turn_task.done():
                session._turn_task.cancel()
        uuid = params.get("CallUUID") or call.provider_call_id
        if uuid:
            await get_providers().telephony(call.telephony_provider).hangup(uuid)


OUTCOME_FOR_STATUS = {
    CallStatus.busy: CallOutcome.busy,
    CallStatus.no_answer: CallOutcome.no_answer,
    CallStatus.failed: CallOutcome.call_failed,
    CallStatus.cancelled: CallOutcome.call_failed,
}


async def handle_status(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> None:
    call = await find_call(db, call_id, params)
    if call is None:
        log.warning("Status webhook for unknown call")
        return
    with call_context(call.id):
        event = (params.get("Event") or "").lower()
        call_status = (params.get("CallStatus") or "").lower()
        if event == "ring" or call_status == "ringing":
            fields = {"provider_call_id": params["CallUUID"]} if params.get("CallUUID") else {}
            await transition(db, call, CallStatus.ringing, safe_params(params), **fields)
            return
        if event == "hangup" or call_status in ("completed", "busy", "failed", "no-answer", "cancel", "timeout"):
            final = map_hangup_status(params, answered=call.answered_at is not None)
            fields: Dict[str, Any] = {
                "ended_at": _parse_plivo_time(params.get("EndTime")) or utcnow(),
                "hangup_cause": (params.get("HangupCauseName") or params.get("HangupCause") or None),
            }
            if params.get("Duration", "").isdigit():
                fields["duration_seconds"] = int(params["Duration"])
            if params.get("AnswerTime") and call.answered_at is None:
                fields["answered_at"] = _parse_plivo_time(params["AnswerTime"])
            # Outcome of answered calls is owned by finalize_conversation (it races
            # with this webhook); here we only set outcomes for unanswered calls.
            if final in OUTCOME_FOR_STATUS and not call.outcome:
                fields["outcome"] = OUTCOME_FOR_STATUS[final].value
            await transition(db, call, final, safe_params(params), **fields)
            return
        await repo.add_event(db, call.id, "plivo:status", safe_params(params))


# ===========================================================================
# Conversation engine
# ===========================================================================
class AudioSender(Protocol):
    async def send_audio(self, mulaw: bytes) -> None: ...
    async def clear(self) -> None: ...
    async def checkpoint(self, name: str) -> None: ...


@dataclass
class CallContextData:
    call_id: str
    agent_prompt: str
    variables: Dict[str, Optional[str]]
    first_message: Optional[str] = None
    voice_id: Optional[str] = None
    provider_call_id: Optional[str] = None
    contact_id: Optional[int] = None
    telephony_provider: str = "plivo"
    # Call-flow silence lines (already rendered); None = the built-in lines.
    silence_reprompt: Optional[str] = None
    silence_closing: Optional[str] = None


@dataclass
class TurnMetrics:
    t1: Optional[float] = None
    t2: Optional[float] = None
    t3: Optional[float] = None
    t3_first_token: Optional[float] = None
    t4: Optional[float] = None
    t5: Optional[float] = None
    t6: Optional[float] = None

    def as_row(self) -> Dict[str, Optional[int]]:
        return {
            "stt_ms": _ms(self.t1, self.t2),
            "llm_ms": _ms(self.t3, self.t4),
            "llm_first_token_ms": _ms(self.t3, self.t3_first_token),
            "tts_first_byte_ms": _ms(self.t5, self.t6),
            "total_response_ms": _ms(self.t1, self.t6),
        }


@dataclass
class _TurnState:
    user_text: Optional[str]
    record_user: bool
    scripted: Optional[str] = None  # fixed text spoken verbatim instead of asking the LLM
    is_greeting: bool = False
    spoken: List[str] = field(default_factory=list)
    audio_started: bool = False


ACTIVE_SESSIONS: Dict[str, "CallSession"] = {}


class CallSession:
    SEND_CHUNK_BYTES = 4000  # 0.5 s of mu-law per playAudio message

    def __init__(
        self,
        ctx: CallContextData,
        sender: AudioSender,
        providers: Optional[Providers] = None,
        cfg: Settings = default_settings,
        classifier: Optional[audio.SpeechClassifier] = None,
        store: Optional[SessionStore] = None,
    ):
        self.ctx = ctx
        self.call_id = ctx.call_id
        self.sender = sender
        self.cfg = cfg
        self.providers = providers or get_providers()
        self.tts = self.providers.tts_for_voice(ctx.voice_id)
        self.store = store or get_session_store()
        self.endpointer = audio.SpeechEndpointer(
            classifier or audio.make_webrtc_classifier(cfg.VAD_AGGRESSIVENESS, cfg.VAD_MIN_RMS),
            start_ms=cfg.VAD_SPEECH_START_MS,
            end_silence_ms=cfg.VAD_SPEECH_END_SILENCE_MS,
            min_utterance_ms=cfg.VAD_MIN_UTTERANCE_MS,
            max_utterance_ms=cfg.MAX_UTTERANCE_SECONDS * 1000,
        )
        self.history: List[Dict[str, str]] = []
        self.state = CallStatus.connected.value
        self.turn_index = 0
        self._turn_task: Optional[asyncio.Task] = None
        self._greeting_task: Optional[asyncio.Task] = None
        self._hangup_task: Optional[asyncio.Task] = None
        self._pending_user_text = ""
        self._playback_until = 0.0
        self._playback_started = 0.0
        self._barge_candidate = False  # customer speech started while the agent was busy, not yet confirmed
        self._barge_loud_ms = 0
        self._barge_check_task: Optional[asyncio.Task] = None
        self._audio_since_clear = False
        self._checkpoint: Optional[str] = None
        self._playback_done = asyncio.Event()
        self._playback_done.set()
        self._customer_spoke = False
        self._greeted = not ctx.first_message  # agents without a fixed greeting skip this step
        self._identity_reasked = False
        self._agent_spoke = False
        self._last_activity = time.monotonic()
        self._silence_prompts = 0
        self._silence_task: Optional[asyncio.Task] = None
        self.end_call_requested = False
        self._closed = False
        self._db_queue: "asyncio.Queue[Callable[[AsyncSession], Awaitable[None]]]" = asyncio.Queue()
        self._db_worker: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        ACTIVE_SESSIONS[self.call_id] = self
        self._db_worker = asyncio.create_task(self._run_db_worker())
        await self._set_state(CallStatus.listening.value)
        self._greeting_task = asyncio.create_task(self._greet_if_silent())
        self._silence_task = asyncio.create_task(self._watch_silence())

    async def close(self, reason: str = "stream_stopped") -> None:
        if self._closed:
            return
        self._closed = True
        ACTIVE_SESSIONS.pop(self.call_id, None)
        for task in (self._greeting_task, self._silence_task, self._turn_task, self._hangup_task, self._barge_check_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:
                    pass
        try:
            await asyncio.wait_for(self._db_queue.join(), timeout=10)
        except asyncio.TimeoutError:
            log.warning("Timed out flushing pending DB writes")
        if self._db_worker:
            self._db_worker.cancel()
            try:
                await self._db_worker
            except BaseException:
                pass
        await finalize_conversation(self.call_id, self.providers.llm, reason)
        await self.store.delete(self.call_id)

    # ------------------------------------------------------------------ persistence
    def _persist(self, fn: Callable[[AsyncSession], Awaitable[None]]) -> None:
        """Queue an ordered DB write without blocking the audio path."""
        self._db_queue.put_nowait(fn)

    async def _run_db_worker(self) -> None:
        with call_context(self.call_id):
            while True:
                fn = await self._db_queue.get()
                try:
                    async with session_factory()() as db:
                        await fn(db)
                except Exception as exc:
                    log.error("DB write failed: %s", type(exc).__name__)
                finally:
                    self._db_queue.task_done()

    def _event(self, event_type: str, payload: Optional[dict] = None) -> None:
        self._persist(lambda db: repo.add_event(db, self.call_id, event_type, payload))

    async def _set_state(self, state: str) -> None:
        self.state = state
        audio_state = "playing" if state == CallStatus.speaking.value else "idle"
        await self.store.set_fields(self.call_id, conversation_state=state, audio_state=audio_state,
                                    processing_state="busy" if state == CallStatus.processing.value else "idle")

    # ------------------------------------------------------------------ audio in
    @property
    def ai_busy(self) -> bool:
        turn_running = self._turn_task is not None and not self._turn_task.done()
        return turn_running or time.monotonic() < self._playback_until

    async def on_media(self, mulaw: bytes) -> None:
        if self._closed:
            return
        pcm = audio.mulaw_to_pcm16(mulaw)
        for ev in self.endpointer.process(pcm):
            if ev.event == audio.VadEvent.SPEECH_START:
                self._customer_spoke = True
                self._last_activity = time.monotonic()
                self._silence_prompts = 0
                if self._hangup_task is None:
                    self.end_call_requested = False  # customer is talking again; keep the call open
                if self._greeting_task and not self._greeting_task.done():
                    self._greeting_task.cancel()
                if self.ai_busy:
                    # Don't cut the agent off yet: echo, line noise or "hmm" also look like speech.
                    self._barge_candidate, self._barge_loud_ms = True, 0
                log.debug("Customer speech started")
            elif ev.event == audio.VadEvent.SPEECH_END:
                candidate, self._barge_candidate = self._barge_candidate, False
                if not ev.audio:
                    continue
                log.info("Customer audio received (%dms)", ev.duration_ms)
                if candidate or self.ai_busy:
                    self._check_barge_in(ev.audio)  # interrupt only if STT hears real words
                else:
                    self._start_turn(audio_pcm=ev.audio)
        if self._barge_candidate and self.endpointer.in_speech:
            await self._confirm_loud_barge_in(pcm)

    async def _confirm_loud_barge_in(self, pcm: bytes) -> None:
        """Sustained loud speech after the echo window is a real interruption: stop at once."""
        if audio.rms(pcm) >= self.cfg.BARGE_IN_MIN_RMS:
            self._barge_loud_ms += len(pcm) * 1000 // (audio.TELEPHONY_SAMPLE_RATE * audio.SAMPLE_WIDTH)
        playing_ms = (time.monotonic() - self._playback_started) * 1000 if self._playback_started else 0
        in_grace = time.monotonic() < self._playback_until and playing_ms < self.cfg.BARGE_IN_GRACE_MS
        if self._barge_loud_ms >= self.cfg.BARGE_IN_MIN_SPEECH_MS and not in_grace:
            self._barge_candidate = False
            await self.barge_in()

    def _check_barge_in(self, audio_pcm: bytes) -> None:
        if self._barge_check_task and not self._barge_check_task.done():
            self._barge_check_task.cancel()
        self._barge_check_task = asyncio.create_task(self._run_barge_check(audio_pcm, time.monotonic()))

    async def _run_barge_check(self, audio_pcm: bytes, t1: float) -> None:
        with call_context(self.call_id):
            try:
                result = await self.providers.stt.transcribe(audio.telephony_pcm_to_stt_wav(audio_pcm))
            except STTError as exc:
                log.warning("STT failed on possible interruption (%s) - agent keeps talking", exc.kind)
                return
            if not result["text"]:
                log.info("Noise while agent was talking - ignored, agent keeps talking")
                self._event("barge_in_ignored", {"turn": self.turn_index})
                return
            if self.ai_busy and is_filler(result["text"]):
                log.info("Customer said %r while agent busy - not an interruption, agent continues", result["text"])
                self._event("barge_in_ignored", {"turn": self.turn_index, "text": result["text"][:60]})
                return
            if self.ai_busy:
                await self.barge_in()
            self._start_turn(transcript=(result["text"], result.get("confidence"), t1))

    async def barge_in(self) -> None:
        log.info("Barge-in: customer interrupted, stopping playback")
        task = self._turn_task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        if self._audio_since_clear:
            await self.sender.clear()
            self._audio_since_clear = False
        self._playback_until = 0.0
        self._checkpoint = None
        self._playback_done.set()
        self._event("barge_in", {"turn": self.turn_index})
        await self._set_state(CallStatus.listening.value)

    # ------------------------------------------------------------------ playback callbacks
    async def on_played(self, name: str) -> None:
        if name and name == self._checkpoint:
            self._checkpoint = None
            self._playback_until = 0.0
            self._audio_since_clear = False
            self._playback_done.set()
            self._last_activity = time.monotonic()
            if not (self._turn_task and not self._turn_task.done()):
                await self._set_state(CallStatus.listening.value)

    async def on_cleared(self) -> None:
        self._playback_until = 0.0
        self._playback_done.set()

    # ------------------------------------------------------------------ turns
    def greeting_text(self) -> str:
        return render_first_message(self.ctx.first_message or "", self.ctx.variables)

    def identity_reask_text(self) -> Optional[str]:
        name = safe_variables(self.ctx.variables)["customer_name"]
        return IDENTITY_REASK.format(name=name) if name else None

    def _should_reask_identity(self, text: str) -> bool:
        """Only once, only for an opening line that asks for the customer by name
        ("Hi, is this {{customer_name}}?"), and only when the reply right after it
        is nothing but a greeting."""
        first = (self.ctx.first_message or "").strip()
        if self._identity_reasked or "customer_name" not in first or not first.endswith("?"):
            return False
        last = self.history[-1] if self.history else None
        just_greeted = bool(last and last["role"] == "assistant" and last["content"].startswith(self.greeting_text()))
        return just_greeted and is_greeting_only(text) and self.identity_reask_text() is not None

    async def _greet_if_silent(self) -> None:
        delay_ms = self.cfg.GREETING_DELAY_MS
        if has_greeting_audio(self.call_id):  # ready to play instantly - don't leave dead air
            delay_ms = min(delay_ms, self.cfg.GREETING_PRERENDERED_DELAY_MS)
        await asyncio.sleep(delay_ms / 1000)
        if not self._customer_spoke and not self.ai_busy and not self.endpointer.in_speech:
            log.info("Customer silent after answer - agent greets first")
            if self.ctx.first_message:
                self._start_turn(scripted=self.greeting_text())
            else:
                self._start_turn(injected=GREETING_INSTRUCTION)

    async def _watch_silence(self) -> None:
        """After the agent has spoken, wait SILENCE_REPROMPT_SECONDS for the customer;
        re-prompt once, then close politely and hang up."""
        with call_context(self.call_id):
            while not self._closed:
                await asyncio.sleep(0.25)
                if (not self._agent_spoke or self.ai_busy or self.endpointer.in_speech
                        or self.end_call_requested or self._closed):
                    continue
                idle = time.monotonic() - max(self._last_activity, self._playback_until)
                if idle < self.cfg.SILENCE_REPROMPT_SECONDS:
                    continue
                if self._silence_prompts == 0:
                    self._silence_prompts = 1
                    log.info("Customer silent for %.0fs - re-prompting", idle)
                    self._event("silence_reprompt")
                    self._start_turn(scripted=self.ctx.silence_reprompt or silence_reprompt(self.cfg.CALL_LANGUAGE))
                else:
                    log.info("Still no response - closing the call politely")
                    self._event("silence_close")
                    self.end_call_requested = True
                    self._start_turn(scripted=self.ctx.silence_closing or silence_closing(self.cfg.CALL_LANGUAGE))
                self._last_activity = time.monotonic()

    def _start_turn(self, audio_pcm: Optional[bytes] = None, injected: Optional[str] = None,
                    scripted: Optional[str] = None, transcript: Optional[tuple] = None) -> None:
        """transcript = (text, confidence, t1) when STT already ran (confirmed barge-in)."""
        if self._turn_task and not self._turn_task.done():
            self._turn_task.cancel()
        self.turn_index += 1
        self._last_activity = time.monotonic()
        t1 = transcript[2] if transcript else time.monotonic()
        self._turn_task = asyncio.create_task(
            self._run_turn(self.turn_index, audio_pcm, injected, t1, scripted, transcript)
        )

    async def _run_turn(self, turn: int, audio_pcm: Optional[bytes], injected: Optional[str], t1: float,
                        scripted: Optional[str] = None, transcript: Optional[tuple] = None) -> None:
        with call_context(self.call_id):
            m = TurnMetrics(t1=t1)
            await self._set_state(CallStatus.processing.value)
            stream = None
            st = _TurnState(user_text=injected, record_user=False, scripted=scripted)
            if scripted is not None and not self._greeted and scripted == self.greeting_text():
                st.is_greeting = True
            # Open the TTS stream early to hide the handshake behind STT - unless the
            # pre-rendered greeting is about to play and no TTS is needed at all.
            tts_connect: Optional[asyncio.Task] = None
            if not (st.is_greeting and has_greeting_audio(self.call_id)):
                tts_connect = asyncio.create_task(self.tts.open_stream())
            try:
                # ---------------- STT ----------------
                if transcript is not None:
                    result = {"text": transcript[0], "confidence": transcript[1]}
                    m.t2 = time.monotonic()
                elif audio_pcm is not None:
                    result = await self.providers.stt.transcribe(audio.telephony_pcm_to_stt_wav(audio_pcm))
                    m.t2 = time.monotonic()
                    log.info("STT completed: %dms", _ms(m.t1, m.t2))
                if transcript is not None or audio_pcm is not None:
                    text = result["text"]
                    if not text:
                        log.info("STT returned no speech - ignoring")
                        return
                    log.info("Customer said: %s", text[:200])
                    self._persist(lambda db, t=text, c=result.get("confidence"): repo.add_transcript(db, self.call_id, "customer", t, confidence=c))
                    st.user_text = f"{self._pending_user_text} {text}".strip()
                    st.record_user = True
                    self._pending_user_text = st.user_text  # cleared once a reply is delivered
                    if not self._greeted:
                        # Customer spoke first ("Hello?"): answer with the fixed greeting.
                        st.scripted, st.is_greeting = self.greeting_text(), True
                    elif self._should_reask_identity(text):
                        st.scripted = self.identity_reask_text()
                        self._identity_reasked = True

                # ---------------- LLM -> TTS (streamed) ----------------
                cached = take_greeting_audio(self.call_id, st.scripted) if st.is_greeting and st.scripted else None
                if cached:
                    log.info("Playing pre-rendered greeting")
                    m.t5 = m.t6 = time.monotonic()
                    st.spoken.append(clean_spoken_text(st.scripted))
                    await self._play(cached, st)
                else:
                    if tts_connect is None:
                        tts_connect = asyncio.create_task(self.tts.open_stream())
                    stream = await tts_connect
                    await self._speak_streaming(st, m, stream)
                if st.scripted is None:
                    m.t4 = m.t4 or time.monotonic()
                    log.info("LLM completed: %dms", _ms(m.t3, m.t4) or 0)
                self._commit_turn(st, interrupted=False)
                if m.t6:
                    log.info("Total response latency: %dms", _ms(m.t1, m.t6))
                self._persist(lambda db, row=m.as_row(): repo.add_latency_metric(db, self.call_id, turn, **row))
                await self._after_reply()
            except asyncio.CancelledError:
                if stream is not None:
                    await stream.cancel()
                if st.audio_started:
                    self._commit_turn(st, interrupted=True)
                raise
            except (STTError, LLMError, TTSError) as exc:
                stage = "stt" if isinstance(exc, STTError) else "llm" if isinstance(exc, LLMError) else "tts"
                log.error("%s failed (%s): %s", stage.upper(), exc.kind, exc)
                self._event("pipeline_error", {"stage": stage, "kind": exc.kind, "turn": turn})
                if stage == "tts" and not st.audio_started and not self._closed:
                    await self._recover_tts_failure(st, m, turn)
                elif stage != "tts" and not st.audio_started:
                    await self._speak_fallback()
            except Exception as exc:  # never kill the call on an unexpected bug
                log.exception("Unexpected pipeline error: %s", type(exc).__name__)
                self._event("pipeline_error", {"stage": "unknown", "kind": type(exc).__name__, "turn": turn})
            finally:
                if stream is None and tts_connect is not None:
                    tts_connect.cancel()
                    try:
                        s = await tts_connect
                        await s.aclose()
                    except BaseException:
                        pass
                elif stream is not None:
                    await stream.aclose()
                if not self.ai_busy_after_turn():
                    await self._set_state(CallStatus.listening.value)

    def ai_busy_after_turn(self) -> bool:
        return time.monotonic() < self._playback_until

    async def _speak_streaming(self, st: _TurnState, m: TurnMetrics, stream) -> None:
        async def produce() -> None:
            chunker = SentenceChunker()
            m.t3 = time.monotonic()

            async def push(sentence: str) -> None:
                sentence, end = extract_end_call(sentence)
                if end:
                    self.end_call_requested = True
                sentence = clean_spoken_text(sentence)
                if not sentence:
                    return
                if m.t5 is None:
                    m.t5 = time.monotonic()
                st.spoken.append(sentence)
                await stream.send_text(sentence)

            if st.scripted is not None:
                m.t3 = None  # fixed text, no LLM involved
                for sentence in chunker.feed(st.scripted + " ") + chunker.flush():
                    await push(sentence)
            else:
                async for delta in self.providers.llm.stream_response(
                    self.ctx.agent_prompt, self.history, st.user_text, self.ctx.variables
                ):
                    if m.t3_first_token is None:
                        m.t3_first_token = time.monotonic()
                    for sentence in chunker.feed(delta):
                        await push(sentence)
                for sentence in chunker.flush():
                    await push(sentence)
                m.t4 = time.monotonic()
            if not st.spoken:
                log.warning("LLM returned no speakable text - using fallback")
                await push(fallback_reply(self.cfg.CALL_LANGUAGE))
            await stream.end_input()

        async def consume() -> None:
            async for chunk in stream.audio():
                if m.t6 is None:
                    m.t6 = time.monotonic()
                    log.info("TTS first audio: %dms", _ms(m.t5, m.t6) or 0)
                await self._play(chunk, st)

        producer, consumer = asyncio.create_task(produce()), asyncio.create_task(consume())
        try:
            done, _ = await asyncio.wait({producer, consumer}, return_when=asyncio.FIRST_EXCEPTION)
            for t in done:
                if t.exception():
                    raise t.exception()  # type: ignore[misc]
            await asyncio.gather(producer, consumer)
        finally:
            for t in (producer, consumer):
                if not t.done():
                    t.cancel()
                    try:
                        await t
                    except BaseException:
                        pass

    async def _play(self, mulaw: bytes, st: Optional[_TurnState] = None) -> None:
        self._agent_spoke = True
        if st is not None and not st.audio_started:
            st.audio_started = True
            self._playback_started = time.monotonic()
            if st.is_greeting:
                self._greeted = True
            await self._set_state(CallStatus.speaking.value)
        for piece in audio.chunk_bytes(mulaw, self.SEND_CHUNK_BYTES):
            await self.sender.send_audio(piece)
            self._audio_since_clear = True
            self._playback_done.clear()
            now = time.monotonic()
            self._playback_until = max(self._playback_until, now) + audio.mulaw_duration_seconds(len(piece))

    def _commit_turn(self, st: _TurnState, interrupted: bool) -> None:
        reply = " ".join(st.spoken).strip()
        if st.record_user and st.user_text:
            self.history.append({"role": "user", "content": st.user_text})
            self._pending_user_text = ""
            self._bg(self.store.append_history(self.call_id, "user", st.user_text))
        if reply:
            content = reply + (" ..." if interrupted else "")
            self.history.append({"role": "assistant", "content": content})
            self._bg(self.store.append_history(self.call_id, "assistant", content))
            self._persist(lambda db: repo.add_transcript(db, self.call_id, "agent", reply, interrupted=interrupted))
            log.info("Agent said%s: %s", " (interrupted)" if interrupted else "", reply[:200])

    def _bg(self, coro: Awaitable[None]) -> None:
        asyncio.ensure_future(coro)

    async def _after_reply(self) -> None:
        if not self._audio_since_clear:
            return
        self._checkpoint = f"turn-{self.turn_index}"
        await self.sender.checkpoint(self._checkpoint)
        if self.end_call_requested and not self._hangup_task:
            self._hangup_task = asyncio.create_task(self._hangup_after_playback())

    async def _recover_tts_failure(self, st: _TurnState, m: TurnMetrics, turn: int) -> None:
        """The live TTS stream failed before any audio played (e.g. Cartesia timed out).
        Say the same reply through one-shot synthesis instead of leaving the customer in
        silence; if the reply was cut off mid-generation, generate it again first."""
        try:
            if st.scripted is not None:
                text = clean_spoken_text(st.scripted)
            elif m.t4 is not None and st.spoken:  # LLM had finished - reuse its full reply
                text = " ".join(st.spoken)
            else:
                raw = await asyncio.wait_for(
                    self.providers.llm.generate_response(self.ctx.agent_prompt, self.history, st.user_text, self.ctx.variables),
                    timeout=10,
                )
                raw, end = extract_end_call(raw)
                if end:
                    self.end_call_requested = True
                text = clean_spoken_text(raw)
            if not text:
                raise ValueError("no reply text")
            mulaw = await asyncio.wait_for(self.tts.synthesize(text), timeout=10)
            st.spoken = [text]
            await self._play(mulaw, st)
            self._commit_turn(st, interrupted=False)
            self._event("tts_recovered", {"turn": turn})
            log.info("Recovered from TTS failure with one-shot synthesis")
            await self._after_reply()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("TTS recovery failed (%s) - using fallback line", type(exc).__name__)
            await self._speak_fallback()

    async def _speak_fallback(self) -> None:
        try:
            pcm = await self.tts.synthesize(fallback_reply(self.cfg.CALL_LANGUAGE))
            await self._play(pcm)
            await self._after_reply()
        except Exception as exc:
            log.error("Fallback speech failed: %s", type(exc).__name__)

    async def _hangup_after_playback(self) -> None:
        with call_context(self.call_id):
            remaining = max(0.0, self._playback_until - time.monotonic())
            try:
                await asyncio.wait_for(self._playback_done.wait(), timeout=remaining + 3.0)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(0.4)  # let the last syllable reach the handset
            log.info("Agent ended the conversation - hanging up")
            self._event("agent_hangup")
            if self.ctx.provider_call_id:
                await self.providers.telephony(self.ctx.telephony_provider).hangup(self.ctx.provider_call_id)


# ===========================================================================
# Finalisation
# ===========================================================================
async def finalize_conversation(call_id: str, llm: LLMProvider, reason: str) -> None:
    """Classify the outcome and close out the call record. Idempotent."""
    with call_context(call_id):
        async with session_factory()() as db:
            call = await repo.get_call(db, call_id)
            if call is None:
                return
            transcripts = await repo.list_transcripts(db, call_id)
            outcome, summary, reached = None, None, None
            if any(t.speaker == "customer" for t in transcripts):
                text = "\n".join(f"{'Customer' if t.speaker == 'customer' else 'Agent'}: {t.text}" for t in transcripts)
                try:
                    raw = await asyncio.wait_for(llm.complete_raw(OUTCOME_SYSTEM, text[:12000]), timeout=15)
                    outcome, summary = parse_outcome(raw)
                    reached = parse_reached(raw)
                except Exception as exc:
                    log.warning("Outcome classification failed: %s", type(exc).__name__)
                    outcome = CallOutcome.unknown.value
            await db.refresh(call)  # pick up outcomes set meanwhile (e.g. voicemail webhook)
            fields: Dict[str, Any] = {}
            if call.outcome in LOCKED_OUTCOMES:
                outcome = call.outcome  # hard signal wins over the transcript classifier
            elif outcome and (call.outcome in (None, "completed", "unknown") or outcome != "unknown"):
                fields["outcome"] = outcome
            elif not outcome and not call.outcome and call.answered_at is not None:
                fields["outcome"] = CallOutcome.completed.value  # answered, customer never spoke
            if summary:
                fields["summary"] = summary
            if fields:
                await repo.update_call(db, call, **fields)
            if outcome == CallOutcome.do_not_call.value:
                await repo.set_contact_dnd(db, call.contact_id, True)
                log.info("Contact marked Do-Not-Call")
            elif outcome == CallOutcome.callback_requested.value:
                await repo.add_followup(db, call.contact_id, call.id, f"Callback requested. {summary or ''}".strip())
            elif outcome == CallOutcome.interested.value and default_settings.TEAM_FOLLOWUP_ENABLED:
                await repo.add_followup(db, call.contact_id, call.id, f"Interested lead. {summary or ''}".strip())
            await repo.add_event(db, call_id, "conversation_finalized", {"reason": reason, "outcome": outcome, "reached": reached})
            # If Plivo's hangup webhook hasn't arrived yet, mark the call completed now;
            # the webhook will still fill in duration / hangup cause.
            if call.answered_at is not None and CallStatus(call.status) not in FINAL_CALL_STATUSES:
                await transition(db, call, CallStatus.completed, {"reason": reason},
                                 ended_at=call.ended_at or utcnow(), outcome=call.outcome or CallOutcome.completed.value)
            log.info("Call finalized (outcome=%s)", call.outcome)
            status_callback.notify(call, "finalized", transcripts)


async def load_call_context(call_id: str) -> Optional[CallContextData]:
    async with session_factory()() as db:
        call = await repo.get_call(db, call_id)
        if call is None:
            return None
        variables = dict(call.variables or {})
        flow_lines = {key: render_first_message(variables[f"flow_silence_{key}"], variables) or None
                      for key in ("reprompt", "closing") if variables.get(f"flow_silence_{key}")}
        return CallContextData(
            call_id=call.id,
            agent_prompt=call.agent.system_prompt,
            first_message=call.agent.first_message,
            variables=variables,
            voice_id=call.voice_id or call.agent.voice_id,
            provider_call_id=call.provider_call_id,
            contact_id=call.contact_id,
            telephony_provider=call.telephony_provider or "plivo",
            silence_reprompt=flow_lines.get("reprompt"),
            silence_closing=flow_lines.get("closing"),
        )
