"""Input noise reduction (app/services/noise_suppression.py) with synthetic audio and the real
webrtcvad: noise alone makes no turn, quiet voices over noise are heard and lifted, loud voices are
not clipped, slow speakers are not cut, short answers count, failures bypass to the original audio,
and the added delay stays at one 20 ms frame."""
import json
import re
import time

import numpy as np
import pytest

from app.core.config import Settings, settings
from app.services import audio_service as audio
from app.services import call_service
from app.services.noise_suppression import FRAME_BYTES, InputCleaner
from tests.conftest import REAL_WEBRTC_CLASSIFIER, silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


# ------------------------------------------------------------------ synthetic audio
def voice(ms, rms, f0=140.0):
    """Voiced speech stand-in: harmonics of a wobbling pitch, shaped into ~4 syllables a second."""
    t = np.arange(8 * ms) / 8000
    phase = 2 * np.pi * np.cumsum(f0 * (1 + 0.03 * np.sin(2 * np.pi * 5 * t))) / 8000
    sig = sum((1.0 / k) * np.sin(k * phase) for k in range(1, 25) if k * f0 < 3600)
    sig = sig * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * t))
    return sig / np.sqrt(np.mean(sig ** 2)) * rms


def white(ms, rms, seed=1):
    return np.random.default_rng(seed).normal(0, rms, 8 * ms)


def pinkish_hum(ms, seed=2):
    n = 8 * ms
    return (np.convolve(np.random.default_rng(seed).normal(0, 900, n), np.ones(4) / 4, "same")
            + 200 * np.sin(2 * np.pi * 50 * np.arange(n) / 8000))


def silence(ms):
    return np.zeros(8 * ms)


def pcm(x):
    return np.clip(np.rint(x), -32768, 32767).astype("<i2").tobytes()


def detect(signal, suppression=True, end_silence_ms=700):
    """Run audio through the call's detection chain (as CallSession builds it) in 20 ms chunks.
    Returns (utterances as (duration_ms, audio), cleaner)."""
    cleaner = InputCleaner(0.5) if suppression else None
    gate = audio.NoiseFloorGate(call_service.QUIET_VOICE_MIN_RMS if suppression else 300, 2.5, 1000)
    # the real webrtcvad (the conftest patches audio.make_webrtc_classifier to an energy stub)
    ep = audio.SpeechEndpointer(REAL_WEBRTC_CLASSIFIER(2, 0 if suppression else 300),
                                end_silence_ms=end_silence_ms, min_utterance_ms=200 if suppression else 250,
                                noise_gate=gate)
    data, ends = pcm(signal), []
    for i in range(0, len(data), FRAME_BYTES):
        chunk = data[i:i + FRAME_BYTES]
        if cleaner:
            clean, raw = cleaner.feed(chunk)
            gate.scale = cleaner.gain  # as CallSession._clean does
            events = ep.process(clean, raw)
        else:
            events = ep.process(chunk)
        ends += [(e.duration_ms, e.audio) for e in events if e.event == audio.VadEvent.SPEECH_END and e.audio]
    return ends, cleaner


# ------------------------------------------------------------------ noise alone
@pytest.mark.parametrize("noise", [white(5000, 20), white(5000, 350), pinkish_hum(5000), white(5000, 800, seed=9)])
def test_steady_noise_alone_produces_no_turn(noise):
    ends, cleaner = detect(noise)
    assert ends == []
    assert cleaner._agc == 1.0  # noise is never boosted


# ------------------------------------------------------------------ quiet voice
def test_quiet_voice_over_noise_is_heard_and_lifted():
    sig = np.concatenate([white(1500, 100), voice(1500, 150) + white(1500, 100, seed=4), white(1200, 100, seed=5)])
    assert detect(sig, suppression=False)[0] == []  # today's fixed gate misses it
    ends, cleaner = detect(sig)
    assert len(ends) == 1 and ends[0][0] >= 1000
    assert cleaner._agc > 2.0  # gently lifted (at most 4x / +12 dB)


def test_soft_voice_in_a_quiet_room_is_heard():
    sig = np.concatenate([white(1000, 20), voice(1000, 120) + white(1000, 20, seed=3), white(1000, 20, seed=6)])
    assert detect(sig, suppression=False)[0] == []  # today: below the fixed gate
    ends, _ = detect(sig)
    assert len(ends) == 1


