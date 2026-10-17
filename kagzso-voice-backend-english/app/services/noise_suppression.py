"""Input noise reduction for the customer's audio (PCM16, 8 kHz, 20 ms frames).

Per frame, in order:
  1. high-pass filter (~70 Hz)         - removes rumble / hum, below the voice band
  2. mild spectral noise suppression  - Wiener-style gain per frequency bin against a noise
                                        estimate from the quiet 20th percentile of the last 3 s
                                        (calibrated to the mean noise power), so it adapts to each
                                        line, ignores speech up to 80% of the time, and never
                                        needs a fixed loudness gate
  3. gentle automatic gain             - lifts quiet voices (never lowers loud ones), slowly,
                                        at most +12 dB. It adapts only on frames that are clearly
                                        voice (speech-band SNR well above the noise estimate), so
                                        noise alone is never boosted; held at 1x while the agent
                                        is speaking so its own voice (echo) is never boosted
  4. limiter                           - no clipping or distortion on loud voices

Safety: the first 0.5 s pass through unchanged (no noise estimate yet), the strongest
reduction is mild (max 6-18 dB by NOISE_SUPPRESSION_STRENGTH), and any error, or repeated
slow frames, switch the cleaner off for the rest of the call - the original audio then
passes straight through. Algorithmic delay: one frame (20 ms, overlap-add).
"""
from __future__ import annotations

import logging
import time
from typing import Optional, Tuple

import numpy as np

log = logging.getLogger("voice.noise")

SAMPLE_RATE = 8000
FRAME = 160  # samples per 20 ms frame
FRAME_BYTES = FRAME * 2
WINDOW = 2 * FRAME  # 40 ms analysis window, 50% overlap
BINS = WINDOW // 2 + 1
BAND = slice(12, 137)  # 300-3400 Hz (25 Hz per bin): the telephone voice band

# The first FFT in a process is slow (plan setup): do it now, not on a live call's first frame.
np.fft.irfft(np.fft.rfft(np.zeros(WINDOW)), WINDOW)


