"""Check that candidate Cartesia voices read Nila's English lines properly.

For every voice and line: synthesize with the real call settings (8 kHz mu-law,
CARTESIA_LANGUAGE from .env) -> transcribe back with Sarvam (en-IN) -> compare
words with the expected text. Also checks speaking rate and silence. WAVs are
saved to samples/voice_check/<voice>/ so you can listen to any voice.

    .venv\\Scripts\\python -m scripts.voice_check            # all candidates
    .venv\\Scripts\\python -m scripts.voice_check Kiara Nila # only these
"""
from __future__ import annotations

import asyncio
import difflib
import re
import sys
from pathlib import Path

from app.core.config import settings
from app.services import audio_service as audio
from app.services.cartesia_tts import CartesiaTTS, TTSError, apply_pronunciations
from app.services.sarvam_stt import SarvamSTT

CANDIDATES = {
    "Kiara": "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d",
    "Kavita": "56e35e2d-6eb6-4226-ab8b-9776515a7094",
    "Divya": "7c6219d2-e8d2-462c-89d8-7ecba7c75d65",
    "Janani": "fb7d8d97-9730-4165-bd79-36b5ce61b5f2",
    "Akshara": "96e6974d-57a9-4325-89c8-43f065f8bd95",
    "Nithya": "80e4e2b3-ec54-4930-97ac-667eba950352",
    "Anitha": "d4470f50-295e-4e11-82a2-158d45bf6abc",
    "Meena": "4014f0c9-d3eb-4eca-af2b-fd6004f526be",
    "Kavitha": "01d7796d-ac10-4ea3-8df0-3cc04f2d25ff",
    "Nila": "6599f426-765e-4b73-8c5d-9f7250af3c88",
    "Kavya": "25d2c432-139c-4035-bfd6-9baaabcdd006",
    "Lakshmi": "7f98e662-142d-41ba-89a2-12452640ce6d",
    "Sindhu": "07bc462a-c644-49f1-baf7-82d5599131be",
}

LINES = [
    "Hi, is this Raagul?",
    "Thank you sir. This is Nila from Kagzso AI and Automation. Could you give me just one minute? "
    "I'll quickly tell you about our company. Is that okay?",
    "Kagzso AI and Automation helps businesses simplify their daily repetitive work using AI and automation.",
    "I believe your employees spend quite a lot of time on daily repetitive work, is that right?",
    "Sure sir, thank you. You can visit kagzso.com for more details. Thank you so much for your time. Have a nice day.",
    "No problem sir. Thanks for your time. Have a nice day.",
]

MIN_SCORE = 0.85        # per-line word match needed
MIN_WPS, MAX_WPS = 1.6, 4.2  # natural phone speaking rate (words / second)
OUT = Path(__file__).resolve().parent.parent / "samples" / "voice_check"

_NUM = {"one": "1", "a.i": "ai", "a i": "ai"}


def words(text: str) -> list[str]:
    t = text.lower().replace("’", "'")
    t = re.sub(r"\b(kexo|kekso|kexso|kagzso|kagso|kaxo|keksoe|kesso|kakso|kexo's)\b", "kexo", t)
    t = re.sub(r"\ba\.?\s?i\.?\b", "ai", t)
    t = re.sub(r"\bdot com\b|\.com\b", " dot com", t)
    t = re.sub(r"\braagul|ragul|rahul|raghul\b", "raagul", t)
    t = re.sub(r"[^a-z0-9' ]", " ", t)
    return [_NUM.get(w, w) for w in t.split()]


def score(expected: str, heard: str) -> float:
    return difflib.SequenceMatcher(None, words(expected), words(heard)).ratio()


async def check_line(tts: CartesiaTTS, stt: SarvamSTT, name: str, i: int, line: str, sem: asyncio.Semaphore):
    async with sem:
        for attempt in range(6):
            try:
                mulaw = await tts.synthesize(line)
                break
            except TTSError as exc:
                if exc.kind != "rate_limit" and "rate limit" not in str(exc).lower() or attempt == 5:
                    raise
                await asyncio.sleep(2 * (attempt + 1))
        pcm = audio.mulaw_to_pcm16(mulaw)
        (OUT / name).mkdir(parents=True, exist_ok=True)
        (OUT / name / f"line{i + 1}.wav").write_bytes(audio.pcm16_to_wav(pcm, 8000))
        heard = (await stt.transcribe(audio.mulaw_to_stt_wav(mulaw)))["text"] or ""
        secs = audio.mulaw_duration_seconds(len(mulaw))
        spoken = apply_pronunciations(line, settings.CARTESIA_LANGUAGE)
        wps = len(words(spoken)) / secs if secs else 0
        return i, score(spoken, heard), wps, secs, heard


async def check_voice(name: str, voice_id: str, stt: SarvamSTT, sem: asyncio.Semaphore) -> dict:
    tts = CartesiaTTS(settings, voice_id=voice_id)
    try:
        results = await asyncio.gather(*(check_line(tts, stt, name, i, l, sem) for i, l in enumerate(LINES)))
    except Exception as exc:  # voice unusable (deleted, unsupported language, ...)
        return {"name": name, "id": voice_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        await tts.aclose()
    problems = []
    for i, sc, wps, secs, heard in sorted(results):
        if sc < MIN_SCORE:
            problems.append(f"line{i + 1} words {sc:.2f}: heard {heard!r}")
        elif not MIN_WPS <= wps <= MAX_WPS:
            problems.append(f"line{i + 1} rate {wps:.1f} w/s ({secs:.1f}s)")
    avg = sum(r[1] for r in results) / len(results)
    rate = sum(r[2] for r in results) / len(results)
    return {"name": name, "id": voice_id, "ok": not problems, "avg": avg, "rate": rate, "problems": problems}


async def main(selected: list[str]) -> None:
    voices = {n: v for n, v in CANDIDATES.items() if not selected or n in selected}
    stt = SarvamSTT(settings)
    sem = asyncio.Semaphore(1)  # Cartesia plan allows few concurrent requests
    try:
        reports = await asyncio.gather(*(check_voice(n, v, stt, sem) for n, v in voices.items()))
    finally:
        await stt.aclose()
    print(f"language={settings.CARTESIA_LANGUAGE} model={settings.CARTESIA_TTS_MODEL} stt={settings.sarvam_language_code}\n")
    for r in sorted(reports, key=lambda r: (not r["ok"], -r.get("avg", 0))):
        if "error" in r:
            print(f"FAIL {r['name']:<8} {r['error']}")
            continue
        print(f"{'PASS' if r['ok'] else 'FAIL'} {r['name']:<8} match {r['avg']:.2f}  rate {r['rate']:.1f} w/s  {r['id']}")
        for p in r["problems"]:
            print(f"       - {p}")
    passed = [r for r in reports if r.get("ok")]
    print("\nPASSING (for CARTESIA_VOICE_ROTATION):")
    print(",".join(r["id"] for r in sorted(passed, key=lambda r: list(CANDIDATES).index(r["name"]))))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
