"""Save one listening sample per Sarvam Bulbul voice to samples/sarvam_voices/<voice>.wav.

Uses the real call settings (SARVAM_TTS_MODEL, SARVAM_TTS_PACE, CALL_LANGUAGE from .env,
8 kHz phone audio), so each file sounds the way a customer hears that voice. One TTS
request per voice; nothing in the app, database or call flows is changed.

    .venv\\Scripts\\python -m scripts.voice_samples            # every stock voice this backend offers
    .venv\\Scripts\\python -m scripts.voice_samples priya ritu # only these

Cloned voices (SARVAM_TTS_VOICE_EN_FEMALE in .env, SARVAM_TTS_VOICE_TA_FEMALE / _MALE_1 / _MALE_2 in .env.ta): the
CLONED_LINES with every cloned voice (the English sentence with English voices only), each with its own backend's
settings (language, key, the AI Agent voice profile's pace) at 8 kHz, one WAV per voice per line in
samples/cloned_voices/<language>_<slot>/. No fallback voice: a failure is shown as it is. PAID requests (Sarvam bills
per character), so it only lists them - the text and voice id of each, how many, the cost - unless --yes is given:

    .venv\\Scripts\\python -m scripts.voice_samples --cloned                  # the plan only, nothing is sent
    .venv\\Scripts\\python -m scripts.voice_samples --cloned --yes            # send them (one REST request per line)
    .venv\\Scripts\\python -m scripts.voice_samples --cloned --yes --stream   # the same over the WebSocket calls use
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from app.core.config import Settings, settings
from app.core.voices import STOCK_VOICE_IDS
from app.services import audio_service as audio
from app.services.provider_registry import agent_voice_settings
from app.services.sarvam_tts import SarvamTTS, _split_text
from app.services.tts import TTSError, apply_pronunciations
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
    voices = selected or list(STOCK_VOICE_IDS) or list(CANDIDATES)
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"model={settings.SARVAM_TTS_MODEL} language={settings.sarvam_language_code} pace={settings.SARVAM_TTS_PACE}")
    for voice in voices:  # one at a time: well under the Sarvam rate limit
        print(await save_sample(voice))


# ------------------------------------------------------------------ cloned voices
CLONED_LINES = [  # (file name, text, which voices: "all" or "en" = English voices only)
    ("tamil_greeting", "வணக்கம் சார், எப்படி இருக்கீங்க?", "all"),
    ("tanglish", "எங்க shop-ல billing software already இருக்கு", "all"),
    ("amount", "5,000", "all"),
    ("rupees", "₹2,500", "all"),
    ("phone", "98765 43210", "all"),
    ("brand", "Kagzso AI and Automation", "all"),
    ("english", "Thank you sir, I will send you the details on WhatsApp right away.", "en"),
]
CLONED_ENV_FILES = (".env", ".env.ta")  # the English and the Tamil backend, each with its own settings
CLONED_OUT = OUT.parent / "cloned_voices"
RUPEES_PER_1000_CHARS = 2.0  # Sarvam pricing, "Instant Voice Cloning" (docs.sarvam.ai pricing, checked 2026-11-18)


def cloned_plan() -> list:
    """(settings, folder, voice id, file name, text sent) per request, in order."""
    plan = []
    for env_file in CLONED_ENV_FILES:
        if not Path(env_file).exists():
            print(f"SKIP {env_file}: no such file")
            continue
        cfg = Settings(_env_file=env_file)
        cfg = cfg.model_copy(update=agent_voice_settings(cfg))  # as an AI Agent call speaks (AGENT_TTS_PACE)
        if not cfg.cloned_voices:
            print(f"SKIP {env_file}: no cloned voice set for CALL_LANGUAGE={cfg.call_language}")
        for slot, voice_id, _gender in cfg.cloned_voices:
            for name, text, who in CLONED_LINES:
                if who == "all" or who == cfg.call_language:
                    plan.append((cfg, f"{cfg.call_language}_{slot}", voice_id, name,
                                 apply_pronunciations(text, cfg.CALL_LANGUAGE)))
    return plan


async def _cloned_audio(tts: SarvamTTS, text: str, stream: bool) -> bytes:
    if not stream:
        return await tts.synthesize(text)
    return b"".join([chunk async for chunk in tts.stream_synthesize(text)])


async def save_cloned(send: bool, stream: bool) -> None:
    plan = cloned_plan()
    requests = sum(len(_split_text(sent)) for *_, sent in plan)
    chars = sum(len(sent) for *_, sent in plan)
    path = "WebSocket wss://api.sarvam.ai/voices/clone/ws" if stream else "REST POST /voices/clone"
    for i, (cfg, folder, voice_id, name, sent) in enumerate(plan, 1):
        print(f"{i:>2}. {folder:<12} voice_id={voice_id} language={cfg.sarvam_language_code} "
              f"pace={cfg.SARVAM_TTS_PACE} 8000 Hz  {name}: {sent!r}")
    print(f"\n{requests} paid requests ({path}), {chars} characters, about Rs {chars / 1000 * RUPEES_PER_1000_CHARS:.2f} "
          f"at Rs {RUPEES_PER_1000_CHARS:g} per 1,000 characters.")
    if not send:
        print("Nothing was sent. Run again with --yes to send them.")
        return
    for cfg, folder, voice_id, name, sent in plan:  # one at a time: well under Sarvam's rate limit
        tts = SarvamTTS(cfg, voice_id=voice_id, exact_voice=True)
        try:
            mulaw = await _cloned_audio(tts, sent, stream)
        except TTSError as exc:
            print(f"FAIL {folder:<12} {name:<15} {exc.kind} {exc.status_code or ''}: {exc}")
            continue
        finally:
            await tts.aclose()
        out = CLONED_OUT / folder / f"{name}.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(audio.pcm16_to_wav(audio.mulaw_to_pcm16(mulaw), audio.TELEPHONY_SAMPLE_RATE))
        print(f"OK   {folder:<12} {name:<15} {audio.mulaw_duration_seconds(len(mulaw)):.1f}s  {out}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--cloned" in args:
        asyncio.run(save_cloned(send="--yes" in args, stream="--stream" in args))
    else:
        asyncio.run(main(args))
