"""A Tamil Autonomous AI Agent call through eight customer behaviours, end to end on the real call engine (fake STT /
LLM / TTS / Plivo): the agent opens with its fixed greeting, then every reply is the LLM's, written from the whole
conversation - who is calling, an off-topic question, Tanglish, an interruption mid-reply, interest, silence, "call
me later" - plus "not interested" and lost words (an STT failure: re-asked in the agent's own words, no fixed script).

The fake LLM's replies are canned, so these tests prove what the backend does (each turn reaches the LLM with the
customer's words and the history, interruptions stop the agent, silence and lost words are said in its own words, the
call ends, a transcript and a result are saved, per-turn timing is recorded) - not how human a real model sounds:
that needs scripts/autonomous_conversation_check.py --language ta --tuned --run (real LLM requests, paid)."""
from __future__ import annotations

import json
import time

import pytest

from app.core.config import settings
from app.services import call_service as cs
from app.services.sarvam_stt import STTError
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_policy import _agent_lines, _events, _rows
from tests.test_nila_flow import _send, _start, _until

WHO = "யார் பேசுறீங்க?"
OFF_TOPIC = "Tally கூட connect ஆகுமா?"
TANGLISH = "எங்க shop-ல billing software already இருக்கு"
INTERRUPT = "ஒரு நிமிஷம், அது எவ்வளவு ஆகும்?"
INTERESTED = "சரி, interesting-ஆ இருக்கு. இன்னும் சொல்லுங்க."
LATER = "இப்போ busy-ஆ இருக்கேன், அப்புறம் call பண்ணுங்க."
NOT_INTERESTED = "எனக்கு வேண்டாம், thanks."
REPLIES = [
    "நான் Thaara, Kagzso-ல இருந்து பேசுறேன். உங்க business-க்கு automation பத்தி பேசலாம்னு call பண்ணேன்.",
    "அந்த detail என்கிட்ட இல்ல sir, எங்க team confirm பண்ணணும்.",
    "ஓ, புரியுது. அது இருக்கட்டும். நாங்க அதோட சேர்ந்து வேலை செய்வோம். உங்க staff-க்கு நேரம் மிச்சமாகும்.",
    "விலை உங்க தேவையை பொறுத்து மாறும் sir.",
    "சந்தோஷம் sir. உங்க shop-ல எந்த வேலை அதிக நேரம் எடுக்குது?",
    "Hello sir, கேக்குதா?",
    "சரி sir, பரவாயில்ல. நன்றி, have a nice day. [[END_CALL]]",
]


@pytest.fixture
def tamil_agent(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", True)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.8)
    return _flow("ta", monkeypatch)


def _ack(ws, cp):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))


def _speak(ws, ms=400):
    time.sleep(0.5)  # out of the echo window after the agent's line
    _send(ws, tone_mulaw(ms) + silence_mulaw(900))
    return _until(ws, "checkpoint")


def _wait(cond, limit=5.0):
    deadline = time.time() + limit
    while not cond() and time.time() < deadline:
        time.sleep(0.05)
    return cond()


