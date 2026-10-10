from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.logging import get_logger
from app.db.database import check_database
from app.services.session_store import get_session_store

router = APIRouter(tags=["health"])
log = get_logger("health")


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: dependencies reachable + providers configured. Never returns secret values."""

    try:
        await asyncio.wait_for(check_database(), timeout=3)
        mysql_status = "ok"
    except Exception as exc:
        log.warning("MySQL readiness check failed: %s", type(exc).__name__)
        mysql_status = "error"

    def c(ok: bool) -> str:
        return "configured" if ok else "missing"

    providers = {
        "telephony": c(settings.telephony_configured()),
        "public_base_url": c(settings.PUBLIC_BASE_URL.startswith("https://")),
        "sarvam": c(settings.sarvam_configured()),
        "cartesia": c(settings.cartesia_configured()),
        "llm": c(settings.llm_configured()),
    }
    is_ready = mysql_status == "ok" and all(v == "configured" for v in providers.values())
    body = {
        "status": "ready" if is_ready else "not_ready",
        "mysql": mysql_status,
        "active_calls": get_session_store().active_count(),
        "providers": providers,
        "telephony_provider": settings.telephony_provider,
        "llm_provider": settings.LLM_PROVIDER,
    }
    return JSONResponse(body, status_code=200 if is_ready else 503)
