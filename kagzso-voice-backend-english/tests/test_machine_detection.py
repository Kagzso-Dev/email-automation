"""Plivo's answering-machine verdict is checked against what STT heard before the call is hung up:
a person's short reply keeps the call, a voicemail phrase / monologue / no words hang up as before."""
import json
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import call_service
from app.services.call_service import machine_evidence
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


# ------------------------------------------------------------------ the rule
@pytest.mark.parametrize("texts,speaking_ms,verdict", [
    (["Hello"], 0, "human"),
    (["Hello?", "Yes, tell me."], 0, "human"),
    (["வணக்கம்"], 0, "human"),
    (["Haan ji bolo"], 0, "human"),
    (["Please leave a message after the tone"], 0, "machine"),
    (["The number you have dialled is switched off"], 0, "machine"),
    (["Hi, I can't take your call right now"], 0, "machine"),
    (["Hello this is Ravi I am not at my desk right now so please call me back later thanks"], 0, "machine"),
    ([], 7000, "machine"),
    ([], 0, None),
    (["", "  "], 0, None),
])
def test_machine_evidence(texts, speaking_ms, verdict):
    assert machine_evidence(texts, speaking_ms) == verdict


# ------------------------------------------------------------------ in a call
def _machine(client, call_id):
    r = client.post(f"/api/webhooks/plivo/machine?call_id={call_id}",
                    data={"Event": "MachineDetection", "Machine": "true", "CallUUID": "uuid-k", "CallStatus": "in-progress"})
    assert r.status_code == 200


def _wait_for_session(call_id):
    """Plivo's verdict comes 2+ s after answer, when the media session is already running."""
    deadline = time.time() + 3
    while call_id not in call_service.ACTIVE_SESSIONS and time.time() < deadline:
        time.sleep(0.02)
    assert call_id in call_service.ACTIVE_SESSIONS


def _events(sync_engine):
    with sync_engine.connect() as c:
        return [r[0] for r in c.execute(text("select event_type from call_events order by id"))]


def _outcome(sync_engine):
    with sync_engine.connect() as c:
        return c.execute(text("select outcome from calls")).scalar()


def test_person_who_said_hello_is_not_hung_up(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the greeting started by "Hello"
        _machine(client, call_id)
        time.sleep(0.3)
    assert fakes.plivo.hangups == []
    assert "machine_detection_overruled" in _events(sync_engine)
    assert _outcome(sync_engine) != "voicemail"


def test_words_arriving_after_the_verdict_keep_the_call(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "MACHINE_VERIFY_SECONDS", 1.0)
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, silence_mulaw(200))
        _wait_for_session(call_id)
        _machine(client, call_id)  # before any words were heard
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # "Hello?" a moment later
        _until(ws, "checkpoint")
        time.sleep(1.3)
    assert fakes.plivo.hangups == []
    assert "machine_detection_verifying" in _events(sync_engine)
    assert "machine_detection_overruled" in _events(sync_engine)


def test_no_words_after_the_verdict_hangs_up_as_before(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "MACHINE_VERIFY_SECONDS", 0.3)
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, silence_mulaw(200))
        _wait_for_session(call_id)
        _machine(client, call_id)
        deadline = time.time() + 3
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.plivo.hangups == ["uuid-k"]
    assert "machine_detection_confirmed" in _events(sync_engine)
    deadline = time.time() + 3
    while _outcome(sync_engine) != "voicemail" and time.time() < deadline:
        time.sleep(0.05)
    assert _outcome(sync_engine) == "voicemail"


def test_voicemail_greeting_hangs_up_at_once(client, auth, fakes):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["The person you are calling is not available, please leave a message"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _machine(client, call_id)
        assert fakes.plivo.hangups == ["uuid-k"]  # no waiting when the words say voicemail


def test_switched_off_hangs_up_on_the_verdict_as_before(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "MACHINE_DETECTION_VERIFY", False)
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _machine(client, call_id)
        assert fakes.plivo.hangups == ["uuid-k"]
