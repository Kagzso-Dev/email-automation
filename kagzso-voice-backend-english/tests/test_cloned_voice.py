"""Cloned voices (SARVAM_TTS_VOICE_EN_FEMALE, SARVAM_TTS_VOICE_TA_FEMALE / _MALE_1 / _MALE_2): read by the backend's
language with the gender of their slot, offered first (plus "cloned_male": either male voice, picked once per call),
spoken through Sarvam's /voices/clone API (REST + WebSocket) with the pace but no model / speaker / temperature, and
backed per call by a stock voice of the same gender when Sarvam returns an error. No real request is made."""
import base64
import io
import json
import logging
import re
import wave

import httpx
import pytest
from sqlalchemy import text

from app.core import voices
from app.core.config import cloned_voice_id, settings
from app.services import audio_service as audio
from app.services import call_service as cs
from app.services import provider_registry
from app.services.sarvam_tts import CLONE_MAX_CHARS, SarvamTTS, _split_text
from app.services.tts import TTSError
from tests.test_agent_voice import REPLIES, RecordingSarvamTTS, recorder  # noqa: F401  (pytest fixture)
from tests.test_autonomous_conversation import _converse, _flow
from tests.test_nila_flow import _call

# made-up ids: the real ones live only in the .env files
EN_F = "svc-00000000-0000-4000-8000-0000000000e1"
TA_F = "svc-00000000-0000-4000-8000-0000000000a1"
TA_M1 = "svc-00000000-0000-4000-8000-0000000000b1"
TA_M2 = "svc-00000000-0000-4000-8000-0000000000b2"


def _cfg(language="ta", **extra):
    return settings.model_copy(update={
        "CALL_LANGUAGE": language, "SARVAM_TTS_SPEAKER": "roopa",
        "SARVAM_TTS_VOICE_EN_FEMALE": EN_F, "SARVAM_TTS_VOICE_TA_FEMALE": TA_F,
        "SARVAM_TTS_VOICE_TA_MALE_1": TA_M1, "SARVAM_TTS_VOICE_TA_MALE_2": TA_M2, **extra})


def _wav(pcm: bytes, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _form(request: httpx.Request) -> dict:
    """The plain fields of a multipart/form-data request."""
    assert request.headers["content-type"].startswith("multipart/form-data")
    return dict(re.findall(r'name="([^"]+)"\r\n\r\n(.*?)\r\n--', request.content.decode(), re.S))


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler))


def _ok_wav(_request=None):
    return httpx.Response(200, json={"audio_b64": base64.b64encode(_wav(b"\x00\x00" * 80)).decode(), "request_id": "r"})


# ------------------------------------------------------------------ config + offered voices
def test_cloned_voice_id():
    assert cloned_voice_id(" SVC-ABC-1 ") == "svc-abc-1"
    for not_a_clone in ("", "ishita", "svc-", "svc-has space", f"{TA_F}:female", "svc-" + "a" * 61):
        assert cloned_voice_id(not_a_clone) is None


def test_each_backend_reads_its_own_language_with_the_slot_gender():
    assert _cfg("ta").cloned_voices == [("female", TA_F, "female"), ("male_1", TA_M1, "male"), ("male_2", TA_M2, "male")]
    assert _cfg("en").cloned_voices == [("female", EN_F, "female")]
    assert _cfg("hi").cloned_voices == []  # other languages ignore them: their voices don't change
    # default voice: the female clone (Tamil and English); none set = SARVAM_TTS_SPEAKER, as before
    assert _cfg("ta").tts_speaker == TA_F and _cfg("en").tts_speaker == EN_F
    assert _cfg("hi").tts_speaker == "roopa"
    assert _cfg("ta", SARVAM_TTS_VOICE_TA_FEMALE="").tts_speaker == TA_M1  # no female clone: the first one
    assert _cfg("ta").cloned_voice_gender(TA_M2) == "male" and _cfg("ta").cloned_voice_gender("ishita") == ""


