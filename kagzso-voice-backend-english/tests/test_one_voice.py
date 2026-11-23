"""One voice per call (voice rotation removed 2026-11-20). An AI agent's call speaks only in the voice saved in its AI
Voice settings - else the language's default voice - chosen once when the call is placed and used for the greeting,
every reply, re-ask and the closing, on every call. The removed settings are ignored (and reported at start). The
stock fallback (ratan for a male clone, ishita for a female one) is used only after the chosen voice fails, and then
for the rest of that call. A recording SarvamTTS stands in for Sarvam: no network, no cost, no phone call."""
from __future__ import annotations

import base64
import logging
import time

import httpx
import pytest
from sqlalchemy import text

from app.core import voices
from app.core.config import REMOVED_SETTINGS, Settings, removed_settings_in_use, settings
from app.core.logging import call_context
from app.core.security import reset_rate_limits
from app.services import call_service as cs
from app.services import provider_registry
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError
from tests.test_agent_voice import RecordingSarvamTTS, recorder  # noqa: F401  (pytest fixture)
from tests.test_autonomous_conversation import _converse, _flow
from tests.test_cloned_voice import TA_F, TA_M1, TA_M2, _cfg, _client, _wav
from tests.test_nila_flow import PHONE, _call, _nila_id

OFFERED = ("ishita", "roopa", "ritu", "simran", "shubh", TA_F, TA_M1, TA_M2)


@pytest.fixture
def tamil_voices(fakes, monkeypatch, recorder):  # noqa: F811
    # As the Tamil server's .env.ta: the clones in their slots (that is where a clone's gender comes from).
    slots = {"CALL_LANGUAGE": "ta", "SARVAM_TTS_VOICE_TA_FEMALE": TA_F, "SARVAM_TTS_VOICE_TA_MALE_1": TA_M1,
             "SARVAM_TTS_VOICE_TA_MALE_2": TA_M2}
    monkeypatch.setattr(fakes.tts, "cfg", fakes.tts.cfg.model_copy(update=slots))
    monkeypatch.setattr(voices, "VOICE_IDS", OFFERED)
    monkeypatch.setattr(cs, "SarvamTTS", RecordingSarvamTTS)
    monkeypatch.setattr(provider_registry, "SarvamTTS", RecordingSarvamTTS)  # the stock fallback voice too
    return recorder


def _place_agent(client, auth, flow, flow_id):
    reset_rate_limits()  # many calls in one test: past the API's calls-per-minute limit
    r = client.post("/api/calls/outbound", headers=auth, json={
        "phone_number": PHONE, "customer_name": "Ragul", "gender": "male", "agent_id": _nila_id(client, auth),
        "flow_id": flow_id, "flow_version": 1, "flow": flow})
    assert r.status_code == 200, r.text
    return r.json()["call_id"]


def _call_voices(sync_engine):
    with sync_engine.connect() as c:
        return [r[0] for r in c.execute(text("select voice_id from calls order by created_at, rowid"))]


def _used(log):
    return [e[2].get("voice_id") or e[2].get("speaker") for e in log if e[0] in ("rest", "stream")]


# ------------------------------------------------------------------ the same voice on every call
@pytest.mark.parametrize("saved", ["ritu", "shubh", TA_M1])
def test_an_agents_saved_voice_on_20_calls_in_a_row(client, auth, sync_engine, monkeypatch, tamil_voices, saved):
    flow = {**_flow("ta", monkeypatch), "voice_id": saved}
    for _ in range(20):  # none of them ended: calls at the same time once got other voices (rotation)
        _place_agent(client, auth, flow, "agent_one_voice")
    assert _call_voices(sync_engine) == [saved] * 20


def test_an_agent_with_no_saved_voice_speaks_the_language_default_on_every_call(client, auth, sync_engine, monkeypatch,
                                                                                tamil_voices, caplog):
    monkeypatch.setattr(voices, "DEFAULT_VOICE", TA_F)  # this backend's female voice (its female clone)
    flow = {**_flow("ta", monkeypatch), "voice_id": None}
    with caplog.at_level(logging.INFO):
        for _ in range(20):
            _place_agent(client, auth, flow, "agent_default_voice")
    assert _call_voices(sync_engine) == [TA_F] * 20
    assert f"Call voice: {TA_F} (the language default) - every line of this call" in caplog.text


# ------------------------------------------------------------------ one voice within a call
@pytest.mark.parametrize("saved", ["roopa", None])
def test_every_line_of_a_call_is_one_voice(client, auth, fakes, monkeypatch, tamil_voices, saved):
    monkeypatch.setattr(voices, "DEFAULT_VOICE", "ritu")
    flow = {**_flow("ta", monkeypatch), "voice_id": saved}
    call_id, token = _call(client, auth, gender="male", flow_id=f"agent_lines_{saved}", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "Yes", "Tell me more", "Okay"]
    _converse(client, call_id, token, turns=3)
    used = _used(tamil_voices.log)
    assert len(used) >= 4 and set(used) == {saved or "ritu"}  # greeting, replies, fixed lines: never switched


