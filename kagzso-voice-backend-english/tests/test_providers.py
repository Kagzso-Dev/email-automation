import asyncio
import base64
import json

import httpx
import pytest

from app.core.config import settings
from app.core.security import sign_stream_token, verify_stream_token
from app.services import audio_service as audio
from app.services.cartesia_tts import CartesiaTTS, TTSError
from app.services.plivo_service import PlivoService
from app.services.sarvam_stt import SarvamSTT, STTError


# ------------------------------------------------------------ Sarvam
def _sarvam(handler):
    return SarvamSTT(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))


async def test_sarvam_request_and_response():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["key"] = req.headers.get("api-subscription-key")
        body = req.content
        seen["body"] = body
        return httpx.Response(200, json={"request_id": "r1", "transcript": " Hello there ", "language_code": "en-IN", "language_probability": 0.93})

    stt = _sarvam(handler)
    res = await stt.transcribe(audio.mulaw_to_stt_wav(audio.pcm16_to_mulaw(b"\x00\x01" * 4000)))
    assert res == {"text": "Hello there", "language": "en-IN", "confidence": 0.93}
    assert seen["path"] == "/speech-to-text"
    assert seen["key"] == "sarvam-test-key"
    for field in (b'name="model"', b"saaras:v3", b'name="mode"', b"transcribe", b'name="language_code"', b"en-IN", b'name="file"'):
        assert field in seen["body"]


@pytest.mark.parametrize("status,kind", [(403, "auth"), (429, "rate_limit"), (400, "invalid_audio"), (500, "provider")])
async def test_sarvam_errors(status, kind):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(status, json={"error": {"message": "x", "code": "y"}})

    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"RIFF" + b"\x00" * 200)
    assert ei.value.kind == kind
    assert calls["n"] == (2 if kind in ("rate_limit", "provider") else 1)  # transient errors retried once


async def test_sarvam_timeout_and_invalid_audio():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"RIFF" + b"\x00" * 200)
    assert ei.value.kind == "timeout"
    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"")
    assert ei.value.kind == "invalid_audio"


# ------------------------------------------------------------ Cartesia REST
async def test_cartesia_bytes_request_shape():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["headers"] = dict(req.headers)
        seen["body"] = json.loads(req.content)
        seen["path"] = req.url.path
        return httpx.Response(200, content=b"\xff" * 800)

    tts = CartesiaTTS(settings, client=httpx.AsyncClient(base_url="https://api.cartesia.ai", transport=httpx.MockTransport(handler)))
    out = await tts.synthesize("Hello")
    assert out == b"\xff" * 800
    assert seen["path"] == "/tts/bytes"
    assert seen["headers"]["authorization"] == "Bearer cartesia-test-key"
    assert seen["headers"]["cartesia-version"] == "2026-08-14"
    assert seen["body"]["output_format"] == {"container": "raw", "encoding": "pcm_mulaw", "sample_rate": 8000}
    assert seen["body"]["voice"] == {"id": "voice-123"}
    assert seen["body"]["model_id"] == "sonic-3.6"


async def test_cartesia_bytes_auth_error():
    tts = CartesiaTTS(settings, client=httpx.AsyncClient(base_url="https://x", transport=httpx.MockTransport(lambda r: httpx.Response(401, text="bad"))))
    with pytest.raises(TTSError) as ei:
        await tts.synthesize("Hello")
    assert ei.value.kind == "auth"