def test_a_free_flowing_tamil_call_through_eight_customer_behaviours(client, auth, fakes, sync_engine, tamil_agent):
    fakes.llm.replies = list(REPLIES)
    fakes.stt.replies = [WHO, OFF_TOPIC, TANGLISH, INTERRUPT, INTERESTED, LATER]
    call_id, token = _dial(client, auth, tamil_agent)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _ack(ws, _until(ws, "checkpoint"))           # the fixed greeting, on connect
        _ack(ws, _speak(ws))                          # 1 "who is this?"
        _ack(ws, _speak(ws))                          # 2 an off-topic question
        fakes.tts.chunks_per_sentence = 20            # the next reply plays for about 6 s
        _speak(ws)                                    # 3 Tanglish; its reply still playing ...
        time.sleep(1.0)
        fakes.tts.chunks_per_sentence = 2
        _ack(ws, _speak(ws, ms=700))                  # 4 ... interrupted mid-reply with a question
        _ack(ws, _speak(ws))                          # 5 interest
        _ack(ws, _until(ws, "checkpoint"))            # 6 silence: the agent checks in, in its own words
        _ack(ws, _speak(ws))                          # 7 "call me later": the agent says goodbye
        assert _wait(lambda: fakes.plivo.hangups == ["uuid-k"])  # 8 ... and the call ends
    asked = [m[-1]["content"] for m in fakes.llm.seen_messages]
    assert asked == [WHO, OFF_TOPIC, TANGLISH, INTERRUPT, INTERESTED, cs.AGENT_SILENCE_REPROMPT_INSTRUCTION, LATER]
    # Every reply sees the whole conversation, from the greeting on (after the provider's "(The call has just
    # connected.)", llm_service._messages).
    assert all(m[1]["role"] == "assistant" and m[1]["content"].startswith("வணக்கம்") for m in fakes.llm.seen_messages)
    assert [len(m) for m in fakes.llm.seen_messages] == sorted(len(m) for m in fakes.llm.seen_messages)  # it grows
    events = _events(sync_engine, call_id)
    assert "barge_in" in events and "silence_reprompt" in events
    assert _wait(lambda: len(_agent_lines(sync_engine, call_id)) == 8)
    agent = _agent_lines(sync_engine, call_id)
    # The greeting, then the LLM's seven replies in order; the one cut off was already all sent to the voice (saved
    # as sent: the engine marks a reply interrupted only while it is still being written, or with BARGE_EARLY_STOP).
    assert agent[0].startswith("வணக்கம்") and agent[1:] == [r.replace(" [[END_CALL]]", "") for r in REPLIES]
    customer = [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and "
                                                  "speaker = 'customer' order by id", call_id)]
    assert customer == [WHO, OFF_TOPIC, TANGLISH, INTERRUPT, INTERESTED, LATER]
    assert _wait(lambda: _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] is not None)
    timing = _rows(sync_engine, "select turn_index, reply_delay_ms, llm_first_token_ms, tts_first_byte_ms "
                                "from call_latency_metrics where call_id = :id order by id", call_id)
    assert len(timing) >= 6  # one timing row per reply (the "Turn N timing" log lines' numbers)


def test_not_interested_ends_the_call_politely(client, auth, fakes, sync_engine, tamil_agent):
    fakes.llm.replies = ["சரி sir, புரியுது. நேரம் கொடுத்ததுக்கு நன்றி. [[END_CALL]]"]
    fakes.stt.replies = [NOT_INTERESTED]
    call_id, token = _dial(client, auth, tamil_agent)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _ack(ws, _until(ws, "checkpoint"))
        _ack(ws, _speak(ws))
        assert _wait(lambda: fakes.plivo.hangups == ["uuid-k"])
    assert fakes.llm.seen_messages[-1][-1]["content"] == NOT_INTERESTED


def test_lost_words_are_asked_again_in_the_agents_own_words_then_a_goodbye(client, auth, fakes, sync_engine,
                                                                          tamil_agent, monkeypatch):
    async def lost(*a, **k):
        raise STTError("timeout", "Sarvam STT timed out")

    monkeypatch.setattr(fakes.stt, "transcribe", lost)
    fakes.llm.replies = ["மன்னிக்கணும் sir, சரியா கேக்கல. இன்னொரு தடவை சொல்ல முடியுமா?",
                         "சரி sir, line சரியில்ல போல. அப்புறம் பேசலாம், நன்றி."]
    call_id, token = _dial(client, auth, tamil_agent)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _ack(ws, _until(ws, "checkpoint"))
        _ack(ws, _speak(ws))  # words lost: asked again
        _ack(ws, _speak(ws))  # lost again: goodbye, and the call ends
        assert _wait(lambda: fakes.plivo.hangups == ["uuid-k"])
    asked = [m[-1]["content"] for m in fakes.llm.seen_messages]
    assert asked == [cs.AGENT_UNHEARD_INSTRUCTION, cs.AGENT_UNHEARD_CLOSE_INSTRUCTION]
    lines = _agent_lines(sync_engine, call_id)
    assert lines[1:] == [r for r in ["மன்னிக்கணும் sir, சரியா கேக்கல. இன்னொரு தடவை சொல்ல முடியுமா?",
                                     "சரி sir, line சரியில்ல போல. அப்புறம் பேசலாம், நன்றி."]]
    assert cs.FALLBACK_REPLIES["ta"] not in lines  # never the fixed script line


def test_the_fixed_greeting_call_tells_the_llm_not_to_greet_again(client, auth, fakes, tamil_agent):
    from tests.test_autonomous_agent import _capture_systems

    systems = _capture_systems(fakes)
    fakes.stt.replies = [WHO]
    call_id, token = _dial(client, auth, tamil_agent)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _ack(ws, _until(ws, "checkpoint"))
        _ack(ws, _speak(ws))
        ws.send_text(json.dumps({"event": "stop"}))
    assert "Never greet or introduce yourself again" in systems[0]
