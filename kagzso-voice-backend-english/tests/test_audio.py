import io
import wave

from app.services import audio_service as audio
from tests.conftest import REAL_WEBRTC_CLASSIFIER, energy_classifier, silence_mulaw, tone_mulaw


def test_mulaw_roundtrip_preserves_length():
    mulaw = tone_mulaw(100)
    assert len(mulaw) == 800  # 8 kHz, 1 byte/sample
    pcm = audio.mulaw_to_pcm16(mulaw)
    assert len(pcm) == 1600
    assert audio.pcm16_to_mulaw(pcm) == mulaw


def test_stt_wav_is_16k_mono_16bit():
    wav = audio.mulaw_to_stt_wav(tone_mulaw(500))
    with wave.open(io.BytesIO(wav)) as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert abs(wf.getnframes() - 8000) < 20


def test_base64_roundtrip():
    data = tone_mulaw(20)
    assert audio.decode_base64(audio.encode_base64(data)) == data


def test_endpointer_detects_start_and_end():
    ep = audio.SpeechEndpointer(energy_classifier, start_ms=100, end_silence_ms=300, min_utterance_ms=100)
    events = []
    for chunk in audio.chunk_bytes(silence_mulaw(200) + tone_mulaw(600) + silence_mulaw(500), 160):
        events += ep.process(audio.mulaw_to_pcm16(chunk))
    kinds = [e.event for e in events]
    assert kinds == [audio.VadEvent.SPEECH_START, audio.VadEvent.SPEECH_END]
    utt = events[-1]
    assert 550 <= utt.duration_ms <= 1000  # speech + preroll + ~200ms tail


def test_endpointer_ignores_short_noise():
    ep = audio.SpeechEndpointer(energy_classifier, start_ms=40, end_silence_ms=200, min_utterance_ms=300)
    events = []
    for chunk in audio.chunk_bytes(tone_mulaw(80) + silence_mulaw(400), 160):
        events += ep.process(audio.mulaw_to_pcm16(chunk))
    assert events[-1].event == audio.VadEvent.SPEECH_END and events[-1].audio == b""


def test_real_webrtc_classifier():
    clf = REAL_WEBRTC_CLASSIFIER(aggressiveness=2, min_rms=300)
    assert clf(b"\x00\x00" * 160) is False  # silence
    assert clf(b"\x00\x00" * 10) is False  # wrong frame size is rejected, not crashed
    loud = audio.mulaw_to_pcm16(tone_mulaw(20))
    assert isinstance(clf(loud), bool)
