"""Temporary real-time call state, held in process memory.

MySQL is the source of truth; this store only holds hot, short-lived state
(session, stream id, conversation state, audio/processing state) for calls
handled by this process. Entries are removed when a call's media stream
closes, and stale entries (e.g. calls that were never answered) expire after
SESSION_TTL_SECONDS.

Run a single uvicorn worker: live call sessions are per-process.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings as default_settings


class SessionStore:
    def __init__(self, ttl_seconds: int = 7200):
        self.ttl = ttl_seconds
        # call_id -> (last_update_monotonic, fields, history)
        self._data: Dict[str, Tuple[float, Dict[str, str], List[Dict[str, str]]]] = {}

    def _entry(self, call_id: str) -> Tuple[float, Dict[str, str], List[Dict[str, str]]]:
        self._purge_expired()
        _, fields, history = self._data.get(call_id, (0.0, {}, []))
        entry = (time.monotonic(), fields, history)
        self._data[call_id] = entry
        return entry

    def _purge_expired(self) -> None:
        cutoff = time.monotonic() - self.ttl
        for call_id in [k for k, (ts, _, _) in self._data.items() if ts < cutoff]:
            del self._data[call_id]

    async def set_fields(self, call_id: str, **fields: Any) -> None:
        _, current, _ = self._entry(call_id)
        current.update({k: "" if v is None else str(v) for k, v in fields.items()})

    async def get_session(self, call_id: str) -> Dict[str, str]:
        entry = self._data.get(call_id)
        return dict(entry[1]) if entry else {}

    async def append_history(self, call_id: str, role: str, content: str) -> None:
        _, _, history = self._entry(call_id)
        history.append({"role": role, "content": content})

    async def get_history(self, call_id: str) -> List[Dict[str, str]]:
        entry = self._data.get(call_id)
        return list(entry[2]) if entry else []

    async def delete(self, call_id: str) -> None:
        self._data.pop(call_id, None)

    def active_count(self) -> int:
        self._purge_expired()
        return len(self._data)


_store: Optional[SessionStore] = None


def get_session_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore(default_settings.SESSION_TTL_SECONDS)
    return _store


def set_session_store(store: Optional[SessionStore]) -> None:
    global _store
    _store = store
