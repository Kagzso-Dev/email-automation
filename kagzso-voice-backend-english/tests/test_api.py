from sqlalchemy import text

from app.core.config import settings

PHONE = "+919876543210"


def _outbound(client, auth, **kw):
    body = {"phone_number": PHONE, "contact_name": "Arun", "company_name": "ABC Restaurant", "agent_id": 1, **kw}
    return client.post("/api/calls/outbound", json=body, headers=auth)


# ------------------------------------------------------------ health
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_ready_reports_without_secrets(client):
    r = client.get("/ready")
    body = r.json()
    assert r.status_code == 200, body
    assert body["status"] == "ready" and body["mysql"] == "ok" and body["active_calls"] == 0
    assert "redis" not in body
    assert body["providers"] == {"telephony": "configured", "public_base_url": "configured", "sarvam": "configured",
                                 "tts": "configured", "llm": "configured"}
    for secret in settings.secret_values():
        assert secret not in r.text


def test_ready_flags_missing_provider(client, monkeypatch):
    monkeypatch.setattr(settings, "SARVAM_TTS_SPEAKER", "")
    r = client.get("/ready")
    assert r.status_code == 503 and r.json()["providers"]["tts"] == "missing"


# ------------------------------------------------------------ default agent
def test_default_agent_seeded(client, auth):
    agents = client.get("/api/agents", headers=auth).json()
    assert agents[0]["name"] == "Priya" and "AI calling assistant from Kagzso" in agents[0]["system_prompt"]


# ------------------------------------------------------------ outbound
def test_outbound_requires_api_key(client):
    assert _outbound(client, {}).status_code == 401
    assert _outbound(client, {"X-API-Key": "wrong-key-wrong-key"}).status_code == 401


def test_outbound_validates_phone(client, auth):
    assert _outbound(client, auth, phone_number="98765").status_code == 422
    assert _outbound(client, auth, phone_number="+91123").status_code == 422


def test_outbound_unknown_agent(client, auth):
    assert _outbound(client, auth, agent_id=999).status_code == 404


def test_outbound_success(client, auth, fakes, sync_engine):
    r = _outbound(client, auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True and len(body["call_id"]) == 32
    assert body["provider_call_id"].startswith("req-")
    assert fakes.plivo.placed == [PHONE]
    with sync_engine.connect() as c:
        row = c.execute(text("select status, to_number, variables from calls")).one()
        events = [e[0] for e in c.execute(text("select event_type from call_events order by id"))]
    assert row.status == "initiating" and row.to_number == PHONE
    assert "Arun" in row.variables
    assert events[:3] == ["status:created", "status:initiating", "plivo:call_fired"]
    assert settings.PLIVO_AUTH_TOKEN.get_secret_value() not in r.text


def test_outbound_rejects_dnd(client, auth, sync_engine, fakes):
    assert _outbound(client, auth).status_code == 200
    with sync_engine.begin() as c:
        c.execute(text("update contacts set dnd = 1"))
    r = _outbound(client, auth)
    assert r.status_code == 409 and "Do-Not-Disturb" in r.json()["detail"]
    assert len(fakes.plivo.placed) == 1


def test_outbound_plivo_failure_marks_call_failed(client, auth, fakes, sync_engine):
    fakes.plivo.fail_with = "auth"
    r = _outbound(client, auth)
    assert r.status_code == 502
    with sync_engine.connect() as c:
        assert c.execute(text("select status, outcome from calls")).one() == ("failed", "call_failed")


def test_rate_limit(client, auth):
    codes = [_outbound(client, auth, phone_number=f"+9198765432{i:02d}").status_code for i in range(12)]
    assert 429 in codes


# ------------------------------------------------------------ webhooks
def test_answer_webhook_returns_stream_xml(client, auth, sync_engine):
    call_id = _outbound(client, auth).json()["call_id"]
    r = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}",
                    data={"CallUUID": "plivo-uuid-1", "CallStatus": "in-progress", "Event": "StartApp", "Direction": "outbound"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
    assert "<Stream" in r.text and 'bidirectional="true"' in r.text and f"call_id={call_id}" in r.text
    with sync_engine.connect() as c:
        assert c.execute(text("select status, provider_call_id from calls")).one() == ("answered", "plivo-uuid-1")


def test_answer_unknown_call_hangs_up(client):
    r = client.post("/api/webhooks/plivo/answer?call_id=nope", data={"CallUUID": "x"})
    assert "<Hangup/>" in r.text


def test_status_webhook_ring_and_busy(client, auth, sync_engine):
    call_id = _outbound(client, auth).json()["call_id"]
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}", data={"Event": "Ring", "CallStatus": "ringing", "CallUUID": "u1"})
    with sync_engine.connect() as c:
        assert c.execute(text("select status from calls")).scalar() == "ringing"
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}",
                data={"Event": "Hangup", "CallStatus": "busy", "HangupCauseName": "Busy Line", "Duration": "0", "CallUUID": "u1"})
    with sync_engine.connect() as c:
        row = c.execute(text("select status, outcome, hangup_cause, duration_seconds, ended_at from calls")).one()
    assert row[:4] == ("busy", "busy", "Busy Line", 0) and row.ended_at is not None