# ------------------------------------------------------------------ loud voice
def test_loud_voice_is_not_clipped():
    sig = np.concatenate([silence(800), voice(1500, 14000), silence(1000)])
    cleaner = InputCleaner(0.5)
    data = pcm(sig)
    out = b"".join(cleaner.feed(data[i:i + FRAME_BYTES])[0] for i in range(0, len(data), FRAME_BYTES))
    samples = np.frombuffer(out, "<i2").astype(int)
    assert np.max(np.abs(samples)) <= InputCleaner.LIMIT + 1
    assert int(np.sum(np.abs(samples) >= 32767)) == 0  # no hard clipping
    assert cleaner._agc == 1.0  # a loud voice is never lowered or raised by the gain
    ends, _ = detect(sig)
    assert len(ends) == 1


# ------------------------------------------------------------------ slow speech
def test_slow_speech_with_long_pauses_is_one_utterance_once_slow():
    sig = np.concatenate([silence(600), voice(700, 2000), silence(1500), voice(700, 2000),
                          silence(1500), voice(700, 2000), silence(2000)])
    assert len(detect(sig, end_silence_ms=700)[0]) == 3  # today's 700 ms wait splits it
    ends, _ = detect(sig, end_silence_ms=1600)  # a caller marked as a slow speaker
    assert len(ends) == 1 and ends[0][0] >= 700 * 3 + 1500 * 2


# ------------------------------------------------------------------ short answers
def test_short_yes_still_counts():
    sig = np.concatenate([silence(800), voice(210, 2500, f0=180), silence(1200)])
    assert detect(sig, suppression=False)[0] == []  # today: dropped as a noise burst
    ends, _ = detect(sig)
    assert len(ends) == 1


def test_stt_hears_the_original_audio():
    sig = np.concatenate([white(1500, 300), voice(800, 2000) + white(800, 300, seed=8), white(1200, 300, seed=9)])
    ends, _ = detect(sig)
    assert len(ends) == 1 and ends[0][1] in pcm(sig)  # the utterance is the untouched input


# ------------------------------------------------------------------ bypass
def test_error_bypasses_to_the_original_audio():
    cleaner = InputCleaner(0.5)

    def boom(_frame):
        raise RuntimeError("simulated")

    data = pcm(voice(400, 2000))
    first_clean, _ = cleaner.feed(data[:FRAME_BYTES * 3])
    cleaner._process = boom
    rest_clean, rest_raw = cleaner.feed(data[FRAME_BYTES * 3:])
    assert cleaner.bypassed
    assert rest_clean == rest_raw
    # Output runs one frame behind the input; at the switch the held frame is handed over, so
    # nothing is lost (the call just heard 20 ms of leading silence at its very start).
    assert len(first_clean) + len(rest_clean) == len(data) + FRAME_BYTES
    assert rest_raw.endswith(data[FRAME_BYTES * 3:])
    assert cleaner.feed(b"abcd") == (b"abcd", b"abcd")


def test_slow_processing_bypasses():
    cleaner = InputCleaner(0.5)
    cleaner.SLOW_FRAME_MS = -1.0  # every chunk counts as too slow
    data = pcm(white(400, 300))
    out = b"".join(cleaner.feed(data[i:i + FRAME_BYTES])[0] for i in range(0, len(data), FRAME_BYTES))
    assert cleaner.bypassed and len(out) == len(data) + FRAME_BYTES and out.endswith(data[-FRAME_BYTES * 3:])


# ------------------------------------------------------------------ delay and cost
def test_added_delay_is_one_frame_and_processing_is_fast():
    sig = np.concatenate([white(3000, 300), voice(4000, 1500) + white(4000, 300, seed=3), white(3000, 300, seed=4)])
    cleaner = InputCleaner(0.5)
    data, raw_out = pcm(sig), b""
    for i in range(0, len(data), FRAME_BYTES):
        raw_out += cleaner.feed(data[i:i + FRAME_BYTES])[1]
    frames, avg_ms, _ = cleaner.stats()
    assert raw_out == b"\x00" * FRAME_BYTES + data[:-FRAME_BYTES]  # exactly one 20 ms frame behind
    assert frames == len(data) // FRAME_BYTES and avg_ms < 2.0  # far under the 20 ms of audio per chunk


def test_gain_is_held_while_the_agent_is_speaking():
    cleaner = InputCleaner(0.5)
    cleaner.frozen = True
    data = pcm(np.concatenate([white(1000, 100), voice(1500, 150) + white(1500, 100, seed=4)]))
    for i in range(0, len(data), FRAME_BYTES):
        cleaner.feed(data[i:i + FRAME_BYTES])
    assert cleaner._agc == 1.0 and cleaner._noise_filled == 0  # no boost, echo not learned as noise


