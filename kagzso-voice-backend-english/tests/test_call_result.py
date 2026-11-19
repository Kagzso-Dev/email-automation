"""Every answered call ends with a result. A call where the customer said nothing gets an outcome and a one-line
summary from finalize_conversation (hung_up_early / voice_error / completed), a call that never had a media session is
finalized by settle_unfinalized_call after its hangup, and a cloned voice whose live stream fails before any audio
moves the rest of the call to its stock voice. Nothing is dialled; Dispatch callbacks are captured, never sent."""
import asyncio
import logging
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import call_service as cs
from app.services import provider_registry, status_callback
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError, TTSStream
from tests.test_cloned_voice import TA_M1, _cfg
from tests.test_nila_flow import PHONE, _call, _nila_id


@pytest.fixture
def callbacks(monkeypatch):
    sent = []
    monkeypatch.setattr(settings, "STATUS_CALLBACK_URL", "http://dispatch.test/api/webhooks/ai-calls")
    monkeypatch.setattr(settings, "STATUS_CALLBACK_SECRET", type(settings.STATUS_CALLBACK_SECRET)("cb-secret-0123456789"))
    monkeypatch.setattr(status_callback, "dispatch", sent.append)
    return sent


def _t(speaker):
    return SimpleNamespace(speaker=speaker)


def _e(kind, payload=None):
    return SimpleNamespace(event_type=kind, payload=payload)


# ------------------------------------------------------------------ why a silent call ended
@pytest.mark.parametrize("transcripts, events, reason, outcome, summary", [
    ([], [], cs.NO_MEDIA_SESSION, "voice_error", "the AI's audio never started"),
    ([], [_e("pipeline_error", {"stage": "tts", "kind": "timeout", "turn": 1})], "stream_stopped", "voice_error",
     "text-to-speech error"),
    ([], [], "stream_stopped", "hung_up_early", "hung up before the AI spoke"),
    ([_t("agent")], [], "stream_stopped", "hung_up_early", "hung up without saying anything"),
    # a TTS error the call recovered from (the AI then spoke): not a voice error
    ([_t("agent")], [_e("pipeline_error", {"stage": "tts"}), _e("tts_recovered")], "stream_stopped", "hung_up_early",
     "without saying anything"),
    ([_t("agent"), _t("agent")], [_e("agent_hangup")], "stream_stopped", "completed", "the AI ended the call"),
    # an STT / LLM error with no AI line: the customer still heard no voice failure from TTS - they hung up first
    ([], [_e("pipeline_error", {"stage": "llm", "kind": "timeout"})], "stream_stopped", "hung_up_early", "before the AI spoke"),
])
def test_silent_call_result(transcripts, events, reason, outcome, summary):
    got, text_ = cs.silent_call_result(transcripts, events, reason)
    assert got == outcome and summary in text_
    assert len(got) <= 20  # calls.outcome is VARCHAR(20)


# ------------------------------------------------------------------ finalize: never a blank result
def _answered(client, auth, sync_engine, *lines, events=()):
    """An answered Dispatch call (the answer webhook ran) with these transcript lines and call events."""
    call_id, _ = _call(client, auth, run_id="run1", log_id="log1")
    with sync_engine.begin() as c:
        for speaker, said in lines:
            c.execute(text("insert into transcripts (call_id, speaker, text, interrupted, timestamp) "
                           "values (:id, :s, :t, 0, CURRENT_TIMESTAMP)"), {"id": call_id, "s": speaker, "t": said})
        for kind, payload in events:
            c.execute(text("insert into call_events (call_id, event_type, payload, created_at) "
                           "values (:id, :k, :p, CURRENT_TIMESTAMP)"), {"id": call_id, "k": kind, "p": payload})
    return call_id


async def _settle_now(call_id):
    """The safety net as the hangup schedules it, without its 20 s wait."""
    cs.settle_unfinalized_call(call_id, delay=0)
    await asyncio.gather(*cs._SETTLE_TASKS)