# ------------------------------------------------------------------ the removed settings
def test_the_removed_rotation_settings_are_ignored_and_reported(tmp_path, monkeypatch, client, auth, sync_engine,
                                                                tamil_voices):
    env = tmp_path / ".env.ta"
    env.write_text("SARVAM_TTS_VOICE_ROTATION=ritu,simran,ishita\nVOICE_ROTATION_MODE=round_robin\n"
                   "SARVAM_TTS_VOICE_TA_MALE_EITHER=true\n", encoding="utf-8")
    loaded = Settings(_env_file=str(env))  # still in a server's file: loads, nothing reads them
    assert not any(hasattr(loaded, name) for name in REMOVED_SETTINGS)
    assert removed_settings_in_use(str(env)) == list(REMOVED_SETTINGS)
    blank = tmp_path / ".env.blank"
    blank.write_text("SARVAM_TTS_VOICE_ROTATION=\nVOICE_ROTATION_MODE=\n", encoding="utf-8")
    assert removed_settings_in_use(str(blank)) == []  # an empty line is not worth a warning
    monkeypatch.setenv("SARVAM_TTS_VOICE_ROTATION", "ritu,simran")
    assert removed_settings_in_use(str(tmp_path / "none")) == ["SARVAM_TTS_VOICE_ROTATION"]  # the environment too
    flow = {**_flow("ta", monkeypatch), "voice_id": "roopa"}
    for _ in range(3):
        _place_agent(client, auth, flow, "agent_env_rotation")
    assert _call_voices(sync_engine) == ["roopa"] * 3  # set or not, every call keeps its agent's voice


def test_a_removed_setting_still_set_is_warned_about_at_start(monkeypatch, caplog):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("SARVAM_TTS_VOICE_ROTATION", "ritu,simran")
    with caplog.at_level(logging.WARNING):
        with TestClient(app):
            pass
    assert "SARVAM_TTS_VOICE_ROTATION is set but no longer exists - ignored" in caplog.text


# ------------------------------------------------------------------ the fallback: only after a failure, then for good
@pytest.mark.parametrize("clone,stock", [(TA_M1, "ratan"), (TA_M2, "ratan"), (TA_F, "ishita")])
async def test_after_a_fallback_the_rest_of_the_call_keeps_the_fallback_voice(monkeypatch, caplog, clone, stock):
    paths = []

    def sarvam(request):
        paths.append(request.url.path)
        if request.url.path == "/voices/clone":
            return httpx.Response(500, json={"error": {"message": "overloaded"}})
        return httpx.Response(200, json={"request_id": "r", "audios": [base64.b64encode(_wav(b"\x01\x02" * 400)).decode()]})

    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg("ta"), voice_id=clone, client=_client(sarvam),
                                                          exact_voice=True))
    assert tts.fallback.voice_id == stock  # the clone's gender: a male clone never falls back to ishita
    opened = []

    async def stock_stream(pace=None):
        opened.append(stock)
        return object()

    monkeypatch.setattr(tts.fallback, "open_stream", stock_stream)
    with call_context("call-123"), caplog.at_level(logging.WARNING):
        for line in ("the greeting", "a reply", "a re-ask", "the closing"):
            await tts.synthesize(line)
        await tts.open_stream()  # the next live reply
    # The clone failed once (its line said again in the stock voice) and was never tried again: 4 lines, 4 stock.
    assert paths == ["/voices/clone"] + ["/text-to-speech"] * 4
    assert opened == [stock]
    assert caplog.text.count("CLONED VOICE FALLBACK (call call-123)") == 1 and f"stock voice {stock}" in caplog.text


def test_a_greeting_that_fell_back_while_ringing_keeps_the_whole_call_on_the_fallback(client, auth, fakes, monkeypatch,
                                                                                      tamil_voices, caplog):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", True)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    failures = {"left": 1}  # the clone fails once (the greeting, rendered while the phone rings), then would work
    real = RecordingSarvamTTS.synthesize

    async def synthesize(self, text_, pace=None):
        if self.cloned and failures["left"]:
            failures["left"] -= 1
            raise TTSError("provider", "Sarvam voice clone error 500", 500)
        return await real(self, text_, pace)

    monkeypatch.setattr(RecordingSarvamTTS, "synthesize", synthesize)
    flow = {**_flow("ta", monkeypatch), "voice_id": TA_M1}
    call_id, token = _call(client, auth, gender="male", flow_id="agent_fell_back", flow_version=1, flow=flow)
    deadline = time.time() + 3
    while not cs.has_greeting_audio(call_id) and time.time() < deadline:
        time.sleep(0.05)
    fakes.stt.replies = ["Hello?", "Yes", "Tell me more", "Okay"]
    with caplog.at_level(logging.WARNING):
        _converse(client, call_id, token, turns=3)
    used = _used(tamil_voices.log)
    assert len(used) >= 4 and set(used) == {"ratan"}  # the greeting and everything after it: the male fallback only
    assert "the greeting was rendered in the fallback voice - the whole call speaks in it" in caplog.text


def test_a_clone_with_no_gender_on_this_backend_is_reported(caplog):
    with caplog.at_level(logging.WARNING):
        wrapped = provider_registry.with_clone_fallback(SarvamTTS(settings, voice_id=TA_M1, exact_voice=True))
    assert isinstance(wrapped, provider_registry.ClonedVoiceFallback)
    assert f"Cloned voice {TA_M1} has no gender on this backend" in caplog.text
