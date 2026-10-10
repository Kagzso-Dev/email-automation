"""Cartesia text-to-speech.

Verified against https://docs.cartesia.ai/api-reference/tts/bytes and
https://docs.cartesia.ai/api-reference/tts/websocket (Cartesia-Version 2026-08-14):

* REST  : POST https://api.cartesia.ai/tts/bytes
          headers  Authorization: Bearer <key>, Cartesia-Version: <version>
* WS    : wss://api.cartesia.ai/tts/websocket?cartesia_version=<version>
          header   X-API-Key: <key>
          request  {model_id, transcript, voice: {id}, output_format, language,
                    context_id, continue, max_buffer_delay_ms}
          replies  {"type": "chunk", "data": <b64>} ... {"type": "done"} | {"type": "error", ...}
          cancel   {"context_id": ..., "cancel": true}

We request raw pcm_mulaw @ 8000 Hz - exactly what the Plivo stream plays -
so no transcoding is needed on the hot path.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import uuid
from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional
from urllib.parse import urlencode

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger

log = get_logger("tts.cartesia")

PLIVO_OUTPUT_FORMAT = {"container": "raw", "encoding": "pcm_mulaw", "sample_rate": 8000}

# ---------------------------------------------------------------------------
# Pronunciation fixes applied to text right before speech (transcripts keep the
# real spelling). "Kagzso" must be spoken as "Kexo".
# ---------------------------------------------------------------------------
BRAND_SPOKEN = {"ta": "கெக்ஸோ", "default": "Kexo"}
_BRAND_LATIN = re.compile(r"kagz?so|kexo", re.IGNORECASE)
# Tamil spellings the LLM may produce: காக்ஸோ, கேக்சோ, காக்ஸ்ஸோ, காக்ஜ்ஸோ, கெக்ஸோ ...
_BRAND_TAMIL = re.compile(r"க[ாேெ]?க்(?:ஸ்ஸ|ஸ|ச|ஜ்ஸ|ஜ்ச)[ோொ]")


def brand_spoken(language: Optional[str]) -> str:
    code = (language or "").split("-")[0].lower()
    return BRAND_SPOKEN.get(code, BRAND_SPOKEN["default"])


_BRAND_WEBSITE = re.compile(r"(?:https?://)?(?:www\.)?(?:kagz?so|kexo|கெக்ஸோ)\.com", re.IGNORECASE)


def apply_pronunciations(text: str, language: Optional[str]) -> str:
    spoken = brand_spoken(language)
    text = _BRAND_WEBSITE.sub(f"{spoken} dot com", text)
    return _BRAND_TAMIL.sub(spoken, _BRAND_LATIN.sub(spoken, text))


class TTSError(Exception):
    def __init__(self, kind: str, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.kind = kind  # auth | rate_limit | timeout | invalid_request | provider | not_configured
        self.status_code = status_code


class TTSStream(ABC):
    """One streamed utterance: push text incrementally, pull audio as it is generated."""

    @abstractmethod
    async def send_text(self, text: str) -> None: ...

    @abstractmethod
    async def end_input(self) -> None: ...

    @abstractmethod
    def audio(self) -> AsyncIterator[bytes]: ...

    @abstractmethod
    async def cancel(self) -> None: ...

    @abstractmethod
    async def aclose(self) -> None: ...


class TTSProvider(ABC):
    name = "base"

    @abstractmethod
    async def synthesize(self, text: str) -> bytes:
        """Full utterance -> mu-law 8 kHz bytes."""

    @abstractmethod
    async def open_stream(self) -> TTSStream:
        """Open a streaming session (connect early to hide handshake latency)."""

    async def stream_synthesize(self, text: str) -> AsyncIterator[bytes]:
        stream = await self.open_stream()
        try:
            await stream.send_text(text)
            await stream.end_input()
            async for chunk in stream.audio():
                yield chunk
        finally:
            await stream.aclose()

    async def aclose(self) -> None:  # pragma: no cover
        return None


def _http_error(status: int, detail: str) -> TTSError:
    if status in (401, 403):
        return TTSError("auth", f"Cartesia authentication failed ({status})", status)
    if status == 429:
        return TTSError("rate_limit", "Cartesia rate limit exceeded", status)
    if status in (400, 404, 422):
        return TTSError("invalid_request", f"Cartesia rejected the request ({status}): {detail[:200]}", status)
    return TTSError("provider", f"Cartesia provider error ({status}): {detail[:200]}", status)


class CartesiaTTS(TTSProvider):
    name = "cartesia"

    def __init__(self, cfg: Optional[Settings] = None, voice_id: Optional[str] = None,
                 client: Optional[httpx.AsyncClient] = None):
        self.cfg = cfg or default_settings
        self.voice_id = voice_id or self.cfg.CARTESIA_VOICE_ID
        self._client = client or httpx.AsyncClient(base_url=self.cfg.CARTESIA_BASE_URL, timeout=httpx.Timeout(20.0, connect=5.0))

    def _check(self) -> str:
        key = self.cfg.CARTESIA_API_KEY.get_secret_value()
        if not key or not self.voice_id:
            raise TTSError("not_configured", "CARTESIA_API_KEY / CARTESIA_VOICE_ID not set")
        return key

    def _base_request(self) -> dict:
        req = {
            "model_id": self.cfg.CARTESIA_TTS_MODEL,
            "voice": {"id": self.voice_id},
            "output_format": dict(PLIVO_OUTPUT_FORMAT),
            "language": self.cfg.CARTESIA_LANGUAGE,
        }
        if self.cfg.CARTESIA_SPEED != 1.0:
            req["generation_config"] = {"speed": self.cfg.CARTESIA_SPEED}
        return req

    async def synthesize(self, text: str) -> bytes:
        key = self._check()
        body = {**self._base_request(), "transcript": apply_pronunciations(text, self.cfg.CARTESIA_LANGUAGE)}
        try:
            resp = await self._client.post(
                "/tts/bytes",
                headers={"Authorization": f"Bearer {key}", "Cartesia-Version": self.cfg.CARTESIA_VERSION},
                json=body,
            )
        except httpx.TimeoutException:
            raise TTSError("timeout", "Cartesia request timed out") from None
        except httpx.HTTPError as exc:
            raise TTSError("provider", f"Cartesia connection error: {type(exc).__name__}") from None
        if resp.status_code != 200:
            raise _http_error(resp.status_code, resp.text)
        return resp.content

    async def open_stream(self) -> "CartesiaStream":
        key = self._check()
        stream = CartesiaStream(self, key)
        await stream.connect()
        return stream

    async def aclose(self) -> None:
        await self._client.aclose()


class CartesiaStream(TTSStream):
    END_TIMEOUT_SECONDS = 10.0

    def __init__(self, tts: CartesiaTTS, key: str):
        self.tts = tts
        self._key = key
        self.context_id = uuid.uuid4().hex
        self._ws = None
        self._closed = False

    async def connect(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        url = f"{self.tts.cfg.CARTESIA_WS_URL}?{urlencode({'cartesia_version': self.tts.cfg.CARTESIA_VERSION})}"
        try:
            self._ws = await asyncio.wait_for(
                connect(url, additional_headers={"X-API-Key": self._key}, max_size=None, open_timeout=5),
                timeout=6,
            )
        except InvalidStatus as exc:
            raise _http_error(exc.response.status_code, "websocket handshake rejected") from None
        except (asyncio.TimeoutError, OSError) as exc:
            raise TTSError("timeout" if isinstance(exc, asyncio.TimeoutError) else "provider",
                           f"Cartesia websocket connect failed: {type(exc).__name__}") from None

    async def _send(self, payload: dict) -> None:
        if self._ws is None or self._closed:
            raise TTSError("provider", "Cartesia stream is closed")
        await self._ws.send(json.dumps(payload))

    async def send_text(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        await self._send({
            **self.tts._base_request(),
            # trailing space keeps word spacing between streamed chunks
            "transcript": apply_pronunciations(text, self.tts.cfg.CARTESIA_LANGUAGE) + " ",
            "context_id": self.context_id,
            "continue": True,
            # We push whole sentences, so don't let Cartesia wait for more text.
            "max_buffer_delay_ms": 0,
        })

    async def end_input(self) -> None:
        await self._send({
            **self.tts._base_request(),
            "transcript": "",
            "context_id": self.context_id,
            "continue": False,
        })

    async def audio(self) -> AsyncIterator[bytes]:
        assert self._ws is not None
        from websockets.exceptions import ConnectionClosed

        while True:
            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=self.END_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                raise TTSError("timeout", "Cartesia stopped sending audio") from None
            except ConnectionClosed:
                return
            msg = json.loads(raw)
            if msg.get("context_id") not in (None, self.context_id):
                continue
            mtype = msg.get("type")
            if mtype == "chunk" and msg.get("data"):
                yield base64.b64decode(msg["data"])
            elif mtype == "done" or msg.get("done") is True:
                return
            elif mtype == "error":
                status = int(msg.get("status_code") or 500)
                raise _http_error(status, str(msg.get("message") or msg.get("title") or msg.get("error") or ""))

    async def cancel(self) -> None:
        try:
            await self._send({"context_id": self.context_id, "cancel": True})
        except Exception:
            pass

    async def aclose(self) -> None:
        if self._ws is not None and not self._closed:
            self._closed = True
            try:
                await self._ws.close()
            except Exception:
                pass


def create_tts_provider(name: str = "cartesia", cfg: Optional[Settings] = None, voice_id: Optional[str] = None) -> TTSProvider:
    if name.lower() == "cartesia":
        return CartesiaTTS(cfg, voice_id=voice_id)
    raise ValueError(f"Unsupported TTS provider: {name}")
