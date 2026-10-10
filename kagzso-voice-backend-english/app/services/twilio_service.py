"""Twilio Programmable Voice integration (REST API over httpx).

Verified against the Twilio docs (api_v2010 CreateCall / UpdateCall, TwiML <Stream>,
Media Streams WebSocket messages):

* Outbound call : POST /2010-04-01/Accounts/{AccountSid}/Calls.json  (form-encoded)
                  To, From, Url (TwiML on answer), StatusCallback + StatusCallbackEvent,
                  TimeLimit, Timeout, MachineDetection=Enable + AsyncAmd=true +
                  AsyncAmdStatusCallback   -> {"sid": "CA...", "status": "queued", ...}
* Hangup        : POST /2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json  Status=completed
* Answer TwiML  : <Connect><Stream url="wss://..."><Parameter .../></Stream></Connect>
                  (bidirectional; the Stream url must NOT contain a query string, so the
                  call id + signed token travel as <Parameter> values -> start.customParameters)
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import urlencode
from xml.sax.saxutils import quoteattr

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger
from app.core.security import sign_stream_token
from app.services.plivo_service import OutboundCallResult, TelephonyError

log = get_logger("twilio")

API_BASE = "https://api.twilio.com/2010-04-01"


def _error(resp: httpx.Response) -> TelephonyError:
    try:
        body = resp.json()
        detail = f"{body.get('code')}: {body.get('message')}"
    except ValueError:
        detail = resp.text[:200]
    if resp.status_code in (401, 403):
        return TelephonyError("auth", f"Twilio authentication failed ({resp.status_code})")
    if resp.status_code in (400, 404, 422):
        return TelephonyError("invalid_request", f"Twilio rejected the request: {detail[:300]}")
    return TelephonyError("provider", f"Twilio error ({resp.status_code}): {detail[:300]}")


class TwilioService:
    name = "twilio"

    def __init__(self, cfg: Optional[Settings] = None, client: Optional[httpx.AsyncClient] = None):
        self.cfg = cfg or default_settings
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))

    def _auth(self) -> httpx.BasicAuth:
        if not self.cfg.twilio_configured():
            raise TelephonyError("not_configured", "Twilio credentials are not configured")
        return httpx.BasicAuth(self.cfg.TWILIO_ACCOUNT_SID, self.cfg.TWILIO_AUTH_TOKEN.get_secret_value())

    async def _post(self, path: str, data) -> dict:
        auth = self._auth()
        if isinstance(data, list):  # [(key, value), ...] -> {key: [values]} (repeated form fields)
            merged: dict = {}
            for k, v in data:
                merged.setdefault(k, []).append(v)
            data = {k: v if len(v) > 1 else v[0] for k, v in merged.items()}
        url = f"{API_BASE}/Accounts/{self.cfg.TWILIO_ACCOUNT_SID}{path}"
        try:
            resp = await self._client.post(url, data=data, auth=auth)
        except httpx.HTTPError as exc:
            raise TelephonyError("provider", f"Twilio connection error: {type(exc).__name__}") from None
        if resp.status_code not in (200, 201):
            raise _error(resp)
        return resp.json()

    # ---------------------- URLs ----------------------
    def _url(self, path: str, **params: str) -> str:
        if not self.cfg.PUBLIC_BASE_URL:
            raise TelephonyError("not_configured", "PUBLIC_BASE_URL is not set (Twilio cannot reach your webhooks)")
        q = f"?{urlencode(params)}" if params else ""
        return f"{self.cfg.PUBLIC_BASE_URL}{path}{q}"

    def answer_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/twilio/voice", call_id=call_id)

    def status_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/twilio/status", call_id=call_id)

    def amd_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/twilio/amd", call_id=call_id)

    def stream_status_url(self, call_id: str) -> str:
        return self._url("/api/webhooks/twilio/stream-status", call_id=call_id)

    def media_ws_url(self) -> str:
        return f"{self.cfg.public_ws_base_url}/ws/twilio/media"  # no query string allowed

    # ---------------------- API calls ----------------------
    async def make_outbound_call(self, call_id: str, to_number: str) -> OutboundCallResult:
        data = [
            ("To", to_number),
            ("From", self.cfg.TWILIO_FROM_NUMBER),
            ("Url", self.answer_url(call_id)),
            ("Method", "POST"),
            ("StatusCallback", self.status_url(call_id)),
            ("StatusCallbackMethod", "POST"),
            ("TimeLimit", str(self.cfg.MAX_CALL_DURATION_SECONDS)),
            ("Timeout", "45"),
        ]
        for event in ("initiated", "ringing", "answered", "completed"):
            data.append(("StatusCallbackEvent", event))  # repeated param, one per event
        if self.cfg.TWILIO_MACHINE_DETECTION:
            data += [
                ("MachineDetection", "Enable"),
                ("AsyncAmd", "true"),
                ("AsyncAmdStatusCallback", self.amd_url(call_id)),
                ("AsyncAmdStatusCallbackMethod", "POST"),
            ]
        try:
            body = await self._post("/Calls.json", data)
        except TelephonyError as exc:
            log.error("Twilio outbound call failed: %s", exc)
            raise
        sid = body.get("sid")
        if not sid:
            raise TelephonyError("provider", "Twilio response did not include a call sid")
        return OutboundCallResult(request_uuid=sid, message=str(body.get("status", "")))

    async def hangup(self, call_sid: str) -> bool:
        try:
            await self._post(f"/Calls/{call_sid}.json", {"Status": "completed"})
            return True
        except TelephonyError as exc:
            log.warning("Twilio hangup failed: %s", exc)
            return False

    async def verify_credentials(self) -> dict:
        auth = self._auth()
        try:
            resp = await self._client.get(f"{API_BASE}/Accounts/{self.cfg.TWILIO_ACCOUNT_SID}.json", auth=auth)
        except httpx.HTTPError as exc:
            raise TelephonyError("provider", f"Twilio connection error: {type(exc).__name__}") from None
        if resp.status_code != 200:
            raise _error(resp)
        body = resp.json()
        return {"account_type": body.get("type"), "account_status": body.get("status")}

    # ---------------------- TwiML ----------------------
    def build_stream_xml(self, call_id: str) -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            "<Response>\n"
            "    <Connect>\n"
            f"        <Stream url={quoteattr(self.media_ws_url())} "
            f"statusCallback={quoteattr(self.stream_status_url(call_id))} statusCallbackMethod=\"POST\">\n"
            f"            <Parameter name=\"call_id\" value={quoteattr(call_id)} />\n"
            f"            <Parameter name=\"token\" value={quoteattr(sign_stream_token(call_id))} />\n"
            "        </Stream>\n"
            "    </Connect>\n"
            "</Response>"
        )

    @staticmethod
    def hangup_xml() -> str:
        return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Hangup/>\n</Response>'

    async def aclose(self) -> None:
        await self._client.aclose()


_twilio: Optional[TwilioService] = None


def get_twilio_service() -> TwilioService:
    global _twilio
    if _twilio is None:
        _twilio = TwilioService()
    return _twilio