def test_fallback_voice_by_gender():
    cfg = _cfg("ta")
    assert cfg.fallback_speaker("female") == "ishita" and cfg.fallback_speaker("male") == "ratan"
    assert cfg.fallback_speaker("") == "roopa"  # unknown gender: SARVAM_TTS_SPEAKER's stock voice
    assert _cfg("ta", SARVAM_TTS_FALLBACK_VOICE_MALE="").fallback_speaker("male") == "roopa"
    assert _cfg("ta", SARVAM_TTS_FALLBACK_VOICE_MALE=TA_M1).fallback_speaker("male") == "roopa"  # never a clone


def test_cloned_voice_entries(caplog):
    label = "Tamil (India)"
    named = _cfg("ta", SARVAM_TTS_VOICE_TA_FEMALE_NAME="Kgazso Tamil", SARVAM_TTS_VOICE_TA_MALE_1_NAME=" Kgazso  Male 1 ",
                 SARVAM_TTS_VOICE_TA_MALE_2_NAME="Kgazso Male 2")
    assert voices.cloned_voice_entries(named) == [
        {"id": TA_F, "name": "Kgazso Tamil", "gender": "female", "language": label, "cloned": True},
        {"id": TA_M1, "name": "Kgazso Male 1", "gender": "male", "language": label, "cloned": True},
        {"id": TA_M2, "name": "Kgazso Male 2", "gender": "male", "language": label, "cloned": True},
    ]  # 1 female + 2 male: Tamil's 4 stock female voices become 5, its 6 stock male voices 8
    unnamed = voices.cloned_voice_entries(_cfg("ta"))
    assert [v["name"] for v in unnamed] == ["Cloned female", "Cloned male 1", "Cloned male 2"]
    long = voices.cloned_voice_entries(_cfg("en", SARVAM_TTS_VOICE_EN_FEMALE_NAME="K" * 60))
    assert long[0]["name"] == "K" * 40  # ai_agents.voiceDisplayName holds 40
    # SARVAM_TTS_VOICE_TA_MALE_EITHER: "Either male (per call)" first among the male ones (one of them per call)
    either = voices.cloned_voice_entries(_cfg("ta", SARVAM_TTS_VOICE_TA_MALE_EITHER=True))
    assert [v["id"] for v in either] == [TA_F, "cloned_male", TA_M1, TA_M2]
    assert either[1] == {"id": "cloned_male", "name": "Either male (per call)", "gender": "male", "language": label,
                         "cloned": True, "pool": [TA_M1, TA_M2]}
    one_male = voices.cloned_voice_entries(_cfg("ta", SARVAM_TTS_VOICE_TA_MALE_2="", SARVAM_TTS_VOICE_TA_MALE_EITHER=True))
    assert [v["id"] for v in one_male] == [TA_F, TA_M1]  # a single voice of a gender: no "either"
    assert [v["id"] for v in voices.cloned_voice_entries(_cfg("en"))] == [EN_F]
    with caplog.at_level(logging.WARNING, logger="voices"):
        assert [v["id"] for v in voices.cloned_voice_entries(_cfg("ta", SARVAM_TTS_VOICE_TA_MALE_1="ishita"))] == [TA_F, TA_M2]
    assert "SARVAM_TTS_VOICE_TA_MALE_1 is not a Sarvam cloned voice id" in caplog.text
    assert all(len(str(v["name"])) <= 40 for v in voices.cloned_voice_entries(_cfg("ta")))  # ai_agents.voiceDisplayName


def test_resolve_voice(monkeypatch):
    monkeypatch.setattr(voices, "VOICE_POOLS", {"cloned_male": (TA_M1, TA_M2)})
    assert voices.resolve_voice("cloned_male", choose=lambda pool: pool[1]) == TA_M2
    assert {voices.resolve_voice("cloned_male") for _ in range(60)} == {TA_M1, TA_M2}
    assert voices.resolve_voice(TA_F) == TA_F and voices.resolve_voice(None) is None and voices.resolve_voice("ritu") == "ritu"
    # outside a call (a Listen preview) a pool speaks as its first voice, never a random one per request
    monkeypatch.setattr(voices, "VOICE_IDS", voices.VOICE_IDS + ("cloned_male",))
    assert SarvamTTS(settings, voice_id="cloned_male").voice_id == TA_M1


