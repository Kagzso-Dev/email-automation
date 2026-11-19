"""Every answered call ends with a result. A call where the customer said nothing gets an outcome and a one-line
summary from finalize_conversation (hung_up_early / voice_error / completed), a call that never had a media session is
finalized by settle_unfinalized_call after its hangup, and a cloned voice whose live stream fails before any audio
moves the rest of the call to its stock voice. Nothing is dialled; Dispatch callbacks are captured, never sent."""
import asyncio
import logging
import time
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


# ------------------------------------------------------------------ a cloned voice's stream: silent, failing or speaking
class _Stream(TTSStream):
    """A fake provider stream: records what it was sent and, once the input has ended, plays one chunk per text
    (speaks=True); or stays silent until closed; or fails before any audio (fail) or after it (fail_after)."""

    def __init__(self, name, speaks=True, fail=None, fail_after=None, send_fail=None):
        self.name, self.speaks, self.fail, self.fail_after, self.send_fail = name, speaks, fail, fail_after, send_fail
        self.ops, self.closed = [], False
        self._ended = asyncio.Event()

    async def send_text(self, text_):
        if self.send_fail:
            raise self.send_fail
        self.ops.append(("text", text_))

    async def flush(self):
        self.ops.append(("flush", None))

    async def end_input(self):
        self.ops.append(("end", None))
        self._ended.set()

    async def audio(self):
        if self.fail:
            raise self.fail
        if not self.speaks:
            while not self.closed:
                await asyncio.sleep(0.01)
            return
        await self._ended.wait()
        for kind, text_ in self.ops:
            if kind == "text":
                yield f"{self.name}:{text_}".encode()
        if self.fail_after:
            raise self.fail_after

    async def cancel(self):
        self.closed = True

    async def aclose(self):
        self.closed = True


def _clone_call(monkeypatch, clone: _Stream, limit=0.2, **cfg):
    """A cloned male voice's TTS for one call, with fake provider streams; returns (tts, stock streams opened)."""
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta", SARVAM_TTS_CLONE_FIRST_AUDIO_SECONDS=limit, **cfg),
                                                          voice_id=TA_M1, exact_voice=True))
    stocks = []

    async def clone_stream(pace=None):
        return clone

    async def stock_stream(pace=None):
        stocks.append(_Stream("stock"))
        return stocks[-1]

    monkeypatch.setattr(tts.primary, "open_stream", clone_stream)
    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    return tts, stocks


async def _reply(stream, pause=0.0, flush_first=True):
    """One reply as a live agent call sends it: first sentence (flushed), the rest, the end; audio read meanwhile."""
    heard = asyncio.ensure_future(_drain(stream))
    await stream.send_text("வணக்கம் சார்.")
    if flush_first:
        await stream.flush()
    await asyncio.sleep(pause)
    await stream.send_text("நான் கெக்ஸோ-ல இருந்து பேசுறேன்.")
    await stream.end_input()
    return await asyncio.wait_for(heard, 5)


async def _drain(stream):
    return [c async for c in stream.audio()]


SENT = [("text", "வணக்கம் சார்."), ("flush", None), ("text", "நான் கெக்ஸோ-ல இருந்து பேசுறேன்."), ("end", None)]
HEARD_STOCK = ["stock:வணக்கம் சார்.".encode(), "stock:நான் கெக்ஸோ-ல இருந்து பேசுறேன்.".encode()]


async def test_a_silent_cloned_stream_hands_the_reply_to_the_stock_voice_after_the_limit(monkeypatch, caplog):
    clone = _Stream("clone", speaks=False)  # as Sarvam's clone socket did on 2026-11-19: no audio at all
    tts, stocks = _clone_call(monkeypatch, clone)
    stream = await tts.open_stream()
    started = time.monotonic()
    with caplog.at_level(logging.WARNING):
        heard = await _reply(stream, pause=0.4)  # the rest comes after the switch: it goes to the stock voice
    assert heard == HEARD_STOCK  # the whole reply, once, in the stock voice: no error, no repeat
    assert stocks[0].ops == SENT and clone.ops == SENT[:2]
    assert time.monotonic() - started < 1.5  # 0.2 s limit, not Sarvam's 10 s
    await asyncio.sleep(0.05)
    assert clone.closed and tts._on_fallback and not stream.is_open()
    assert "CLONED VOICE FALLBACK: no audio within 0.2s of the text with cloned voice " + TA_M1 in caplog.text
    assert "stock voice ratan" in caplog.text
    assert await _reply(await tts.open_stream()) == HEARD_STOCK and len(stocks) == 2  # the next reply: stock at once


@pytest.mark.parametrize("clone", [
    _Stream("clone", fail=TTSError("provider", "Sarvam voice clone stream closed before any audio")),
    _Stream("clone", send_fail=TTSError("provider", "Sarvam TTS stream is closed")),
], ids=["closed before audio", "refused a message"])
async def test_a_failing_cloned_stream_hands_the_reply_over_without_an_error(monkeypatch, caplog, clone):
    tts, stocks = _clone_call(monkeypatch, clone, limit=5.0)
    with caplog.at_level(logging.WARNING):
        heard = await _reply(await tts.open_stream())
    assert heard == HEARD_STOCK and stocks[0].ops == SENT
    assert "CLONED VOICE FALLBACK: streaming with cloned voice" in caplog.text


async def test_a_cloned_stream_that_speaks_in_time_keeps_the_cloned_voice(monkeypatch):
    clone = _Stream("clone")
    tts, stocks = _clone_call(monkeypatch, clone, limit=5.0)
    heard = await _reply(await tts.open_stream())
    assert heard == [b"clone:" + s.encode() for k, s in SENT if k == "text"] and stocks == [] and not tts._on_fallback


