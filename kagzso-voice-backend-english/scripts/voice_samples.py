"""Save one listening sample per Sarvam Bulbul voice to samples/sarvam_voices/<voice>.wav.

Uses the real call settings (SARVAM_TTS_MODEL, SARVAM_TTS_PACE, CALL_LANGUAGE from .env,
8 kHz phone audio), so each file sounds the way a customer hears that voice. One TTS
request per voice; nothing in the app, database or call flows is changed.

    .venv\\Scripts\\python -m scripts.voice_samples            # every voice in SARVAM_TTS_VOICE_ROTATION
    .venv\\Scripts\\python -m scripts.voice_samples priya ritu # only these
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from app.core.config import settings
from app.services import audio_service as audio
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError
from scripts.voice_check import CANDIDATES

SAMPLE = ("Thank you sir. This is Nila from Kagzso AI and Automation. Could you give me just one minute? "
          "I'll quickly tell you about our company. Is that okay?")
OUT = Path(__file__).resolve().parent.parent / "samples" / "sarvam_voices"


async def save_sample(voice: str) -> str:
    tts = SarvamTTS(settings, voice_id=voice)
    if tts.voice_id != voice:
        return f"SKIP {voice:<8} not a valid Bulbul speaker id"
    try:
        for attempt in range(6):
            try:
                mulaw = await tts.synthesize(SAMPLE)
                break
            except TTSError as exc:
                if exc.kind != "rate_limit" or attempt == 5:
                    return f"FAIL {voice:<8} {exc.kind}: {exc}"
                await asyncio.sleep(2 * (attempt + 1))
    finally:
        await tts.aclose()
    path = OUT / f"{voice}.wav"
    path.write_bytes(audio.pcm16_to_wav(audio.mulaw_to_pcm16(mulaw), audio.TELEPHONY_SAMPLE_RATE))
    return f"OK   {voice:<8} {audio.mulaw_duration_seconds(len(mulaw)):.1f}s  {path.relative_to(OUT.parent.parent)}"


async def main(selected: list[str]) -> None:
    voices = selected or settings.voice_rotation or list(CANDIDATES)
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"model={settings.SARVAM_TTS_MODEL} language={settings.sarvam_language_code} pace={settings.SARVAM_TTS_PACE}")
    for voice in voices:  # one at a time: well under the Sarvam rate limit
        print(await save_sample(voice))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
