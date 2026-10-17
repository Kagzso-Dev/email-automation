"""The fixed first sentence is rendered while the phone rings and played the moment
the call is answered - no dead air waiting for a live TTS round-trip."""
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import call_service
from app.services.tts import TTSError
from tests.conftest import silence_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


@pytest.fixture
def prerender(monkeypatch):
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    monkeypatch.setattr(settings, "GREETING_PRERENDERED_DELAY_MS", 50)
    yield
    call_service._GREETING_AUDIO.clear()


def _wait_for_greeting(call_id, present=True, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if call_service.has_greeting_audio(call_id) == present:
            return
        time.sleep(0.02)
    raise AssertionError(f"greeting audio present={not present} after {timeout}s")


def test_greeting_plays_prerendered_audio_without_live_tts(client, auth, fakes, sync_engine, prerender):
    # GREETING_DELAY_MS is 60s in tests: only the pre-rendered path can greet this fast.
    call_id, token = _call(client, auth, gender="male")
    _wait_for_greeting(call_id)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, silence_mulaw(200))
        play = _until(ws, "playAudio")
        assert play["media"]["contentType"] == "audio/x-mulaw"
        _until(ws, "checkpoint")
        time.sleep(0.3)  # let the background DB writer store the transcript
    assert fakes.tts.streams == []  # nothing was synthesized after the answer
    assert not call_service.has_greeting_audio(call_id)  # used once
    with sync_engine.connect() as c:
        said = c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent'"), {"id": call_id}).scalars().all()
    assert said == ["Hi sir, Good morning."]


def test_prerender_failure_falls_back_to_live_tts(client, auth, fakes, prerender, monkeypatch):
    async def boom(_text, pace=None):
        raise TTSError("timeout", "simulated")

    monkeypatch.setattr(fakes.tts, "synthesize", boom)
    call_id, _ = _call(client, auth)
    time.sleep(0.2)
    assert not call_service.has_greeting_audio(call_id)  # the call goes on; greeting is streamed live


def test_prerender_dropped_when_call_is_not_answered(client, auth, prerender):
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": "+919876543210", "customer_name": "Ragul", "agent_name": "Nila"})
    call_id = r.json()["call_id"]
    _wait_for_greeting(call_id)
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}",
                data={"Event": "Hangup", "CallStatus": "no-answer", "HangupCauseName": "No Answer"})
    assert not call_service.has_greeting_audio(call_id)


def test_prerender_off_by_setting(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_PRERENDER", False)
    call_id, _ = _call(client, auth)
    time.sleep(0.2)
    assert not call_service.has_greeting_audio(call_id)