# ------------------------------------------------------------------ REST
async def test_cloned_rest_request():
    seen = []
    pcm = b"\x10\x20" * 800

    def handler(request):
        seen.append((request.url.path, request.headers.get("api-subscription-key"), _form(request)))
        return httpx.Response(200, json={"audio_b64": base64.b64encode(_wav(pcm)).decode(), "request_id": "r1",
                                         "audio_duration": 0.1})

    tts = SarvamTTS(_cfg("ta"), voice_id=TA_M2, client=_client(handler), exact_voice=True)
    out = await tts.synthesize("Kagzso", pace=0.9)
    await tts.aclose()

    path, key, form = seen[0]
    assert path == "/voices/clone" and key == "sarvam-test-key"
    assert form == {"voice_id": TA_M2, "text": "கெக்ஸோ", "language_code": "ta-IN", "pace": "0.9",
                    "speech_sample_rate": "8000", "output_audio_codec": "wav"}  # no model, speaker or temperature
    assert out == audio.pcm16_to_mulaw(pcm)


async def test_agent_profile_pace_applies_to_a_cloned_voice_but_temperature_cannot():
    forms = []

    def handler(request):
        forms.append(_form(request))
        return _ok_wav()

    tts = provider_registry.with_agent_voice(SarvamTTS(_cfg("en"), client=_client(handler)), None)
    assert tts.cfg.SARVAM_TTS_TEMPERATURE == settings.AGENT_TTS_TEMPERATURE  # set, but the clone API has no field
    await tts.synthesize("Hello sir.")
    assert forms[0]["pace"] == str(settings.AGENT_TTS_PACE) and forms[0]["language_code"] == "en-IN"
    assert "temperature" not in forms[0] and forms[0]["voice_id"] == EN_F


async def test_cloned_text_over_1000_chars_is_sent_in_parts():
    texts = []

    def handler(request):
        texts.append(_form(request)["text"])
        return _ok_wav()

    line = " ".join(f"This is sentence number {i}." for i in range(120))  # ~3,300 characters
    await SarvamTTS(_cfg("en"), client=_client(handler)).synthesize(line)
    assert len(texts) >= 4 and all(len(t) <= CLONE_MAX_CHARS for t in texts)
    assert " ".join(texts) == line and all(t.endswith(".") for t in texts)  # cut after a sentence, nothing lost
    assert _split_text("a" * 1500) == ["a" * 1000, "a" * 500]  # no space at all: a hard cut


async def test_cloned_rest_errors_map_like_stock():
    tts = SarvamTTS(_cfg("ta"), client=_client(lambda r: httpx.Response(404, json={"error": {"message": "no voice"}})))
    with pytest.raises(TTSError) as ei:
        await tts.synthesize("வணக்கம்")
    assert ei.value.kind == "invalid_request" and ei.value.status_code == 404


async def test_cloned_preview_is_a_browser_wav():
    def handler(request):
        assert _form(request)["speech_sample_rate"] == "22050"
        return httpx.Response(200, json={"audio_b64": base64.b64encode(_wav(b"\x01\x00" * 100, 22050)).decode(),
                                         "request_id": "r"})

    out = await SarvamTTS(_cfg("ta"), client=_client(handler)).synthesize_preview("வணக்கம்")
    with wave.open(io.BytesIO(out)) as w:
        assert w.getframerate() == 22050 and w.getnframes() == 100