def _row(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select status, outcome, summary from calls where id = :id"), {"id": call_id}).one()


@pytest.mark.parametrize("lines, events, outcome, summary", [
    ([], [], "hung_up_early", "The customer hung up before the AI spoke."),
    ([("agent", "வணக்கம் சார், நான் ராகுல் சார் கிட்ட பேசுறேனா?")], [], "hung_up_early",
     "The customer hung up without saying anything."),
    ([], [("pipeline_error", '{"stage": "tts", "kind": "timeout", "turn": 1}')], "voice_error",
     "The AI's voice failed (text-to-speech error), so the customer heard nothing before the call ended."),
    ([("agent", "Hello"), ("agent", "Thank you, goodbye")], [("agent_hangup", None)], "completed",
     "The customer didn't say anything; the AI ended the call."),
])
def test_a_call_where_the_customer_said_nothing_gets_an_outcome_and_a_summary(client, auth, fakes, sync_engine, callbacks,
                                                                               lines, events, outcome, summary):
    call_id = _answered(client, auth, sync_engine, *lines, events=events)
    asyncio.run(cs.finalize_conversation(call_id, fakes.llm, "stream_stopped"))
    assert tuple(_row(sync_engine, call_id)) == ("completed", outcome, summary)
    finalized = [p for p in callbacks if p["event"] == "finalized"][-1]
    assert (finalized["log_id"], finalized["outcome"], finalized["summary"]) == ("log1", outcome, summary)


def test_a_call_with_customer_words_is_still_classified(client, auth, fakes, sync_engine, callbacks):
    call_id = _answered(client, auth, sync_engine, ("agent", "Hello, is this Ragul?"), ("customer", "Not interested, thanks"))
    fakes.llm.outcome_json = '{"outcome": "not_interested", "summary": "Said no."}'
    asyncio.run(cs.finalize_conversation(call_id, fakes.llm, "stream_stopped"))
    assert tuple(_row(sync_engine, call_id))[1:] == ("not_interested", "Said no.")


# ------------------------------------------------------------------ no media session: settled after the hangup
def _hangup(client, call_id, duration="16"):
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}",
                data={"Event": "Hangup", "CallUUID": "uuid-k", "CallStatus": "completed", "Duration": duration,
                      "HangupCauseName": "Normal Hangup", "HangupSource": "Callee"})


def test_an_answered_call_without_a_media_session_is_recorded_as_a_voice_error(client, auth, fakes, sync_engine,
                                                                                callbacks, monkeypatch, caplog):
    scheduled = []
    real = cs.settle_unfinalized_call
    monkeypatch.setattr(cs, "settle_unfinalized_call", lambda call_id, delay=None: scheduled.append(call_id))
    call_id, _ = _call(client, auth, run_id="run1", log_id="log1")  # answered; the media stream never connects
    _hangup(client, call_id)
    assert scheduled == [call_id]
    assert tuple(_row(sync_engine, call_id)) == ("completed", None, None)  # what Dispatch was left with before
    monkeypatch.setattr(cs, "settle_unfinalized_call", real)  # the real safety net, now instead of 20 s later
    with caplog.at_level(logging.WARNING):
        asyncio.run(_settle_now(call_id))
    status, outcome, summary = _row(sync_engine, call_id)
    assert (status, outcome) == ("completed", "voice_error")
    assert summary == "The call was answered, but the AI's audio never started, so the customer heard nothing."
    assert "without a media session" in caplog.text
    finalized = [p for p in callbacks if p["event"] == "finalized"][-1]
    assert (finalized["outcome"], finalized["duration_seconds"]) == ("voice_error", 16)


