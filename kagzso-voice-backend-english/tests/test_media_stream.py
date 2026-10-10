"""End-to-end media pipeline over the real FastAPI WebSocket route with fake
providers: outbound -> answer XML -> stream start -> customer speech ->
STT -> LLM -> TTS -> playAudio -> barge-in (clearAudio) -> end call -> DB."""
import base64
import json
import time
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlparse

from sqlalchemy import text

from app.services import audio_service as audio
from tests.conftest import silence_mulaw, tone_mulaw

PHONE = "+919876543210"


def _setup_call(client, auth):
    call_id = client.post("/api/calls/outbound", headers=auth, json={
        "phone_number": PHONE, "contact_name": "Arun", "company_name": "ABC Restaurant", "agent_id": 1,
    }).json()["call_id"]
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}", data={"Event": "Ring", "CallStatus": "ringing", "CallUUID": "plivo-uuid-9"})
    xml = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}",
                      data={"CallUUID": "plivo-uuid-9", "CallStatus": "in-progress", "Event": "StartApp"}).text
    ws_url = ET.fromstring(xml.split("?>", 1)[1]).find("Stream").text
    q = parse_qs(urlparse(ws_url).query)
    return call_id, q["token"][0]


def _start_msg():
    return {"event": "start", "sequenceNumber": 1, "start": {
        "callId": "plivo-uuid-9", "streamId": "stream-1", "accountId": "MAXXX", "tracks": ["inbound"],
        "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000}}}


def _send_audio(ws, mulaw: bytes):
    for i, chunk in enumerate(audio.chunk_bytes(mulaw, 160)):
        ws.send_text(json.dumps({"event": "media", "sequenceNumber": i + 2, "streamId": "stream-1",
                                 "media": {"track": "inbound", "timestamp": "0", "chunk": i,
                                           "payload": base64.b64encode(chunk).decode()}}))


def _recv_until(ws, event: str, limit: int = 200):
    got = []
    for _ in range(limit):
        msg = ws.receive_json()
        got.append(msg)
        if msg["event"] == event:
            return got
    raise AssertionError(f"never received {event}: {[m['event'] for m in got]}")


def _wait_db(sync_engine, sql, predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with sync_engine.connect() as c:
            val = c.execute(text(sql)).all()
        if predicate(val):
            return val
        time.sleep(0.05)
    raise AssertionError(f"DB condition not met: {sql} -> {val}")


def test_rejects_bad_token(client, auth):
    call_id, _ = _setup_call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token=forged") as ws:
        ws.send_text(json.dumps({**_start_msg(), "start": {**_start_msg()["start"], "callId": "someone-else"}}))
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 1008


def test_full_conversation_with_barge_in(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who is this?", "Okay bye"]
    fakes.tts.chunks_per_sentence = 20  # ~4 s of agent audio queued at Plivo -> interruptible

    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))

        # ---- turn 1: customer says "Hello?" -> agent replies
        _send_audio(ws, silence_mulaw(100) + tone_mulaw(500) + silence_mulaw(900))
        msgs = _recv_until(ws, "checkpoint")
        plays = [m for m in msgs if m["event"] == "playAudio"]
        assert plays, "agent audio expected"
        assert plays[0]["media"]["contentType"] == "audio/x-mulaw" and plays[0]["media"]["sampleRate"] == 8000
        assert base64.b64decode(plays[0]["media"]["payload"])
        assert msgs[-1] == {"event": "checkpoint", "streamId": "stream-1", "name": "turn-1"}
        sent_texts = fakes.tts.streams[0].texts
        assert sent_texts == ["Hi Arun, this is Priya from Kagzso.", "Is now a good time for a quick introduction?"]

        # ---- turn 2: agent still "playing" (no playedStream yet) -> customer interrupts with real words
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        msgs = _recv_until(ws, "checkpoint")
        assert msgs[0] == {"event": "clearAudio", "streamId": "stream-1"}  # confirmed by STT, then cleared
        ws.send_text(json.dumps({"event": "playedStream", "sequenceNumber": 99, "streamId": "stream-1", "name": "turn-2"}))

        # ---- turn 3: agent ends the call
        fakes.llm.reply = "No problem, thanks for your time. Goodbye! [[END_CALL]]"
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _recv_until(ws, "checkpoint")
        assert "[[END_CALL]]" not in " ".join(fakes.tts.streams[-1].texts)
        ws.send_text(json.dumps({"event": "playedStream", "sequenceNumber": 120, "streamId": "stream-1", "name": "turn-3"}))
        deadline = time.time() + 3
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
        assert fakes.plivo.hangups == ["plivo-uuid-9"]
        ws.send_text(json.dumps({"event": "stop", "sequenceNumber": 130, "streamId": "stream-1"}))

    # Plivo hangup callback
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}", data={
        "Event": "Hangup", "CallStatus": "completed", "CallUUID": "plivo-uuid-9", "Duration": "42",
        "HangupCauseName": "Normal Hangup", "AnswerTime": "2026-10-06 10:00:00", "EndTime": "2026-10-06 10:00:42"})

    rows = _wait_db(sync_engine, "select outcome from calls", lambda v: v and v[0][0] == "interested")
    with sync_engine.connect() as c:
        call = c.execute(text("select status, outcome, summary, duration_seconds, stream_id, provider_call_id from calls")).one()
        transcripts = c.execute(text("select speaker, text, interrupted from transcripts order by id")).all()
        events = [r[0] for r in c.execute(text("select event_type from call_events order by id"))]
        metrics = c.execute(text("select turn_index, stt_ms, llm_ms, tts_first_byte_ms, total_response_ms from call_latency_metrics order by id")).all()

    assert call.status == "completed" and call.outcome == "interested" and call.duration_seconds == 42
    assert call.stream_id == "stream-1" and call.provider_call_id == "plivo-uuid-9"
    customer = [t.text for t in transcripts if t.speaker == "customer"]
    assert customer == ["Hello?", "Sorry, who is this?", "Okay bye"]
    agent = [t for t in transcripts if t.speaker == "agent"]
    assert len(agent) >= 3 and agent[-1].text.endswith("Goodbye!")
    for e in ("status:created", "status:ringing", "status:answered", "status:connected", "barge_in",
              "agent_hangup", "conversation_finalized"):
        assert e in events, (e, events)
    assert len(metrics) >= 2
    assert all(m.stt_ms is not None and m.total_response_ms is not None for m in metrics)

    # LLM saw the conversation history (turn 3 includes earlier turns)
    last_msgs = fakes.llm.seen_messages[-1]
    assert last_msgs[-1] == {"role": "user", "content": "Okay bye"}
    assert any(m["role"] == "assistant" for m in last_msgs)

    # API returns call + transcripts + latency
    detail = client.get(f"/api/calls/{call_id}", headers=auth).json()
    assert detail["status"] == "completed" and len(detail["transcripts"]) == len(transcripts) and detail["latency"]