# ------------------------------------------------------------------ WebSocket
async def test_cloned_websocket_stream(monkeypatch):
    from websockets.asyncio.server import serve

    received, headers = [], {}
    pcm = b"\x10\x20" * 200

    async def handler(ws):
        headers["path"] = ws.request.path
        headers["key"] = ws.request.headers.get("Api-Subscription-Key")
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if msg["type"] == "text":
                await ws.send(json.dumps({"type": "audio", "data": {"audio": base64.b64encode(pcm).decode()}}))
            if msg["type"] == "flush":
                await ws.send(json.dumps({"type": "event", "data": {"event_type": "final"}}))

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(settings, "SARVAM_TTS_CLONE_WS_URL", f"ws://127.0.0.1:{port}/voices/clone/ws")
        stream = await SarvamTTS(_cfg("ta")).open_stream(pace=0.9)
        await stream.send_text("எங்க shop-ல billing software already இருக்கு")
        await stream.end_input()
        chunks = [c async for c in stream.audio()]
        await stream.aclose()

    assert b"".join(chunks) == audio.pcm16_to_mulaw(pcm)
    assert headers["key"] == "sarvam-test-key"
    assert headers["path"].startswith("/voices/clone/ws?") and "send_completion_event=true" in headers["path"]
    assert "model=" not in headers["path"]
    assert received[0] == {"type": "config", "data": {
        "voice_id": TA_F, "pace": 0.9, "target_language_code": "ta-IN", "speech_sample_rate": "8000",
        "output_audio_codec": "linear16", "min_buffer_size": 30}}
    assert received[1]["data"]["text"] == "எங்க shop-ல billing software already இருக்கு "


async def test_cloned_stream_closed_before_audio_is_an_error(monkeypatch):
    """Sarvam closing the clone socket without audio must not pass as a silent, finished reply."""
    from websockets.asyncio.server import serve

    async def handler(ws):
        await ws.recv()  # the config
        await ws.close()

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(settings, "SARVAM_TTS_CLONE_WS_URL", f"ws://127.0.0.1:{port}/voices/clone/ws")
        monkeypatch.setattr(settings, "SARVAM_TTS_WS_URL", f"ws://127.0.0.1:{port}/text-to-speech/ws")
        stream = await SarvamTTS(_cfg("ta")).open_stream()
        with pytest.raises(TTSError, match="closed before any audio"):
            [c async for c in stream.audio()]
        await stream.aclose()
        stock = await SarvamTTS(settings, voice_id="ritu").open_stream()  # stock voices: unchanged
        assert [c async for c in stock.audio()] == []
        await stock.aclose()


# ------------------------------------------------------------------ fallback to a stock voice of the same gender
@pytest.mark.parametrize("voice,stock", [(TA_F, "ishita"), (TA_M1, "ratan"), (TA_M2, "ratan")])
async def test_cloned_voice_falls_back_to_stock_of_its_gender_for_the_rest_of_the_call(caplog, voice, stock):
    calls = []
    pcm = b"\x10\x20" * 400

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/voices/clone":
            return httpx.Response(402, json={"error": {"message": "Quota exceeded", "code": "insufficient_quota_error"}})
        assert json.loads(request.content)["speaker"] == stock
        return httpx.Response(200, json={"request_id": "r", "audios": [base64.b64encode(_wav(pcm)).decode()]})

    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=voice, client=_client(handler),
                                                          exact_voice=True))
    assert isinstance(tts, provider_registry.ClonedVoiceFallback)
    with caplog.at_level(logging.WARNING):
        first = await tts.synthesize("வணக்கம்")
        second = await tts.synthesize("சரி சார்")
    assert first == second == audio.pcm16_to_mulaw(pcm)
    assert calls == ["/voices/clone", "/text-to-speech", "/text-to-speech"]  # sticky: the clone is tried once
    assert "CLONED VOICE FALLBACK" in caplog.text and voice in caplog.text and f"stock voice {stock}" in caplog.text


async def test_failed_stream_open_falls_back(monkeypatch):
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("en")))

    async def refuse(pace=None):
        raise TTSError("auth", "Sarvam TTS authentication failed (403)", 403)

    async def stock_stream(pace=None):
        return "stock-stream"

    monkeypatch.setattr(tts.primary, "open_stream", refuse)
    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    assert await tts.open_stream() == "stock-stream"
    assert await tts.open_stream() == "stock-stream"  # stays on it