def test_config_defaults_and_ranges():
    f = Settings.model_fields
    assert f["NOISE_SUPPRESSION_ENABLED"].default is True
    assert f["NOISE_SUPPRESSION_STRENGTH"].default == 0.5
    assert f["NOISE_SUPPRESSION_STT_AUDIO"].default == "original"
    assert f["SLOW_SPEAKER_END_SILENCE_MS"].default == 1600
    assert Settings(NOISE_SUPPRESSION_STRENGTH=3).NOISE_SUPPRESSION_STRENGTH == 1.0
    assert Settings(NOISE_SUPPRESSION_STT_AUDIO="bogus").NOISE_SUPPRESSION_STT_AUDIO == "original"


# ------------------------------------------------------------------ in a call
def _mulaw(x):
    return audio.pcm16_to_mulaw(pcm(x))


def _session(call_id):
    deadline = time.time() + 3
    while call_id not in call_service.ACTIVE_SESSIONS and time.time() < deadline:
        time.sleep(0.02)
    return call_service.ACTIVE_SESSIONS[call_id]


def test_quiet_voice_over_noise_reaches_stt_in_a_call(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(audio, "make_webrtc_classifier", REAL_WEBRTC_CLASSIFIER)
    monkeypatch.setattr(settings, "VAD_MIN_RMS", 300)  # as in production
    fakes.stt.replies = ["Hello"]
    call_id, token = _call(client, auth, gender="male")
    sig = np.concatenate([white(1500, 100), voice(1200, 150) + white(1200, 100, seed=4), white(1200, 100, seed=5)])
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, _mulaw(sig))
        _until(ws, "playAudio")  # the greeting, started by the quiet "Hello"
    assert fakes.stt.calls == 1


def test_very_loud_noise_never_gets_a_reply(client, auth, fakes, monkeypatch):
    """Noise louder than the adaptive cap may reach STT once in the first 0.5 s (before the
    noise estimate exists); STT hears no words, so nothing is answered."""
    monkeypatch.setattr(audio, "make_webrtc_classifier", REAL_WEBRTC_CLASSIFIER)
    monkeypatch.setattr(settings, "FIRST_SPEECH_WAIT_SECONDS", 0.5)
    fakes.stt.replies = [""]
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, _mulaw(white(4000, 1200)))
        time.sleep(0.8)
    assert fakes.stt.calls <= 1
    assert fakes.llm.seen_messages == []  # no turn: nothing was answered


def test_switched_off_is_todays_path(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "NOISE_SUPPRESSION_ENABLED", False)
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        assert _session(call_id).cleaner is None
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
    assert fakes.stt.calls == 1


def test_a_failing_cleaner_never_breaks_the_call(client, auth, fakes, monkeypatch):
    def boom(self, _frame):
        raise RuntimeError("simulated")

    monkeypatch.setattr(InputCleaner, "_process", boom)
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        assert _session(call_id).cleaner.bypassed
    assert fakes.stt.calls == 1 and [" ".join(s.texts) for s in fakes.tts.streams] == ["Hi sir, Good morning."]


def test_strict_gate_and_no_gain_while_the_agent_speaks(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "VAD_MIN_RMS", 300)
    fakes.tts.chunks_per_sentence = 40  # the greeting plays for ~4 s
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        session = _session(call_id)
        _send(ws, silence_mulaw(200))
        assert session._noise_gate.min_rms == call_service.QUIET_VOICE_MIN_RMS  # listening: low minimum
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        _send(ws, silence_mulaw(100))  # audio while the greeting plays
        assert session.cleaner.frozen and session._noise_gate.min_rms == 300


@pytest.mark.parametrize("since_end,agent_spoke,slow", [(1.0, False, True), (1.0, True, False), (2.5, False, False)])
def test_caller_who_resumes_mid_sentence_gets_a_longer_wait(client, auth, fakes, since_end, agent_spoke, slow):
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        session = _session(call_id)
        now = time.monotonic()
        session._last_speech_end = now - since_end
        session._playback_started = now - since_end / 2 if agent_spoke else 0.0
        session._note_resume()
        assert session._slow_speaker is slow
        assert session.endpointer.end_frames == (1600 // 20 if slow else settings.VAD_SPEECH_END_SILENCE_MS // 20)


def test_timing_log_has_no_phone_numbers(client, auth, fakes, caplog):
    call_id, token = _call(client, auth, gender="male")
    with caplog.at_level("INFO"):
        with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
            _start(ws)
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _until(ws, "playAudio")
            ws.send_text(json.dumps({"event": "stop"}))
        deadline = time.time() + 3
        while time.time() < deadline and not any("Noise suppression for this call" in r.getMessage() for r in caplog.records):
            time.sleep(0.05)
    line = next(r.getMessage() for r in caplog.records if "Noise suppression for this call" in r.getMessage())
    assert re.search(r"\d+ chunks, [\d.]+ ms avg / [\d.]+ ms max per 20 ms chunk", line)
    assert not re.search(r"\d{8,}", line)
