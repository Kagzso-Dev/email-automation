"""Plivo HTTP webhooks (form-encoded POST). Signatures are validated with
X-Plivo-Signature-V3 when PLIVO_VALIDATE_SIGNATURE=true (default)."""
from __future__ import annotations

from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import call_context, get_logger
from app.core.security import rate_limit, validate_plivo_signature
from app.db import repositories as repo
from app.db.database import get_db
from app.services import call_service

log = get_logger("webhooks")
router = APIRouter(prefix="/api/webhooks/plivo", tags=["webhooks"], dependencies=[Depends(rate_limit(600))])

XML = "application/xml"


async def _verified_params(request: Request) -> Dict[str, str]:
    form = await request.form()
    params = {k: str(v) for k, v in form.items()}
    if not validate_plivo_signature(request, params):
        log.warning("Rejected Plivo webhook %s: invalid signature", request.url.path)
        raise HTTPException(403, "Invalid signature")
    return params


@router.post("/answer")
async def plivo_answer(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    params = await _verified_params(request)
    xml = await call_service.handle_answer(db, call_id, params)
    return Response(content=xml, media_type=XML)


@router.post("/status")
async def plivo_status(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    """Receives Plivo ring_url and hangup_url callbacks."""
    params = await _verified_params(request)
    await call_service.handle_status(db, call_id, params)
    return Response(status_code=200)


@router.post("/machine")
async def plivo_machine_detection(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    """Plivo machine_detection_url callback (voicemail detection)."""
    params = await _verified_params(request)
    await call_service.handle_machine_detection(db, call_id, params)
    return Response(status_code=200)


@router.post("/stream-status")
async def plivo_stream_status(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    """Stream statusCallbackUrl (connected / stopped / failed / timeout)."""
    params = await _verified_params(request)
    call = await call_service.find_call(db, call_id, params)
    if call is not None:
        with call_context(call.id):
            payload = call_service.safe_params(params) or {k: v[:100] for k, v in list(params.items())[:10]}
            await repo.add_event(db, call.id, "plivo:stream_status", payload)
            log.info("Stream status callback: %s", payload.get("Event") or payload.get("Status") or "?")
    return Response(status_code=200)
