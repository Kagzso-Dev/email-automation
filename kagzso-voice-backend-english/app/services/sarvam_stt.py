"""Sarvam AI speech-to-text (REST).

Verified against https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
    POST https://api.sarvam.ai/speech-to-text   (multipart/form-data)
    header : api-subscription-key: <key>
    fields : file, model (saaras:v3 | saaras:v4), language_code (BCP-47 or "unknown"),
             mode (saaras:v3 only: transcribe | translate | verbatim | translit | codemix)
    200    : {"request_id", "transcript", "language_code", "language_probability"}

The service is isolated behind `STTProvider` so it can be swapped later.
"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Optional, TypedDict

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger

log = get_logger("stt.sarvam")


class STTResult(TypedDict):
    text: str
    language: Optional[str]
    confidence: Optional[float]


class STTError(Exception):
    """Base STT error. `kind` is one of: auth, rate_limit, timeout, invalid_audio, provider, not_configured."""

    def __init__(self, kind: str, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


class STTProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def transcribe(self, audio_data: bytes, filename: str = "audio.wav", content_type: str = "audio/wav") -> STTResult:
        """Transcribe a complete audio file (WAV recommended, 16 kHz)."""

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None


def _error_from_response(resp: httpx.Response) -> STTError:
    code = resp.status_code
    detail = ""
    try:
        body = resp.json()
        err = body.get("error", body) if isinstance(body, dict) else {}
        detail = str(err.get("message") or err.get("code") or "")[:200] if isinstance(err, dict) else ""
    except Exception:
        detail = resp.text[:200]
    if code in (401, 403):
        return STTError("auth", f"Sarvam authentication failed ({code})", code)
    if code == 429:
        return STTError("rate_limit", "Sarvam rate limit exceeded", code)
    if code in (400, 413, 415, 422):
        return STTError("invalid_audio", f"Sarvam rejected the request ({code}): {detail}", code)
    if code == 504:
        return STTError("timeout", "Sarvam gateway timeout", code)
    return STTError("provider", f"Sarvam provider error ({code}): {detail}", code)


class SarvamSTT(STTProvider):
    name = "sarvam"

    def __init__(self, cfg: Optional[Settings] = None, client: Optional[httpx.AsyncClient] = None):
        self.cfg = cfg or default_settings
        self._client = client or httpx.AsyncClient(
            base_url=self.cfg.SARVAM_BASE_URL,
            timeout=httpx.Timeout(self.cfg.SARVAM_TIMEOUT_SECONDS, connect=5.0),
        )

    async def transcribe(self, audio_data: bytes, filename: str = "audio.wav", content_type: str = "audio/wav") -> STTResult:
        key = self.cfg.SARVAM_API_KEY.get_secret_value()
        if not key:
            raise STTError("not_configured", "SARVAM_API_KEY is not set")
        if not audio_data or len(audio_data) < 100:
            raise STTError("invalid_audio", "audio is empty or too short")

        data = {"model": self.cfg.SARVAM_STT_MODEL, "language_code": self.cfg.sarvam_language_code}
        if self.cfg.SARVAM_STT_MODEL.startswith("saaras:v3"):
            data["mode"] = self.cfg.SARVAM_STT_MODE

        last_exc: Optional[STTError] = None
        for attempt in range(2):  # one quick retry on transient failures
            try:
                resp = await self._client.post(
                    "/speech-to-text",
                    headers={"api-subscription-key": key},
                    data=data,
                    files={"file": (filename, audio_data, content_type)},
                )
            except httpx.TimeoutException:
                last_exc = STTError("timeout", "Sarvam request timed out")
            except httpx.HTTPError as exc:
                last_exc = STTError("provider", f"Sarvam connection error: {type(exc).__name__}")
            else:
                if resp.status_code == 200:
                    return self._parse(resp)
                last_exc = _error_from_response(resp)
                if last_exc.kind not in ("rate_limit", "provider", "timeout"):
                    break
            if attempt == 0:
                log.warning("Sarvam STT %s, retrying once", last_exc.kind)
                await asyncio.sleep(0.25)
        assert last_exc is not None
        raise last_exc

    @staticmethod
    def _parse(resp: httpx.Response) -> STTResult:
        try:
            body = resp.json()
        except ValueError:
            raise STTError("provider", "Sarvam returned non-JSON response") from None
        return STTResult(
            text=(body.get("transcript") or "").strip(),
            language=body.get("language_code"),
            confidence=body.get("language_probability"),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def create_stt_provider(name: str = "sarvam", cfg: Optional[Settings] = None) -> STTProvider:
    if name.lower() == "sarvam":
        return SarvamSTT(cfg)
    raise ValueError(f"Unsupported STT provider: {name}")