def test_greeting_when_customer_silent(client, auth, fakes, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "GREETING_DELAY_MS", 200)
    call_id, token = _setup_call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        msgs = _recv_until(ws, "checkpoint")
        assert any(m["event"] == "playAudio" for m in msgs)
        assert fakes.stt.calls == 0  # nobody spoke; agent greeted first
        assert "picked up the phone" in fakes.llm.seen_messages[0][-1]["content"]
        ws.send_text(json.dumps({"event": "stop"}))


def test_dnd_outcome_marks_contact(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Please don't call me again"]
    fakes.llm.reply = "Sorry to bother you, we won't call again. Goodbye! [[END_CALL]]"
    fakes.llm.outcome_json = '{"outcome": "do_not_call", "summary": "Asked not to be called."}'
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(500) + silence_mulaw(900))
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    _wait_db(sync_engine, "select dnd from contacts", lambda v: v and v[0][0] == 1)
    r = client.post("/api/calls/outbound", headers=auth, json={"phone_number": PHONE, "agent_id": 1})
    assert r.status_code == 409


# ------------------------------------------------------------------ barge-in protection
def _agent_playing(client, auth, fakes, ws):
    fakes.tts.chunks_per_sentence = 20  # ~4 s queued at Plivo -> agent is "playing"
    ws.send_text(json.dumps(_start_msg()))
    _send_audio(ws, silence_mulaw(100) + tone_mulaw(500) + silence_mulaw(900))
    _recv_until(ws, "checkpoint")


def test_noise_while_agent_talks_is_ignored(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", ""]  # second utterance is noise: STT hears no words
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(300) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='barge_in_ignored'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    with sync_engine.connect() as c:
        events = [r[0] for r in c.execute(text(f"select event_type from call_events where call_id='{call_id}'"))]
    assert "barge_in" not in events and len(fakes.tts.streams) == 1  # agent was never cut off


def test_loud_sustained_speech_interrupts_immediately(client, auth, fakes, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Wait, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(1500))  # still talking: no end of speech yet
        assert ws.receive_json() == {"event": "clearAudio", "streamId": "stream-1"}
        assert fakes.stt.calls == 1  # cut off before any STT of the interruption
        ws.send_text(json.dumps({"event": "stop"}))


def test_loud_speech_inside_echo_window_waits_for_words(client, auth, fakes, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 60_000)  # agent audio just started -> echo window
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Wait, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))
        msgs = _recv_until(ws, "checkpoint")
        assert msgs[0] == {"event": "clearAudio", "streamId": "stream-1"} and fakes.stt.calls == 2
        assert fakes.llm.seen_messages[-1][-1]["content"] == "Wait, who is this?"
        ws.send_text(json.dumps({"event": "stop"}))


def test_hello_while_agent_talks_does_not_interrupt(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Hello hello, can you hear me?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(600) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='barge_in_ignored'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    assert len(fakes.tts.streams) == 1 and fakes.stt.calls == 2


def test_filler_detection():
    from app.services.call_service import is_filler

    for t in ("Hello", "Hello?", "Yes.", "Hmm", "Hello sir, can you hear me?", "Yeah yeah"):
        assert is_filler(t), t
    for t in ("", "I am busy", "Not interested", "Who is this?", "Yes, tell me about pricing"):
        assert not is_filler(t), t
