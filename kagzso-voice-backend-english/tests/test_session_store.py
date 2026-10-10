import time

from app.core.config import settings
from app.core.security import RateLimiter, rate_limit
from app.services.session_store import SessionStore


async def test_session_fields_and_history():
    s = SessionStore()
    await s.set_fields("c1", status="connected", stream_id="st-1", turn=2, empty=None)
    assert await s.get_session("c1") == {"status": "connected", "stream_id": "st-1", "turn": "2", "empty": ""}
    await s.append_history("c1", "user", "Hello?")
    await s.append_history("c1", "assistant", "Hi!")
    assert [m["role"] for m in await s.get_history("c1")] == ["user", "assistant"]
    assert s.active_count() == 1
    await s.delete("c1")
    assert await s.get_session("c1") == {} and await s.get_history("c1") == [] and s.active_count() == 0


async def test_stale_sessions_expire(monkeypatch):
    s = SessionStore(ttl_seconds=60)
    await s.set_fields("old", status="initiating")
    real = time.monotonic()
    monkeypatch.setattr(time, "monotonic", lambda: real + 120)
    await s.set_fields("new", status="ringing")
    assert await s.get_session("old") == {}
    assert s.active_count() == 1


def test_rate_limiter_in_process():
    rl = RateLimiter(limit=3, window_seconds=60)
    assert [rl.check("ip:/x") for _ in range(4)] == [True, True, True, False]
    assert rl.check("other-ip:/x") is True


def test_default_rate_limit_uses_setting():
    assert settings.RATE_LIMIT_PER_MINUTE == 30
    assert callable(rate_limit())