@pytest.mark.parametrize("state", ["active", "closing", "outcome", "finalized"])
def test_the_safety_net_leaves_a_call_its_session_finalizes(client, auth, fakes, sync_engine, callbacks, monkeypatch, state):
    call_id, _ = _call(client, auth, run_id="run1", log_id="log1")
    if state == "active":
        monkeypatch.setitem(cs.ACTIVE_SESSIONS, call_id, object())
    elif state == "closing":
        cs.CLOSING_SESSIONS.add(call_id)
    elif state == "outcome":
        with sync_engine.begin() as c:
            c.execute(text("update calls set outcome = 'interested' where id = :id"), {"id": call_id})
    else:
        with sync_engine.begin() as c:
            c.execute(text("insert into call_events (call_id, event_type, created_at) "
                           "values (:id, 'conversation_finalized', CURRENT_TIMESTAMP)"), {"id": call_id})
    try:
        asyncio.run(_settle_now(call_id))
    finally:
        cs.CLOSING_SESSIONS.discard(call_id)
    assert _row(sync_engine, call_id)[1] == ("interested" if state == "outcome" else None)
    assert not [p for p in callbacks if p["event"] == "finalized"]


def test_an_unanswered_call_needs_no_safety_net(client, auth, monkeypatch):
    scheduled = []
    monkeypatch.setattr(cs, "settle_unfinalized_call", lambda call_id, delay=None: scheduled.append(call_id))
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": PHONE, "customer_name": "Ragul", "agent_id": _nila_id(client, auth)})
    call_id = r.json()["call_id"]  # dialled, never answered
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}",
                data={"Event": "Hangup", "CallStatus": "no-answer", "HangupCauseName": "No Answer"})
    assert scheduled == []  # its outcome (no_answer) comes with the hangup


# ------------------------------------------------------------------ a cloned voice's stream fails before any audio
class _Stream(TTSStream):
    def __init__(self, name, chunks=(), fail=None):
        self.name, self.chunks, self.fail, self.sent = name, list(chunks), fail, []

    async def send_text(self, text_):
        self.sent.append(text_)

    async def end_input(self):
        pass

    async def audio(self):
        for c in self.chunks:
            yield c
        if self.fail:
            raise self.fail

    async def cancel(self):
        pass

    async def aclose(self):
        pass


async def _drain(stream):
    return [c async for c in stream.audio()]


async def test_a_cloned_stream_that_fails_before_audio_moves_the_call_to_the_stock_voice(monkeypatch, caplog):
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=TA_M1, exact_voice=True))
    opened = []

    async def clone_stream(pace=None):
        opened.append("clone")
        return _Stream("clone", fail=TTSError("timeout", "Sarvam TTS stopped sending audio"))

    async def stock_stream(pace=None):
        opened.append("stock")
        return _Stream("stock", chunks=[b"\x7f" * 160])

    async def stock_line(text_, pace=None):
        return b"stock-audio"

    monkeypatch.setattr(tts.primary, "open_stream", clone_stream)
    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    monkeypatch.setattr(tts.fallback, "synthesize", stock_line)
    first = await tts.open_stream()
    await first.send_text("வணக்கம் சார்")
    assert first.sent == ["வணக்கம் சார்"] and first.name == "clone"  # the provider's stream, unchanged
    with caplog.at_level(logging.WARNING), pytest.raises(TTSError):
        await _drain(first)  # the call sees the error and recovers ...
    assert "CLONED VOICE FALLBACK: streaming with cloned voice " + TA_M1 in caplog.text and "stock voice ratan" in caplog.text
    assert await tts.synthesize("வணக்கம் சார்") == b"stock-audio"  # ... in the stock voice, not the clone again
    assert not first.is_open()  # a warm cloned stream is not reused
    second = await tts.open_stream()
    assert await _drain(second) == [b"\x7f" * 160]
    assert opened == ["clone", "stock"]


async def test_a_cloned_stream_that_fails_after_audio_keeps_the_cloned_voice(monkeypatch):
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=TA_M1, exact_voice=True))

    async def clone_stream(pace=None):
        return _Stream("clone", chunks=[b"\x01" * 160], fail=TTSError("provider", "dropped"))

    monkeypatch.setattr(tts.primary, "open_stream", clone_stream)
    stream = await tts.open_stream()
    with pytest.raises(TTSError):
        await _drain(stream)
    assert not tts._on_fallback  # the clone already spoke this reply: never two voices for one reply
    assert (await tts.open_stream()).name == "clone"
