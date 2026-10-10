"""Twilio HTTP webhooks (form-encoded POST), validated with X-Twilio-Signature.

Twilio's parameter names are translated to the provider-neutral form used by
call_service (CallUUID / CallStatus / Event / Duration / Machine).
"""
from __future__ import annotations

from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import call_context, get_logger
from app.core.security import rate_limit, validate_twilio_signature
from app.db import repositories as repo
from app.db.database import get_db
from app.services import call_service

log = get_logger("webhooks.twilio")
router = APIRouter(prefix="/api/webhooks/twilio", tags=["webhooks"], dependencies=[Depends(rate_limit(600))])

XML = "application/xml"
FINAL_STATUSES = {"completed", "busy", "failed", "no-answer", "canceled"}
MACHINE_ANSWERS = {"machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax"}


async def _verified_params(request: Request) -> Dict[str, str]:
    form = await request.form()
    params = {k: str(v) for k, v in form.items()}
    if not validate_twilio_signature(request, params):
        log.warning("Rejected Twilio webhook %s: invalid signature", request.url.path)
        raise HTTPException(403, "Invalid signature")
    return params


def translate_status(params: Dict[str, str]) -> Dict[str, str]:
    """Twilio status callback -> provider-neutral params for call_service.handle_status."""
    status = (params.get("CallStatus") or "").lower()
    out = {"CallUUID": params.get("CallSid", ""), "Direction": params.get("Direction", "")}
    if status == "ringing":
        out.update(Event="Ring", CallStatus="ringing")
    elif status in FINAL_STATUSES:
        out.update(Event="Hangup", CallStatus="cancel" if status == "canceled" else status)
        if params.get("CallDuration", "").isdigit():
            out["Duration"] = params["CallDuration"]
        if params.get("SipResponseCode"):
            out["HangupCause"] = f"SIP {params['SipResponseCode']}"
    else:  # initiated / in-progress: recorded as an event only
        out.update(Event=status or "status", CallStatus=status)
    return {k: v for k, v in out.items() if v}


@router.post("/voice")
async def twilio_voice(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    """Twilio requests this when the outbound call is answered; returns <Connect><Stream> TwiML."""
    params = await _verified_params(request)
    neutral = {"CallUUID": params.get("CallSid", ""), "CallStatus": params.get("CallStatus", ""), "Direction": params.get("Direction", "")}
    xml = await call_service.handle_answer(db, call_id, {k: v for k, v in neutral.items() if v})
    return Response(content=xml, media_type=XML)


@router.post("/status")
async def twilio_status(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    params = await _verified_params(request)
    await call_service.handle_status(db, call_id, translate_status(params))
    return Response(status_code=204)


@router.post("/amd")
async def twilio_amd(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    """Async answering-machine detection result (AnsweredBy)."""
    params = await _verified_params(request)
    answered_by = (params.get("AnsweredBy") or "").lower()
    neutral = {"CallUUID": params.get("CallSid", ""), "Machine": "true" if answered_by in MACHINE_ANSWERS else "false"}
    await call_service.handle_machine_detection(db, call_id, neutral)
    return Response(status_code=204)


@router.post("/stream-status")
async def twilio_stream_status(request: Request, call_id: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)) -> Response:
    params = await _verified_params(request)
    call = await call_service.find_call(db, call_id, {"CallUUID": params.get("CallSid", "")})
    if call is not None:
        with call_context(call.id):
            payload = {k: params[k][:200] for k in ("StreamSid", "StreamEvent", "StreamError") if k in params}
            await repo.add_event(db, call.id, "twilio:stream_status", payload)
            log.info("Stream status callback: %s", payload.get("StreamEvent", "?"))
    return Response(status_code=204)
