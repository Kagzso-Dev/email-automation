"""Audio format conversion and voice-activity / turn detection.

Telephony leg (Plivo stream, contentType audio/x-mulaw;rate=8000):
    inbound  : base64 mu-law 8 kHz mono, ~20 ms (160 bytes) per media event
    outbound : base64 mu-law 8 kHz mono in `playAudio` events

Sarvam STT prefers 16 kHz, so customer utterances are converted
mu-law 8k -> PCM16 8k -> PCM16 16k -> WAV.
Cartesia is asked for raw pcm_mulaw @ 8000 Hz, which Plivo plays directly.

`audioop` is in the Python 3.10 standard library (deprecated from 3.11,
removed in 3.13 - install `audioop-lts` there).
"""
from __future__ import annotations

import audioop  # stdlib on Python 3.10
import base64
import enum
import io
import wave
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Iterator, List, Optional

TELEPHONY_SAMPLE_RATE = 8000
STT_SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # 16-bit PCM
FRAME_MS = 20
PCM_FRAME_BYTES = TELEPHONY_SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000  # 320
MULAW_BYTES_PER_SECOND = TELEPHONY_SAMPLE_RATE  # 1 byte per sample


# ------------------------------ codecs ------------------------------
def decode_base64(payload: str) -> bytes:
    return base64.b64decode(payload)


def encode_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def mulaw_to_pcm16(data: bytes) -> bytes:
    return audioop.ulaw2lin(data, SAMPLE_WIDTH)


def pcm16_to_mulaw(data: bytes) -> bytes:
    return audioop.lin2ulaw(data, SAMPLE_WIDTH)


def resample_pcm16(data: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate or not data:
        return data
    converted, _ = audioop.ratecv(data, SAMPLE_WIDTH, 1, from_rate, to_rate, None)
    return converted


def pcm16_to_wav(data: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(data)
    return buf.getvalue()


def telephony_pcm_to_stt_wav(pcm8k: bytes) -> bytes:
    """PCM16 @ 8 kHz (decoded call audio) -> 16 kHz WAV for Sarvam."""
    return pcm16_to_wav(resample_pcm16(pcm8k, TELEPHONY_SAMPLE_RATE, STT_SAMPLE_RATE), STT_SAMPLE_RATE)


def mulaw_to_stt_wav(mulaw8k: bytes) -> bytes:
    return telephony_pcm_to_stt_wav(mulaw_to_pcm16(mulaw8k))


def rms(pcm: bytes) -> int:
    return audioop.rms(pcm, SAMPLE_WIDTH) if pcm else 0


def mulaw_duration_seconds(nbytes: int) -> float:
    return nbytes / MULAW_BYTES_PER_SECOND


def chunk_bytes(data: bytes, size: int) -> Iterator[bytes]:
    for i in range(0, len(data), size):
        yield data[i : i + size]


# ------------------------------ VAD ------------------------------
SpeechClassifier = Callable[[bytes], bool]  # 20 ms PCM16 8 kHz frame -> is speech


def make_webrtc_classifier(aggressiveness: int, min_rms: int) -> SpeechClassifier:
    """webrtcvad (via the `webrtcvad-wheels` package) gated by an energy floor."""
    import webrtcvad

    vad = webrtcvad.Vad(max(0, min(3, aggressiveness)))

    def classify(frame: bytes) -> bool:
        if len(frame) != PCM_FRAME_BYTES:
            return False
        if rms(frame) < min_rms:
            return False
        return vad.is_speech(frame, TELEPHONY_SAMPLE_RATE)

    return classify


class VadEvent(enum.Enum):
    SPEECH_START = "speech_start"
    SPEECH_END = "speech_end"


@dataclass
class EndpointResult:
    event: VadEvent
    audio: bytes = b""  # PCM16 8 kHz utterance (only on SPEECH_END)
    duration_ms: int = 0


class SpeechEndpointer:
    """Turns a stream of 20 ms frames into speech start / end events.

    * SPEECH_START fires once `start_ms` of voiced audio has accumulated within
      a short sliding window - this is also the barge-in trigger.
    * SPEECH_END fires after `end_silence_ms` of continuous non-speech, with
      the full utterance (incl. pre-roll) attached.
    """

    def __init__(
        self,
        classifier: SpeechClassifier,
        start_ms: int = 200,
        end_silence_ms: int = 700,
        min_utterance_ms: int = 250,
        max_utterance_ms: int = 25000,
        preroll_ms: int = 300,
    ):
        self.classify = classifier
        self.start_frames = max(1, start_ms // FRAME_MS)
        self.window_frames = self.start_frames + max(2, self.start_frames // 2)
        self.end_frames = max(1, end_silence_ms // FRAME_MS)
        self.min_frames = max(1, min_utterance_ms // FRAME_MS)
        self.max_frames = max(self.min_frames + 1, max_utterance_ms // FRAME_MS)
        self._preroll: Deque[bytes] = deque(maxlen=max(1, preroll_ms // FRAME_MS))
        self._window: Deque[bool] = deque(maxlen=self.window_frames)
        self._pending = b""
        self.reset()

    def reset(self) -> None:
        self.in_speech = False
        self._frames: List[bytes] = []
        self._voiced = 0
        self._silence = 0
        self._window.clear()

    def process(self, pcm: bytes) -> List[EndpointResult]:
        """Feed arbitrary-length PCM16 8 kHz audio; returns events in order."""
        events: List[EndpointResult] = []
        data = self._pending + pcm
        n = len(data) - len(data) % PCM_FRAME_BYTES
        self._pending = data[n:]
        for i in range(0, n, PCM_FRAME_BYTES):
            ev = self._process_frame(data[i : i + PCM_FRAME_BYTES])
            if ev:
                events.append(ev)
        return events

    def _process_frame(self, frame: bytes) -> Optional[EndpointResult]:
        speech = self.classify(frame)
        if not self.in_speech:
            self._preroll.append(frame)
            self._window.append(speech)
            if sum(self._window) >= self.start_frames:
                self.in_speech = True
                self._frames = list(self._preroll)
                self._voiced = sum(self._window)
                self._silence = 0
                self._preroll.clear()
                self._window.clear()
                return EndpointResult(VadEvent.SPEECH_START)
            return None

        self._frames.append(frame)
        if speech:
            self._voiced += 1
            self._silence = 0
        else:
            self._silence += 1

        if self._silence >= self.end_frames or len(self._frames) >= self.max_frames:
            voiced, frames, trailing = self._voiced, self._frames, self._silence
            self.reset()
            if voiced < self.min_frames:
                return EndpointResult(VadEvent.SPEECH_END, b"", 0)  # noise burst, ignore
            # Trim most of the trailing silence (keep ~200 ms).
            keep = len(frames) - max(0, trailing - 10)
            audio = b"".join(frames[:keep])
            return EndpointResult(VadEvent.SPEECH_END, audio, len(audio) * 1000 // (TELEPHONY_SAMPLE_RATE * SAMPLE_WIDTH))
        return None