class InputCleaner:
    WARMUP_FRAMES = 25  # 0.5 s: no reduction until there is a noise estimate
    NOISE_WINDOW_FRAMES = 150  # noise statistics over the last 3 s
    NOISE_PERCENTILE = 0.2  # quiet part of each frequency bin's history
    NOISE_BIAS = 1.6  # 20th percentile -> mean noise power (measured on steady noise)
    TARGET_RMS = 3000.0  # about -21 dBFS: a comfortable speech level
    MAX_GAIN = 4.0  # +12 dB at most
    GAIN_UP = 1.03  # per frame (~0.25 dB): reaches +12 dB in about 1 s
    GAIN_DOWN = 0.9  # per frame: backs off quickly
    LIMIT = 30000.0  # peak ceiling (int16 max 32767)
    LIMIT_RELEASE = 1.01
    VOICE_SNR = 2.5  # smoothed speech-band power vs noise estimate (4 dB); noise alone stays below ~1.3
    VOICE_MIN_RMS = 30.0  # and an audible level (digital silence has no noise estimate to compare to)
    SLOW_FRAME_MS = 5.0  # a 20 ms frame must be cleaned in well under this
    SLOW_FRAMES_TO_BYPASS = 5  # this many slow frames in a row -> bypass for the call

    def __init__(self, strength: float = 0.5):
        self.strength = float(min(1.0, max(0.0, strength)))
        self.over = 1.0 + self.strength  # noise over-subtraction factor
        self.min_gain = 10 ** (-(6.0 + 12.0 * self.strength) / 20)  # 6-18 dB floor: never mutes a bin
        self.window = np.sqrt(np.hanning(WINDOW + 1)[:-1])  # periodic sqrt-Hann: perfect reconstruction
        self.bypassed = False
        self.frozen = False  # True while the agent is speaking (set by the call session)
        self._pending = b""
        self._prev_in = np.zeros(FRAME)
        self._ola = np.zeros(FRAME)
        self._raw_prev = b"\x00\x00" * FRAME  # raw audio delayed by the same frame, for alignment
        self._hp_x = 0.0
        self._hp_y = 0.0
        self._hp_a = 1.0 / (1.0 + 2 * np.pi * 70.0 / SAMPLE_RATE)  # one-pole high-pass at 70 Hz
        self._smoothed = np.zeros(BINS)
        self._noise_hist = np.zeros((self.NOISE_WINDOW_FRAMES, BINS))
        self._noise_idx = 0
        self._noise_filled = 0
        self._gain_prev = np.ones(BINS)
        self._level: Optional[float] = None
        self._agc = 1.0
        self._limit_env = 1.0
        self.voiced = False  # the last frame was clearly voice (drives the auto-gain)
        self.gain = 1.0  # total gain applied to the last frame (auto-gain x limiter)
        self._slow_in_row = 0
        # timing stats (for the per-call log)
        self.frames = 0
        self.total_ms = 0.0
        self.max_ms = 0.0

    # ------------------------------------------------------------------ public
    def feed(self, pcm: bytes) -> Tuple[bytes, bytes]:
        """Any-length PCM16 8 kHz in -> (cleaned, original) of equal length, both delayed by
        one frame. When bypassed: the original audio, undelayed, for both."""
        if self.bypassed:
            return pcm, pcm
        data = self._pending + pcm
        n = len(data) - len(data) % FRAME_BYTES
        self._pending = data[n:]
        clean, raw = [], []
        for i in range(0, n, FRAME_BYTES):
            frame = data[i:i + FRAME_BYTES]
            if self.bypassed:  # switched off part-way through this chunk
                clean.append(frame)
                raw.append(frame)
                continue
            t = time.perf_counter()
            try:
                out = self._process(frame)
            except Exception as exc:  # never break the call: pass the original audio through
                self._bypass(f"error ({type(exc).__name__})")
                clean.append(self._raw_prev + frame)
                raw.append(self._raw_prev + frame)
                continue
            ms = (time.perf_counter() - t) * 1000
            self._account(ms)
            clean.append(out)
            raw.append(self._raw_prev)
            self._raw_prev = frame
            if self.bypassed:  # too slow: hand over the delayed frame so nothing is lost
                clean.append(frame)
                raw.append(frame)
        if self.bypassed and self._pending:
            rest, self._pending = self._pending, b""
            clean.append(rest)
            raw.append(rest)
        return b"".join(clean), b"".join(raw)

    def stats(self) -> Tuple[int, float, float]:
        """(frames, average ms per 20 ms frame, max ms)."""
        avg = self.total_ms / self.frames if self.frames else 0.0
        return self.frames, avg, self.max_ms

    # ------------------------------------------------------------------ internals
    def _bypass(self, reason: str) -> None:
        if not self.bypassed:
            self.bypassed = True
            log.warning("Noise suppression switched off for this call: %s - original audio passes through", reason)

    def _account(self, ms: float) -> None:
        self.frames += 1
        self.total_ms += ms
        self.max_ms = max(self.max_ms, ms)
        log.debug("Noise suppression chunk: %.3f ms", ms)
        self._slow_in_row = self._slow_in_row + 1 if ms > self.SLOW_FRAME_MS else 0
        if self._slow_in_row >= self.SLOW_FRAMES_TO_BYPASS:
            self._bypass(f"too slow ({ms:.1f} ms per 20 ms chunk)")

    def _highpass(self, x: np.ndarray) -> np.ndarray:
        a, px, py = self._hp_a, self._hp_x, self._hp_y
        out = []
        for v in x.tolist():  # plain floats: much faster than indexing numpy scalars
            py = a * (py + v - px)
            px = v
            out.append(py)
        self._hp_x, self._hp_y = px, py
        return np.array(out)

    def _suppress(self, x: np.ndarray) -> np.ndarray:
        spec = np.fft.rfft(np.concatenate((self._prev_in, x)) * self.window)
        self._prev_in = x
        power = spec.real ** 2 + spec.imag ** 2
        self._smoothed = 0.7 * self._smoothed + 0.3 * power
        if not self.frozen:  # the agent's echo is not line noise: don't learn from it
            self._noise_hist[self._noise_idx] = self._smoothed
            self._noise_idx = (self._noise_idx + 1) % self.NOISE_WINDOW_FRAMES
            self._noise_filled = min(self._noise_filled + 1, self.NOISE_WINDOW_FRAMES)
        if self._noise_filled < self.WARMUP_FRAMES:
            gain = np.ones(BINS)
            self.voiced = False
        else:
            hist = self._noise_hist[:self._noise_filled]
            k = int(self._noise_filled * self.NOISE_PERCENTILE)
            noise = np.partition(hist, k, axis=0)[k] * self.NOISE_BIAS
            self.voiced = float(self._smoothed[BAND].mean()) > self.VOICE_SNR * float(noise[BAND].mean()) + 1e-6
            gain = np.maximum(1.0 - self.over * noise / (power + 1e-9), self.min_gain)
            gain = np.maximum(gain, 0.7 * self._gain_prev)  # rises at once, falls slowly: keeps onsets
        self._gain_prev = gain
        y = np.fft.irfft(spec * gain, WINDOW) * self.window
        out = self._ola + y[:FRAME]
        self._ola = y[FRAME:]
        return out

    def _auto_gain(self, x: np.ndarray) -> np.ndarray:
        if self.frozen:
            return x  # never boost while the agent is speaking (its echo would be boosted too)
        level = float(np.sqrt(np.mean(x * x)))
        if self.voiced and level >= self.VOICE_MIN_RMS:  # adapt to the voice only - noise never raises it
            self._level = level if self._level is None else 0.95 * self._level + 0.05 * level
        if self._level is not None:
            want = min(self.MAX_GAIN, max(1.0, self.TARGET_RMS / max(self._level, 1.0)))
            self._agc = min(want, self._agc * self.GAIN_UP) if want > self._agc else max(want, self._agc * self.GAIN_DOWN)
        return x * self._agc

    def _limit(self, x: np.ndarray) -> np.ndarray:
        peak = float(np.max(np.abs(x))) if x.size else 0.0
        need = min(1.0, self.LIMIT / peak) if peak > 0 else 1.0
        self._limit_env = min(need, self._limit_env * self.LIMIT_RELEASE, 1.0)
        return x * self._limit_env

    def _process(self, frame: bytes) -> bytes:
        x = np.frombuffer(frame, dtype="<i2").astype(np.float64)
        y = self._limit(self._auto_gain(self._suppress(self._highpass(x))))
        self.gain = (1.0 if self.frozen else self._agc) * self._limit_env
        return np.clip(np.rint(y), -32768, 32767).astype("<i2").tobytes()
