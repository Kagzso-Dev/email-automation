"""Security helpers: API-key auth, rate limiting, Plivo webhook signature
validation and signed media-stream tokens."""
from __future__ import annotations

import hashlib
import hmac
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Mapping, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("security")

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: Optional[str] = Depends(_api_key_header)) -> None:
    """Protects cost-incurring / admin APIs. Disabled (503) if ADMIN_API_KEY is unset."""
    expected = settings.ADMIN_API_KEY.get_secret_value()
    if len(expected) < 16:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ADMIN_API_KEY is not configured on the server")
    if not api_key or not hmac.compare_digest(api_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing X-API-Key")


async def require_dev_environment() -> None:
    """Development-only endpoints are hidden in production."""
    if settings.is_production:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")


# ---------------------------------------------------------------------------
# Rate limiting (in-process fixed window per client IP + route).
# Good enough for a single uvicorn worker; use a shared store when scaling out.
# ---------------------------------------------------------------------------
class RateLimiter:
    def __init__(self, limit: int, window_seconds: int = 60):
        self.limit = limit
        self.window = window_seconds
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, key: str) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True

    def reset(self) -> None:
        self._hits.clear()


_limiters: Dict[int, RateLimiter] = {}


def rate_limit(per_minute: Optional[int] = None):
    limit = per_minute or settings.RATE_LIMIT_PER_MINUTE

    async def _dep(request: Request) -> None:
        limiter = _limiters.setdefault(limit, RateLimiter(limit))
        client = request.client.host if request.client else "unknown"
        if not limiter.check(f"{client}:{request.url.path}"):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Rate limit exceeded")

    return _dep


def reset_rate_limits() -> None:
    for limiter in _limiters.values():
        limiter.reset()


# ---------------------------------------------------------------------------
# Plivo webhook signature (V3). Plivo signs: full URL + sorted POST params +
# nonce with HMAC-SHA256 using the Auth Token. We use the official SDK helper.
# ---------------------------------------------------------------------------
def public_url_for(request: Request) -> str:
    """Reconstruct the public URL Plivo called (behind ngrok the local URL differs)."""
    base = settings.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    url = base + request.url.path
    if request.url.query:
        url += "?" + request.url.query
    return url


def validate_plivo_signature(request: Request, params: Mapping[str, str]) -> bool:
    if not settings.PLIVO_VALIDATE_SIGNATURE:
        return True
    signature = request.headers.get("X-Plivo-Signature-V3")
    nonce = request.headers.get("X-Plivo-Signature-V3-Nonce")
    token = settings.PLIVO_AUTH_TOKEN.get_secret_value()
    if not (signature and nonce and token):
        return False
    try:
        from plivo.utils import validate_v3_signature

        return bool(
            validate_v3_signature(request.method, public_url_for(request), nonce, token, signature, dict(params))
        )
    except Exception as exc:  # never let validation crash the webhook
        log.warning("Plivo signature validation error: %s", type(exc).__name__)
        return False


def validate_twilio_signature(request: Request, params: Mapping[str, str]) -> bool:
    """X-Twilio-Signature: HMAC-SHA1 over the full URL + sorted POST params (official SDK helper)."""
    if not settings.TWILIO_VALIDATE_SIGNATURE:
        return True
    signature = request.headers.get("X-Twilio-Signature")
    token = settings.TWILIO_AUTH_TOKEN.get_secret_value()
    if not (signature and token):
        return False
    try:
        from twilio.request_validator import RequestValidator

        return bool(RequestValidator(token).validate(public_url_for(request), dict(params), signature))
    except Exception as exc:
        log.warning("Twilio signature validation error: %s", type(exc).__name__)
        return False


# ---------------------------------------------------------------------------
# Media stream token: HMAC(call_id) so only Plivo (which got the URL from our
# signed answer XML) can open the media WebSocket for a given call.
# ---------------------------------------------------------------------------
def sign_stream_token(call_id: str) -> str:
    key = settings.APP_SECRET_KEY.get_secret_value().encode()
    return hmac.new(key, f"stream:{call_id}".encode(), hashlib.sha256).hexdigest()


def verify_stream_token(call_id: str, token: Optional[str]) -> bool:
    if not token or len(settings.APP_SECRET_KEY.get_secret_value()) < 32:
        return False
    return hmac.compare_digest(sign_stream_token(call_id), token)