def test_status_webhook_no_answer(client, auth, sync_engine):
    call_id = _outbound(client, auth).json()["call_id"]
    client.post(f"/api/webhooks/plivo/status?call_id={call_id}",
                data={"Event": "Hangup", "CallStatus": "no-answer", "HangupCauseName": "No Answer"})
    with sync_engine.connect() as c:
        assert c.execute(text("select status, outcome from calls")).one() == ("no_answer", "no_answer")


def test_webhook_signature_enforced(client, auth, monkeypatch):
    from plivo.utils.signature_v3 import construct_post_url, get_signature_v3

    monkeypatch.setattr(settings, "PLIVO_VALIDATE_SIGNATURE", True)
    call_id = _outbound(client, auth).json()["call_id"]
    url = f"/api/webhooks/plivo/answer?call_id={call_id}"
    params = {"CallUUID": "sig-uuid", "CallStatus": "in-progress"}

    assert client.post(url, data=params).status_code == 403  # unsigned
    bad = {"X-Plivo-Signature-V3": "bad", "X-Plivo-Signature-V3-Nonce": "123"}
    assert client.post(url, data=params, headers=bad).status_code == 403

    nonce = "12345678901234567890"
    full = "https://test.example.com" + url
    base = construct_post_url(full, params).decode()
    sig = get_signature_v3(settings.PLIVO_AUTH_TOKEN.get_secret_value().encode(), base, nonce.encode()).decode()
    good = {"X-Plivo-Signature-V3": sig, "X-Plivo-Signature-V3-Nonce": nonce}
    r = client.post(url, data=params, headers=good)
    assert r.status_code == 200 and "<Stream" in r.text


# ------------------------------------------------------------ dev test endpoints
def test_dev_endpoints_protected(client, auth):
    assert client.post("/api/test/llm", json={"text": "Hello?"}).status_code == 401
    r = client.post("/api/test/llm", json={"text": "Hello?"}, headers=auth)
    assert r.status_code == 200 and r.json()["ok"] and "Priya" in r.json()["reply"]
    assert client.post("/api/test/plivo", headers=auth).json()["ok"] is True
    r = client.post("/api/test/tts", json={"text": "Hello."}, headers=auth)
    assert r.json()["audio_bytes"] > 0
    r = client.post("/api/test/sarvam", json={"text": "Hello."}, headers=auth)
    assert r.json()["audio_source"] == "sarvam_tts" and r.json()["result"]["text"] == "Hello?"
    for secret in settings.secret_values():
        assert secret not in r.text


def test_dev_endpoints_hidden_in_production(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", "production")
    assert client.post("/api/test/llm", json={"text": "x"}, headers=auth).status_code == 404


def test_secrets_redacted_from_logs(caplog):
    import logging

    from app.core.logging import RedactSecretsFilter

    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "token=%s", ("plivo-test-token-abcdef",), None)
    RedactSecretsFilter(settings.secret_values()).filter(rec)
    assert rec.getMessage() == "token=****"