async def test_a_cloned_stream_that_fails_after_audio_keeps_the_cloned_voice(monkeypatch):
    clone = _Stream("clone", fail_after=TTSError("provider", "dropped"))
    tts, stocks = _clone_call(monkeypatch, clone)
    with pytest.raises(TTSError):
        await _reply(await tts.open_stream())
    assert not tts._on_fallback and stocks == []  # the clone already spoke this reply: never two voices in one reply


async def test_the_limit_counts_from_when_the_text_is_due(monkeypatch):
    # A Call Flow sends no flush after its first sentence: under Sarvam's buffer it is not due before the end.
    clone = _Stream("clone", speaks=False)
    tts, stocks = _clone_call(monkeypatch, clone, SARVAM_TTS_MIN_BUFFER_CHARS=200)
    stream = await tts.open_stream()
    heard = asyncio.ensure_future(_drain(stream))
    await stream.send_text("வணக்கம் சார்.")
    await asyncio.sleep(0.4)  # past the limit, but nothing was due yet
    assert stocks == []
    await stream.end_input()  # now it is due
    assert await asyncio.wait_for(heard, 5) == HEARD_STOCK[:1] and stocks[0].ops == [("text", "வணக்கம் சார்."), ("end", None)]


async def test_limit_zero_waits_for_the_provider_as_before(monkeypatch):
    clone = _Stream("clone", speaks=False)
    tts, stocks = _clone_call(monkeypatch, clone, limit=0)
    stream = await tts.open_stream()
    heard = asyncio.ensure_future(_drain(stream))
    await stream.send_text("வணக்கம் சார்.")
    await stream.end_input()
    await asyncio.sleep(0.4)
    assert stocks == [] and not heard.done()
    await stream.aclose()
    assert await asyncio.wait_for(heard, 5) == []


# ------------------------------------------------------------------ a cloned voice speaks through REST, sentence by sentence
async def test_a_cloned_voice_streams_through_rest_sentence_by_sentence_by_default(monkeypatch):
    """SARVAM_TTS_CLONE_STREAM=rest (default): no socket. Each sentence is synthesized as soon as it is sent, in
    parallel, and played in order; the first one plays as soon as its audio arrives."""
    from app.services.sarvam_tts import CloneSentenceStream, SarvamStream

    tts = SarvamTTS(_cfg("ta"), voice_id=TA_M1, exact_voice=True)
    made, started = [], {}

    async def synthesize(text_, pace=None):
        started[text_] = time.monotonic()
        made.append((text_, pace))
        await asyncio.sleep(0.3 if text_.startswith("வணக்கம்") else 0.05)  # the first sentence is the slow one
        return f"audio:{text_}".encode()

    async def no_socket(*a, **k):
        raise AssertionError("no websocket for a cloned voice in rest mode")

    monkeypatch.setattr(tts, "synthesize", synthesize)
    monkeypatch.setattr(SarvamStream, "connect", no_socket)
    stream = await tts.open_stream(pace=0.9)
    assert isinstance(stream, CloneSentenceStream)
    t0 = time.monotonic()
    heard = asyncio.ensure_future(_drain(stream))
    await stream.send_text("வணக்கம் சார்.")
    await stream.flush()  # nothing to do: each sentence is already on its way
    await stream.send_text("நான் கெக்ஸோ-ல இருந்து பேசுறேன்.")
    await stream.end_input()
    chunks = await asyncio.wait_for(heard, 5)
    assert chunks == ["audio:வணக்கம் சார்.".encode(), "audio:நான் கெக்ஸோ-ல இருந்து பேசுறேன்.".encode()]  # in order
    assert made == [("வணக்கம் சார்.", 0.9), ("நான் கெக்ஸோ-ல இருந்து பேசுறேன்.", 0.9)]
    assert started["நான் கெக்ஸோ-ல இருந்து பேசுறேன்."] - t0 < 0.2  # made while the first was still being made
    websocket = SarvamTTS(_cfg("ta", SARVAM_TTS_CLONE_STREAM="websocket"), voice_id=TA_M1, exact_voice=True)
    with pytest.raises(AssertionError, match="no websocket"):
        await websocket.open_stream()  # the socket only when asked for
    assert provider_registry._tts_view(tts)["clone_stream"] == "rest"


async def test_a_rest_clone_slower_than_the_limit_hands_the_reply_to_the_stock_voice(monkeypatch, caplog):
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta", SARVAM_TTS_CLONE_FIRST_AUDIO_SECONDS=0.2),
                                                          voice_id=TA_M1, exact_voice=True))
    stocks = []

    async def slow(text_, pace=None):
        await asyncio.sleep(5)
        return b"late"

    async def stock_stream(pace=None):
        stocks.append(_Stream("stock"))
        return stocks[-1]

    monkeypatch.setattr(tts.primary, "synthesize", slow)
    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    started = time.monotonic()
    with caplog.at_level(logging.WARNING):
        heard = await _reply(await tts.open_stream())
    assert heard == HEARD_STOCK and stocks[0].ops == SENT
    assert time.monotonic() - started < 1.5
    assert "CLONED VOICE FALLBACK: no audio within 0.2s" in caplog.text


async def test_a_rest_clone_error_hands_the_reply_to_the_stock_voice(monkeypatch):
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=TA_M1, exact_voice=True))
    stocks = []

    async def refused(text_, pace=None):
        raise TTSError("rate_limit", "Sarvam TTS rate limit hit (429)", 429)

    async def stock_stream(pace=None):
        stocks.append(_Stream("stock"))
        return stocks[-1]

    monkeypatch.setattr(tts.primary, "synthesize", refused)
    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    assert await _reply(await tts.open_stream()) == HEARD_STOCK and tts._on_fallback