# ------------------------------------------------------------ Cartesia WebSocket (real client vs local server)
async def test_cartesia_websocket_stream(monkeypatch):
    from websockets.asyncio.server import serve

    received = []
    headers = {}

    async def handler(ws):
        headers["key"] = ws.request.headers.get("X-API-Key")
        headers["path"] = ws.request.path
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if msg.get("transcript"):
                await ws.send(json.dumps({"type": "chunk", "context_id": msg["context_id"], "data": base64.b64encode(b"\x7f" * 400).decode(), "done": False}))
            if msg.get("continue") is False:
                await ws.send(json.dumps({"type": "done", "context_id": msg["context_id"], "done": True}))

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(settings, "CARTESIA_WS_URL", f"ws://127.0.0.1:{port}/tts/websocket")
        tts = CartesiaTTS(settings)
        stream = await tts.open_stream()
        await stream.send_text("Hi Arun.")
        await stream.send_text("Is now a good time?")
        await stream.end_input()
        chunks = [c async for c in stream.audio()]
        await stream.aclose()

    assert chunks == [b"\x7f" * 400, b"\x7f" * 400]
    assert headers["key"] == "cartesia-test-key"
    assert "cartesia_version=2026-08-14" in headers["path"]
    first = received[0]
    assert first["continue"] is True and first["max_buffer_delay_ms"] == 0
    assert first["output_format"]["encoding"] == "pcm_mulaw" and first["voice"] == {"id": "voice-123"}
    assert received[-1]["continue"] is False and received[-1]["transcript"] == ""
    assert len({m["context_id"] for m in received}) == 1


async def test_cartesia_websocket_error_message(monkeypatch):
    from websockets.asyncio.server import serve

    async def handler(ws):
        async for raw in ws:
            msg = json.loads(raw)
            await ws.send(json.dumps({"type": "error", "context_id": msg["context_id"], "status_code": 400, "title": "Invalid voice", "message": "voice not found"}))

    async with serve(handler, "127.0.0.1", 0) as server:
        monkeypatch.setattr(settings, "CARTESIA_WS_URL", f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}")
        stream = await CartesiaTTS(settings).open_stream()
        await stream.send_text("Hello.")
        with pytest.raises(TTSError) as ei:
            async for _ in stream.audio():
                pass
        await stream.aclose()
    assert ei.value.kind == "invalid_request"


# ------------------------------------------------------------ Plivo
def test_stream_xml_matches_plivo_spec():
    p = PlivoService(settings)
    xml = p.build_stream_xml("abc123")
    assert 'bidirectional="true"' in xml and 'keepCallAlive="true"' in xml
    assert 'contentType="audio/x-mulaw;rate=8000"' in xml
    assert "wss://test.example.com/ws/plivo/media?call_id=abc123&amp;token=" in xml
    assert 'statusCallbackUrl="https://test.example.com/api/webhooks/plivo/stream-status?call_id=abc123"' in xml
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml.split("?>", 1)[1])
    url = root.find("Stream").text
    token = url.split("token=")[1]
    assert verify_stream_token("abc123", token)
    assert not verify_stream_token("other", token)


def test_stream_token_is_hmac():
    assert sign_stream_token("a") != sign_stream_token("b")
    assert not verify_stream_token("a", None)


async def test_plivo_outbound_uses_sdk_with_correct_urls(monkeypatch):
    captured = {}

    class FakeCalls:
        def create(self, **kw):
            captured.update(kw)
            return type("R", (), {"request_uuid": "req-uuid-1", "message": "call fired"})()

    p = PlivoService(settings)
    p._client = type("C", (), {"calls": FakeCalls()})()
    res = await p.make_outbound_call("cid1", "+919876543210")
    assert res.request_uuid == "req-uuid-1"
    assert captured["from_"] == "+918035000000" and captured["to_"] == "+919876543210"
    assert captured["answer_url"] == "https://test.example.com/api/webhooks/plivo/answer?call_id=cid1"
    assert captured["hangup_url"] == captured["ring_url"] == "https://test.example.com/api/webhooks/plivo/status?call_id=cid1"
    assert captured["time_limit"] == settings.MAX_CALL_DURATION_SECONDS


async def test_plivo_not_configured(monkeypatch):
    from app.services.plivo_service import PlivoError

    monkeypatch.setattr(settings, "PLIVO_AUTH_ID", "")
    with pytest.raises(PlivoError) as ei:
        await PlivoService(settings).make_outbound_call("c", "+919876543210")
    assert ei.value.kind == "not_configured"
