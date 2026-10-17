"""Twilio telephony: REST request shapes, TwiML, signature validation, status mapping,
and a full call over the real /ws/twilio/media route with fake STT/LLM/TTS."""
import base64
import json
import time
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import text

from app.api.twilio_webhooks import translate_status
from app.core.config import settings
from app.core.security import verify_stream_token
from app.services import audio_service as audio
from app.services.plivo_service import TelephonyError
from app.services.twilio_service import TwilioService
from tests.conftest import silence_mulaw, tone_mulaw

SID = "AC" + "0" * 32
PHONE = "+919876543210"


def _svc(handler):
    return TwilioService(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


# ------------------------------------------------------------------ REST
async def test_outbound_call_request_shape():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["form"] = parse_qs(req.content.decode())
        return httpx.Response(201, json={"sid": "CA123", "status": "queued"})

    res = await _svc(handler).make_outbound_call("cid1", PHONE)
    assert res.request_uuid == "CA123"
    assert seen["url"] == f"https://api.twilio.com/2010-04-01/Accounts/{SID}/Calls.json"
    assert seen["auth"] == "Basic " + base64.b64encode(f"{SID}:twilio-test-token-abcdef".encode()).decode()
    f = seen["form"]
    assert f["To"] == [PHONE] and f["From"] == ["+15005550006"]
    assert f["Url"] == ["https://test.example.com/api/webhooks/twilio/voice?call_id=cid1"]
    assert f["StatusCallback"] == ["https://test.example.com/api/webhooks/twilio/status?call_id=cid1"]
    assert f["StatusCallbackEvent"] == ["initiated", "ringing", "answered", "completed"]
    assert f["TimeLimit"] == [str(settings.MAX_CALL_DURATION_SECONDS)]
    assert f["MachineDetection"] == ["Enable"] and f["AsyncAmd"] == ["true"]
    assert f["AsyncAmdStatusCallback"] == ["https://test.example.com/api/webhooks/twilio/amd?call_id=cid1"]


async def test_hangup_and_errors():
    seen = {}

    def handler(req):
        seen["path"], seen["form"] = req.url.path, parse_qs(req.content.decode())
        return httpx.Response(200, json={"sid": "CA1", "status": "completed"})

    assert await _svc(handler).hangup("CA1") is True
    assert seen["path"].endswith("/Calls/CA1.json") and seen["form"] == {"Status": ["completed"]}

    with pytest.raises(TelephonyError) as ei:
        await _svc(lambda r: httpx.Response(401, json={"code": 20003, "message": "Authenticate"})).make_outbound_call("c", PHONE)
    assert ei.value.kind == "auth"
    with pytest.raises(TelephonyError) as ei:
        await _svc(lambda r: httpx.Response(400, json={"code": 21219, "message": "The number is unverified"})).make_outbound_call("c", PHONE)
    assert ei.value.kind == "invalid_request" and "21219" in str(ei.value)


def test_twiml_connect_stream_with_parameters():
    xml = TwilioService(settings).build_stream_xml("abc123")
    root = ET.fromstring(xml.split("?>", 1)[1])
    stream = root.find("Connect/Stream")
    assert stream.get("url") == "wss://test.example.com/ws/twilio/media"  # no query string allowed
    params = {p.get("name"): p.get("value") for p in stream.findall("Parameter")}
    assert params["call_id"] == "abc123" and verify_stream_token("abc123", params["token"])


def test_status_translation():
    assert translate_status({"CallSid": "CA1", "CallStatus": "ringing"})["Event"] == "Ring"
    done = translate_status({"CallSid": "CA1", "CallStatus": "completed", "CallDuration": "42"})
    assert done == {"CallUUID": "CA1", "Event": "Hangup", "CallStatus": "completed", "Duration": "42"}
    assert translate_status({"CallSid": "CA1", "CallStatus": "no-answer"})["CallStatus"] == "no-answer"
    assert translate_status({"CallSid": "CA1", "CallStatus": "canceled"})["CallStatus"] == "cancel"
    assert translate_status({"CallSid": "CA1", "CallStatus": "in-progress"})["Event"] == "in-progress"


# ------------------------------------------------------------------ API + webhooks
@pytest.fixture
def twilio_mode(monkeypatch):
    monkeypatch.setattr(settings, "TELEPHONY_PROVIDER", "twilio")


def _outbound(client, auth):
    agent = next(a["id"] for a in client.get("/api/agents", headers=auth).json() if a["name"] == "Nila")
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": PHONE, "customer_name": "Ragul", "gender": "male", "agent_id": agent})
    assert r.status_code == 200, r.text
    return r.json()


def test_outbound_uses_twilio_when_selected(client, auth, fakes, sync_engine, twilio_mode):
    body = _outbound(client, auth)
    assert body["provider_call_id"].startswith("CA")
    assert fakes.twilio.placed == [PHONE] and fakes.plivo.placed == []
    with sync_engine.connect() as c:
        row = c.execute(text("select telephony_provider, from_number from calls")).one()
    assert row == ("twilio", "+15005550006")
    ready = client.get("/ready").json()
    assert ready["telephony_provider"] == "twilio" and ready["providers"]["telephony"] == "configured"


def test_twilio_signature_enforced(client, auth, twilio_mode, monkeypatch):
    from twilio.request_validator import RequestValidator

    monkeypatch.setattr(settings, "TWILIO_VALIDATE_SIGNATURE", True)
    call_id = _outbound(client, auth)["call_id"]
    path = f"/api/webhooks/twilio/voice?call_id={call_id}"
    params = {"CallSid": "CA" + "1" * 32, "CallStatus": "in-progress", "AccountSid": SID}
    assert client.post(path, data=params).status_code == 403
    assert client.post(path, data=params, headers={"X-Twilio-Signature": "bogus"}).status_code == 403
    sig = RequestValidator("twilio-test-token-abcdef").compute_signature("https://test.example.com" + path, params)
    r = client.post(path, data=params, headers={"X-Twilio-Signature": sig})
    assert r.status_code == 200 and "<Connect>" in r.text


def test_twilio_amd_machine_hangs_up(client, auth, fakes, sync_engine, twilio_mode):
    body = _outbound(client, auth)
    client.post(f"/api/webhooks/twilio/voice?call_id={body['call_id']}", data={"CallSid": "CA9", "CallStatus": "in-progress"})
    r = client.post(f"/api/webhooks/twilio/amd?call_id={body['call_id']}", data={"CallSid": "CA9", "AnsweredBy": "machine_start"})
    assert r.status_code == 204 and fakes.twilio.hangups == ["CA9"] and fakes.plivo.hangups == []
    with sync_engine.connect() as c:
        assert c.execute(text("select outcome from calls")).scalar() == "voicemail"


def test_twilio_no_answer_status(client, auth, sync_engine, twilio_mode):
    body = _outbound(client, auth)
    client.post(f"/api/webhooks/twilio/status?call_id={body['call_id']}", data={"CallSid": "CA9", "CallStatus": "ringing"})
    client.post(f"/api/webhooks/twilio/status?call_id={body['call_id']}", data={"CallSid": "CA9", "CallStatus": "no-answer", "CallDuration": "0"})
    with sync_engine.connect() as c:
        assert c.execute(text("select status, outcome from calls")).one() == ("no_answer", "no_answer")


# ------------------------------------------------------------------ full call over /ws/twilio/media
def _start(ws, call_id, token):
    ws.send_text(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
    ws.send_text(json.dumps({"event": "start", "sequenceNumber": "1", "streamSid": "MZ1", "start": {
        "streamSid": "MZ1", "accountSid": SID, "callSid": "CA9", "tracks": ["inbound"],
        "customParameters": {"call_id": call_id, "token": token},
        "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}}}))


def _send(ws, mulaw):
    for i, c in enumerate(audio.chunk_bytes(mulaw, 160)):
        ws.send_text(json.dumps({"event": "media", "streamSid": "MZ1",
                                 "media": {"track": "inbound", "chunk": str(i), "timestamp": "0",
                                           "payload": base64.b64encode(c).decode()}}))


def _until(ws, event, limit=400):
    got = []
    for _ in range(limit):
        m = ws.receive_json()
        got.append(m)
        if m["event"] == event:
            return got
    raise AssertionError(event)


def test_full_twilio_call(client, auth, fakes, sync_engine, twilio_mode):
    fakes.stt.replies = ["Hello?", "Are you a robot?", "இப்போ busy"]
    fakes.tts.chunks_per_sentence = 20
    call_id = _outbound(client, auth)["call_id"]
    xml = client.post(f"/api/webhooks/twilio/voice?call_id={call_id}", data={"CallSid": "CA9", "CallStatus": "in-progress"}).text
    params = {p.get("name"): p.get("value") for p in ET.fromstring(xml.split("?>", 1)[1]).find("Connect/Stream").findall("Parameter")}

    with client.websocket_connect("/ws/twilio/media") as ws:
        _start(ws, params["call_id"], params["token"])
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # "Hello?"
        msgs = _until(ws, "mark")
        media = [m for m in msgs if m["event"] == "media"]
        assert media and set(media[0]) == {"event", "streamSid", "media"} and media[0]["streamSid"] == "MZ1"
        assert set(media[0]["media"]) == {"payload"}  # Twilio accepts only the payload here
        assert msgs[-1] == {"event": "mark", "streamSid": "MZ1", "mark": {"name": "turn-1"}}
        assert fakes.tts.streams[0].texts == ["Hi sir, Good morning."]

        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # customer talks over the agent -> clear
        msgs = _until(ws, "mark")
        assert msgs[0] == {"event": "clear", "streamSid": "MZ1"}
        ws.send_text(json.dumps({"event": "mark", "streamSid": "MZ1", "mark": {"name": "turn-2"}}))  # played

        fakes.llm.reply = "No problem sir. Have a nice day. [[END_CALL]]"
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "mark")
        ws.send_text(json.dumps({"event": "mark", "streamSid": "MZ1", "mark": {"name": "turn-3"}}))
        deadline = time.time() + 3
        while not fakes.twilio.hangups and time.time() < deadline:
            time.sleep(0.05)
        assert fakes.twilio.hangups == ["CA9"] and fakes.plivo.hangups == []
        ws.send_text(json.dumps({"event": "stop", "streamSid": "MZ1", "stop": {"accountSid": SID, "callSid": "CA9"}}))

    client.post(f"/api/webhooks/twilio/status?call_id={call_id}", data={"CallSid": "CA9", "CallStatus": "completed", "CallDuration": "31"})
    deadline = time.time() + 5
    while time.time() < deadline:
        with sync_engine.connect() as c:
            if c.execute(text("select count(*) from call_events where event_type='conversation_finalized'")).scalar():
                break
        time.sleep(0.05)
    with sync_engine.connect() as c:
        call = c.execute(text("select status, duration_seconds, stream_id, provider_call_id from calls")).one()
        events = [r[0] for r in c.execute(text("select event_type from call_events order by id"))]
        customer = [r[0] for r in c.execute(text("select text from transcripts where speaker='customer' order by id"))]
    assert call == ("completed", 31, "MZ1", "CA9")
    assert "twilio:call_fired" in events and "barge_in" in events and "agent_hangup" in events
    assert customer == ["Hello?", "Are you a robot?", "இப்போ busy"]


def test_twilio_ws_rejects_bad_token(client, auth, twilio_mode):
    call_id = _outbound(client, auth)["call_id"]
    with client.websocket_connect("/ws/twilio/media") as ws:
        ws.send_text(json.dumps({"event": "start", "start": {"streamSid": "MZ1", "callSid": "CAother",
                                                             "customParameters": {"call_id": call_id, "token": "forged"}}}))
        msg = ws.receive()
        assert msg["type"] == "websocket.close" and msg["code"] == 1008
