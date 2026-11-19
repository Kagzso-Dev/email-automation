"""The voices Kagzso offers - the single list the API, the Call Flows editor (via
GET /api/flows/builtin) and every call use.

Sarvam Bulbul v3 speakers. By default Roopa, Ritu, Simran and Ishita, Roopa first (today's
English list; Bulbul speakers speak every language, so another language's backend offers them
too). SARVAM_TTS_VOICES replaces the list for this backend (one backend per language). Any other
voice id (an old flow, SARVAM_TTS_SPEAKER or SARVAM_TTS_VOICE_ROTATION naming a voice that is not
offered) plays as DEFAULT_VOICE. Nothing is removed from the Sarvam account; it just isn't offered here.

Cloned voices (SARVAM_TTS_VOICE_<LANG>_FEMALE / _MALE_1 / _MALE_2, "svc-<uuid>") come first, each with its gender;
two of one gender also add a pool ("cloned_male": either of them, picked once per call by resolve_voice). The female
one is DEFAULT_VOICE. The stock list is unchanged; a failed cloned voice falls back to a stock voice of its gender
(app/services/provider_registry.with_clone_fallback).
"""
from __future__ import annotations

import logging
import random
import re
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from app.core.config import CLONED_VOICE_SLOTS, LANGUAGE_NAMES, Settings, cloned_voice_id, settings

log = logging.getLogger("voices")

BUILTIN_VOICES: List[Dict[str, str]] = [
    {"id": "roopa", "name": "Roopa", "gender": "female"},
    {"id": "ritu", "name": "Ritu", "gender": "female"},
    {"id": "simran", "name": "Simran", "gender": "female"},
    {"id": "ishita", "name": "Ishita", "gender": "female"},
]
BUILTIN_DEFAULT = "roopa"

# Genders Sarvam's own documentation states for Bulbul v3 speakers (checked 2026-11-04). Used only for a voice that
# SARVAM_TTS_VOICES lists WITHOUT ":male" / ":female"; a tag there always wins. Any other voice stays without a
# gender (never guessed from its name), so it can't be picked as a male / female AI Agent voice until it is tagged.
#   shubh (male), ishita (female): docs.sarvam.ai .../text-to-speech/voices ("shubh (male) and ishita (female)")
#   ratan, rohan (male), ritu (female): docs.sarvam.ai .../text-to-speech/bulbul-v3-best-practices,
#     "Speaker selection by language", Tamil row: Recommended male "ratan, rohan", Recommended female "ishita, ritu"
DOCUMENTED_GENDERS: Dict[str, str] = {
    "shubh": "male", "ratan": "male", "rohan": "male",
    "ishita": "female", "ritu": "female",
}

_VOICE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def offered_voices(voices_env: str, speaker: str, language: str) -> Tuple[List[Dict[str, str]], str]:
    """(voices, default voice) for a backend speaking `language`. `voices_env` is SARVAM_TTS_VOICES
    ("kavitha:female,mani:male"; an untagged id gets its DOCUMENTED_GENDERS gender, if any); empty or nothing
    usable = the built-in four with Roopa as default.
    With a list of its own, the default is SARVAM_TTS_SPEAKER when listed, else the first voice."""
    label = f"{LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['en'])} (India)"
    voices: List[Dict[str, str]] = []
    for item in (voices_env or "").split(","):
        voice_id, _, gender = item.strip().partition(":")
        voice_id, gender = voice_id.strip().lower(), gender.strip().lower()
        gender = gender or DOCUMENTED_GENDERS.get(voice_id, "")
        if not _VOICE_ID_RE.match(voice_id) or any(v["id"] == voice_id for v in voices):
            continue
        voices.append({"id": voice_id, "name": voice_id.capitalize(),
                       **({"gender": gender} if gender in ("male", "female") else {}), "language": label})
    if not voices:
        return [{**v, "language": label} for v in BUILTIN_VOICES], BUILTIN_DEFAULT
    wanted = (speaker or "").strip().lower()
    return voices, wanted if any(v["id"] == wanted for v in voices) else voices[0]["id"]