def test_with_clone_fallback_only_wraps_cloned_voices():
    stock = SarvamTTS(settings, voice_id="ritu")
    assert provider_registry.with_clone_fallback(stock) is stock
    wrapped = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=TA_M1, exact_voice=True))
    assert provider_registry.with_clone_fallback(wrapped) is wrapped  # never wrapped twice
    assert wrapped.fallback.voice_id == "ratan" and not wrapped.fallback.cloned
    # the agent voice profile keeps the fallback and reaches both voices
    agent = provider_registry.with_agent_voice(wrapped, 0.8)
    assert isinstance(agent, provider_registry.ClonedVoiceFallback)
    assert agent.primary._voice_settings()["pace"] == agent.fallback._voice_settings()["pace"] == 0.8
    assert agent.fallback.voice_id == "ratan"
    view = provider_registry._tts_view(agent)
    assert view["primary"]["model"] == "voice-clone" and "temperature" not in view["primary"]
    assert view["fallback"]["voice"] == "ratan"


# ------------------------------------------------------------------ mocked calls: one voice per call
@pytest.fixture
def tamil_clones(monkeypatch, recorder):  # noqa: F811
    """This backend offers the Tamil clones (and Roopa / Shubh); a recording SarvamTTS stands in for the network."""
    monkeypatch.setattr(voices, "VOICE_IDS", (TA_F, "cloned_male", TA_M1, TA_M2, "roopa", "shubh"))
    monkeypatch.setattr(voices, "VOICE_POOLS", {"cloned_male": (TA_M1, TA_M2)})
    monkeypatch.setattr(cs, "SarvamTTS", RecordingSarvamTTS)
    monkeypatch.setattr(settings, "SARVAM_TTS_VOICE_ROTATION", "")
    return recorder


def _voices_used(log):
    return [e[2].get("voice_id") or e[2].get("speaker") for e in log if e[0] in ("rest", "stream")]


def _call_voice(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select voice_id from calls where id = :id"), {"id": call_id}).scalar()


def _talk(client, fakes, flow, flow_id, auth):
    queue = list(REPLIES)
    original = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if not system_text.startswith(cs.OUTCOME_SYSTEM) and queue:
            fakes.llm.reply = queue.pop(0)
        async for d in original(system_text, messages, model):
            yield d

    fakes.llm._stream = stream
    call_id, token = _call(client, auth, gender="male", flow_id=flow_id, flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "Yes", "Tell me more", "Okay"]
    _converse(client, call_id, token, turns=3)
    return call_id


@pytest.mark.parametrize("pick", [0, 1])
def test_a_male_agent_call_picks_one_male_clone_once(client, auth, fakes, monkeypatch, sync_engine, tamil_clones, pick):
    monkeypatch.setattr(voices.random, "choice", lambda pool: pool[pick])
    flow = {**_flow("ta", monkeypatch), "voice_id": "cloned_male"}
    call_id = _talk(client, fakes, flow, f"agent_male_{pick}", auth)
    expected = (TA_M1, TA_M2)[pick]
    used = _voices_used(tamil_clones.log)
    assert len(used) >= 3 and set(used) == {expected}  # greeting, replies, fixed lines: that one voice only
    assert _call_voice(sync_engine, call_id) == expected  # saved on the call when it started


def test_a_female_agent_call_uses_the_female_clone(client, auth, fakes, monkeypatch, sync_engine, tamil_clones):
    flow = {**_flow("ta", monkeypatch), "voice_id": TA_F}
    call_id = _talk(client, fakes, flow, "agent_female", auth)
    assert set(_voices_used(tamil_clones.log)) == {TA_F}
    assert _call_voice(sync_engine, call_id) == TA_F


def test_an_ordinary_flow_with_the_male_pool_keeps_one_voice(client, auth, fakes, monkeypatch, sync_engine, tamil_clones):
    monkeypatch.setattr(voices.random, "choice", lambda pool: pool[1])
    flow = _flow("ta", monkeypatch)
    flow.pop("autonomous")
    flow["voice_id"] = "cloned_male"
    call_id = _talk(client, fakes, flow, "plain_male_pool", auth)
    assert set(_voices_used(tamil_clones.log)) == {TA_M2}
    assert _call_voice(sync_engine, call_id) == TA_M2
