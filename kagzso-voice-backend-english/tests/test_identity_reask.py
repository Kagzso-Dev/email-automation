"""A bare "Hello" in answer to "Hi, is this <name>?" is not a yes: the identity
question is asked once more. Spoken names drop standalone initials."""
import time

import pytest

from app.services import llm_service as llm
from app.services.call_service import is_greeting_only
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


@pytest.mark.parametrize("name,spoken", [
    ("Karthick G", "Karthick"), ("R. Karthick", "Karthick"), ("Karthick G.", "Karthick"),
    ("K S Raagul", "Raagul"), ("Ragul", "Ragul"), ("Mary Ann", "Mary Ann"), ("A B", "A B"), (None, ""),
])
def test_spoken_name_drops_initials(name, spoken):
    assert llm.spoken_name(name) == spoken


def test_greeting_uses_spoken_name():
    assert llm.render_first_message(llm.NILA_AGENT["first_message"], {"customer_name": "Karthick G"}) == "Hi, is this Karthick?"
    assert llm.render_first_message(llm.NILA_AGENT["first_message"], {"customer_name": "Ragul"}) == "Hi, is this Ragul?"


@pytest.mark.parametrize("text,expected", [
    ("Hello", True), ("Hello?", True), ("hello hello", True), ("Hi", True), ("Hmm hello", True),
    ("Yes", False), ("Yes, speaking", False), ("Hello, yes", False), ("Who is this?", False), ("", False),
])
def test_is_greeting_only(text, expected):
    assert is_greeting_only(text) is expected


def _converse(client, auth, fakes, replies):
    """Customer says each reply in turn (the first one before the greeting); returns TTS texts per turn."""
    call_id, token = _call(client, auth, customer_name="Karthick G", gender="male")
    fakes.stt.replies = replies
    fakes.llm.reply = "Thank you sir. This is Nila from Kagzso AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in replies:
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _until(ws, "checkpoint")
            time.sleep(0.5)  # let playback finish so the next words aren't treated as talking over Nila
    return [s.texts for s in fakes.tts.streams]


def test_bare_hello_after_identity_question_reasks(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Hello"])
    assert spoken[0] == ["Hi, is this Karthick?"]
    assert spoken[1] == ["Sorry, am I speaking with Karthick?"]
    assert fakes.llm.seen_messages == []  # the re-ask is scripted, no LLM involved


def test_yes_goes_straight_to_the_script(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes, speaking"])
    assert spoken[1][0].startswith("Thank you sir.")
    assert len(fakes.llm.seen_messages) == 1


def test_reask_happens_only_once(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Hello", "Hello"])
    assert spoken[1] == ["Sorry, am I speaking with Karthick?"]
    assert spoken[2][0].startswith("Thank you sir.")  # second bare hello is left to the script