def cloned_voice_entries(cfg: Settings) -> List[Dict[str, object]]:
    """This backend's cloned voices as voice-list entries ("cloned": True; the picker labels them "Custom"), female
    first, then male, named by SARVAM_TTS_VOICE_*_NAME. With SARVAM_TTS_VOICE_TA_MALE_EITHER, two or more male ones are
    preceded by their pool ("cloned_male", "pool": [ids]): either voice, picked once per call. A setting that is set
    but holds no cloned voice id is reported and ignored."""
    for _, setting in CLONED_VOICE_SLOTS.get(cfg.call_language, ()):
        raw = getattr(cfg, setting)
        if (raw or "").strip() and cloned_voice_id(raw) is None:
            log.warning("%s is not a Sarvam cloned voice id (svc-...) - ignored", setting)
    label = f"{LANGUAGE_NAMES.get(cfg.call_language, LANGUAGE_NAMES['en'])} (India)"
    out: List[Dict[str, object]] = []
    for gender in ("female", "male"):
        clones = [(slot, v) for slot, v, g in cfg.cloned_voices if g == gender]
        if len(clones) > 1 and cfg.cloned_either(gender):
            out.append({"id": f"cloned_{gender}", "name": f"Either {gender} (per call)", "gender": gender,
                        "language": label, "cloned": True, "pool": [v for _, v in clones]})
        out += [{"id": v, "name": cfg.cloned_voice_name(slot), "gender": gender, "language": label,
                 "cloned": True} for slot, v in clones]
    return out


def is_cloned_voice(voice_id: Optional[str]) -> bool:
    """A Sarvam Instant Voice Cloning id (svc-...): spoken through Sarvam's /voices/clone API, not Bulbul's speakers."""
    return (voice_id or "").startswith("svc-")


STOCK_VOICES, STOCK_DEFAULT_VOICE = offered_voices(settings.SARVAM_TTS_VOICES, settings.SARVAM_TTS_SPEAKER,
                                                   settings.call_language)
STOCK_VOICE_IDS: Tuple[str, ...] = tuple(v["id"] for v in STOCK_VOICES)
CLONED_VOICES = cloned_voice_entries(settings)
# pool id -> its voices ("cloned_male" -> the cloned male voices)
VOICE_POOLS: Dict[str, Tuple[str, ...]] = {str(v["id"]): tuple(v["pool"]) for v in CLONED_VOICES if "pool" in v}

VOICES: List[Dict[str, object]] = CLONED_VOICES + STOCK_VOICES
# The female cloned voice, else the first cloned voice, else the stock default (settings.tts_speaker, as one list).
DEFAULT_VOICE: str = next((str(v["id"]) for v in CLONED_VOICES if "pool" not in v and v["gender"] == "female"),
                          next((str(v["id"]) for v in CLONED_VOICES if "pool" not in v), STOCK_DEFAULT_VOICE))

VOICE_IDS: Tuple[str, ...] = tuple(str(v["id"]) for v in VOICES)


def is_voice_pool(voice_id: Optional[str]) -> bool:
    return (voice_id or "") in VOICE_POOLS


def resolve_voice(voice_id: Optional[str], choose: Optional[Callable[[Sequence[str]], str]] = None) -> Optional[str]:
    """A pool id becomes one of its voices (random.choice unless `choose` is given); any other id is returned
    unchanged. A call does this once, when it starts, and keeps that voice to the end."""
    pool = VOICE_POOLS.get(voice_id or "")
    return (choose or random.choice)(pool) if pool else voice_id


def offered_voice(voice_id: Optional[str]) -> Optional[str]:
    """The offered voice this id names (case-insensitive), else None."""
    v = (voice_id or "").strip().lower()
    return v if v in VOICE_IDS else None


def voice_or_default(voice_id: Optional[str]) -> str:
    """The voice a call actually uses for this id: itself when offered, else DEFAULT_VOICE."""
    return offered_voice(voice_id) or DEFAULT_VOICE


def stock_voice_or_default(voice_id: Optional[str]) -> str:
    """A stock Bulbul voice: this one when offered, else the stock default (the cloned voice's fallback)."""
    v = (voice_id or "").strip().lower()
    return v if v in STOCK_VOICE_IDS else STOCK_DEFAULT_VOICE
