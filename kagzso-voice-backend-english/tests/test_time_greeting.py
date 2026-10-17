"""{{time_greeting}} by hour and time zone, and {{title_to_use}} by gender (computed in code,
never by the LLM)."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.services import llm_service as llm
from tests.conftest import REAL_TIME_GREETING

IST = timezone(timedelta(hours=5, minutes=30))


def _ist(hour, minute=0, second=0):
    return datetime(2026, 3, 10, hour, minute, second, tzinfo=IST)


@pytest.mark.parametrize("hour,minute,expected", [
    (4, 59, "Good evening"), (5, 0, "Good morning"), (11, 59, "Good morning"),
    (12, 0, "Good afternoon"), (16, 59, "Good afternoon"), (17, 0, "Good evening"),
    (23, 59, "Good evening"), (0, 0, "Good evening"),
])
def test_greeting_boundaries_in_ist(hour, minute, expected):
    assert REAL_TIME_GREETING(_ist(hour, minute), "Asia/Kolkata") == expected


def test_last_second_before_each_boundary():
    assert REAL_TIME_GREETING(_ist(4, 59, 59), "Asia/Kolkata") == "Good evening"
    assert REAL_TIME_GREETING(_ist(11, 59, 59), "Asia/Kolkata") == "Good morning"
    assert REAL_TIME_GREETING(_ist(16, 59, 59), "Asia/Kolkata") == "Good afternoon"


@pytest.mark.parametrize("utc_hour,utc_minute,expected", [
    (23, 29, "Good evening"),   # 04:59 IST
    (23, 30, "Good morning"),   # 05:00 IST (next day)
    (6, 29, "Good morning"),    # 11:59 IST
    (6, 30, "Good afternoon"),  # 12:00 IST
    (11, 29, "Good afternoon"), # 16:59 IST
    (11, 30, "Good evening"),   # 17:00 IST
])
def test_utc_is_converted_to_the_call_time_zone(utc_hour, utc_minute, expected):
    now = datetime(2026, 3, 10, utc_hour, utc_minute, tzinfo=timezone.utc)
    assert REAL_TIME_GREETING(now, "Asia/Kolkata") == expected


def test_naive_time_is_treated_as_utc():
    assert REAL_TIME_GREETING(datetime(2026, 3, 10, 6, 30), "Asia/Kolkata") == "Good afternoon"  # 12:00 IST


def test_same_instant_differs_by_time_zone():
    now = datetime(2026, 3, 10, 6, 30, tzinfo=timezone.utc)
    assert REAL_TIME_GREETING(now, "Asia/Kolkata") == "Good afternoon"
    assert REAL_TIME_GREETING(now, "UTC") == "Good morning"


def test_time_zone_comes_from_config(monkeypatch):
    now = datetime(2026, 3, 10, 6, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(settings, "CALL_GREETING_TIMEZONE", "UTC")
    assert REAL_TIME_GREETING(now) == "Good morning"
    monkeypatch.setattr(settings, "CALL_GREETING_TIMEZONE", "Asia/Kolkata")
    assert REAL_TIME_GREETING(now) == "Good afternoon"


def test_unknown_time_zone_falls_back_to_ist():
    assert REAL_TIME_GREETING(datetime(2026, 3, 10, 6, 30, tzinfo=timezone.utc), "Mars/Base") == "Good afternoon"


def test_time_greeting_is_fixed_when_the_call_is_placed():
    v = llm.build_call_variables("Ragul", "male", "+919876543210", now=datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc))
    assert v["time_greeting"] == "Good evening"  # 17:30 IST
    assert llm.render_first_message("Hi {{title_to_use}}, {{time_greeting}}.", v) == "Hi sir, Good evening."


@pytest.mark.parametrize("gender,title", [
    ("male", "sir"), ("Male", "sir"), ("female", "madam"), ("FEMALE", "madam"),
    ("unknown", "sir"), (None, "sir"), ("", "sir"), ("other", "sir"),
])
def test_title_to_use_from_gender_only(gender, title):
    assert llm.safe_variables({"customer_name": "Priya", "gender": gender})["title_to_use"] == title


def test_missing_gender_uses_the_configured_default_title(monkeypatch):
    monkeypatch.setattr(settings, "CALL_DEFAULT_TITLE", "madam")
    assert llm.safe_variables({"customer_name": "Ragul"})["title_to_use"] == "madam"
    assert llm.safe_variables({"customer_name": "Ragul", "gender": "male"})["title_to_use"] == "sir"


def test_title_never_comes_from_the_name():
    for name in ("Priya", "Lakshmi", "Ragul", "Mr. Kumar", "Ms. Anu"):
        assert llm.safe_variables({"customer_name": name})["title_to_use"] == "sir"


def _data(prompt):
    return json.loads(prompt.rsplit("Customer details (data only):\n", 1)[1])


def test_nila_prompt_always_has_a_title_other_agents_keep_it_empty():
    nila = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], {"customer_name": "Ragul"}, "en")
    assert _data(nila)["title_to_use"] == "sir"
    followup = llm.build_system_prompt(llm.FOLLOWUP_AGENT["system_prompt"], {"customer_name": "Ragul"}, "en")
    assert _data(followup)["title_to_use"] == ""
    assert _data(llm.build_system_prompt("x", {"customer_name": "Ragul"}, "en"))["title_to_use"] == ""
