"""Plivo Voice integration (official `plivo` Python SDK, v4.x).

* Outbound call : client.calls.create(from_, to_, answer_url, ring_url, hangup_url, time_limit, ...)
                  -> {"message": "call fired", "request_uuid": ..., "api_id": ...}
* Hangup        : client.calls.delete(call_uuid)
* Answer XML    : <Stream bidirectional="true" keepCallAlive="true"
                          contentType="audio/x-mulaw;rate=8000">wss://...</Stream>

The SDK is synchronous (requests-based), so every call runs in a worker
thread to keep the event loop free.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode
from xml.sax.saxutils import escape, quoteattr

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger
from app.core.security import sign_stream_token

log = get_logger("plivo")

STREAM_CONTENT_TYPE = "audio/x-mulaw;rate=8000"


class TelephonyError(Exception):
    """Raised by any telephony provider (Plivo, Twilio)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # not_configured | auth | invalid_request | provider


PlivoError = TelephonyError


@dataclass
class OutboundCallResult:
    request_uuid: str
    message: str


def _classify(exc: Exception) -> PlivoError:
    name = type(exc).__name__  # plivo.exceptions.*
    if name == "AuthenticationError":
        return PlivoError("auth", "Plivo authentication failed")
    if name in ("ValidationError", "InvalidRequestError", "ResourceNotFoundError"):
        return PlivoError("invalid_request", f"Plivo rejected the request: {str(exc)[:200]}")
    return PlivoError("provider", f"Plivo error ({name})")


class PlivoService:
    name = "plivo"

    def __init__(self, cfg: Optional[Settings] = None):
        self.cfg = cfg or default_settings
        self._client = None

    @property
    def client(self):
        if not self.cfg.plivo_configured():
            raise PlivoError("not_configured", "Plivo credentials are not configured")
        if self._client is None:
            import plivo

            self._client = plivo.RestClient(self.cfg.PLIVO_AUTH_ID, self.cfg.PLIVO_AUTH_TOKEN.get_secret_value())
        return self._client

    # ---------------------- URLs ----------------------
    def _url(self, path: str, **params: str) -> str:
        if not self.cfg.PUBLIC_BASE_URL:
            raise PlivoError("not_configured", "PUBLIC_BASE_URL is not set (Plivo cannot reach your webhooks)")
        q = f"?{urlencode(params)}" if params else ""
        return f"{self.cfg.PUBLIC_BASE_URL}{path}{q}"

    def answer_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/plivo/answer", call_id=call_id)

    def status_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/plivo/status", call_id=call_id)

    def machine_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/plivo/machine", call_id=call_id)

    def stream_status_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/plivo/stream-status", call_id=call_id)

    def media_ws_url(self, call_id: str) -> str:
        q = urlencode({"call_id": call_id, "token": sign_stream_token(call_id)})
        return f"{self.cfg.public_ws_base_url}/ws/plivo/media?{q}"

    # ---------------------- API calls ----------------------
    async def make_outbound_call(self, call_id: str, to_number: str) -> OutboundCallResult:
        client = self.client
        kwargs = dict(
            from_=self.cfg.PLIVO_FROM_NUMBER,
            to_=to_number,
            answer_url=self.answer_url(call_id),
            answer_method="POST",
            ring_url=self.status_url(call_id),
            ring_method="POST",
            hangup_url=self.status_url(call_id),
            hangup_method="POST",
            time_limit=self.cfg.MAX_CALL_DURATION_SECONDS,
            ring_timeout=45,
        )
        if self.cfg.PLIVO_MACHINE_DETECTION:
            # Async detection: the call proceeds normally; Plivo POSTs Machine=true to
            # machine_detection_url if it hears an answering machine.
            kwargs.update(
                machine_detection="true",
                machine_detection_url=self.machine_url(call_id),
                machine_detection_method="POST",
            )
        try:
            resp = await asyncio.to_thread(client.calls.create, **kwargs)
        except Exception as exc:
            err = _classify(exc)
            log.error("Plivo outbound call failed: %s", err)
            raise err from None
        request_uuid = getattr(resp, "request_uuid", None) or (resp.get("request_uuid") if isinstance(resp, dict) else None)
        if isinstance(request_uuid, list):  # multiple destinations return a list
            request_uuid = request_uuid[0]
        if not request_uuid:
            raise PlivoError("provider", "Plivo response did not include request_uuid")
        return OutboundCallResult(request_uuid=str(request_uuid), message=str(getattr(resp, "message", "")))

    async def hangup(self, call_uuid: str) -> bool:
        try:
            await asyncio.to_thread(self.client.calls.delete, call_uuid)
            return True
        except Exception as exc:
            log.warning("Plivo hangup failed: %s", _classify(exc))
            return False

    async def verify_credentials(self) -> dict:
        """Fetch account details - proves the Auth ID/Token pair works. Returns no secrets."""
        try:
            acct = await asyncio.to_thread(self.client.account.get)
        except PlivoError:
            raise
        except Exception as exc:
            raise _classify(exc) from None
        return {"account_type": getattr(acct, "account_type", None)}

    # ---------------------- XML ----------------------
    def build_stream_xml(self, call_id: str) -> str:
        attrs = {
            "bidirectional": "true",
            "keepCallAlive": "true",
            "contentType": STREAM_CONTENT_TYPE,
            "audioTrack": "inbound",
            "streamTimeout": str(self.cfg.MAX_CALL_DURATION_SECONDS + 60),
            "statusCallbackUrl": self.stream_status_url(call_id),
            "statusCallbackMethod": "POST",
        }
        attr_str = " ".join(f"{k}={quoteattr(v)}" for k, v in attrs.items())
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f"<Response>\n    <Stream {attr_str}>{escape(self.media_ws_url(call_id))}</Stream>\n</Response>"
        )

    @staticmethod
    def hangup_xml() -> str:
        return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Hangup/>\n</Response>'


_plivo: Optional[PlivoService] = None


def get_plivo_service() -> PlivoService:
    global _plivo
    if _plivo is None:
        _plivo = PlivoService()
    return _plivo
