from app.core.config import Settings
from app.services import llm_service as llm
from app.services.call_service import fallback_reply


def test_tamil_prompt_requires_spoken_tamil():
    sp = llm.build_system_prompt(llm.DEFAULT_AGENT_PROMPT, {"contact_name": "Arun"}, language="ta")
    assert "spoken Tamil" in sp and "Tamil script" in sp


def test_english_prompt_has_no_language_override():
    sp = llm.build_system_prompt(llm.DEFAULT_AGENT_PROMPT, {}, language="en")
    assert "Tamil" not in sp and llm.language_instruction("en") == ""


def test_language_code_variants():
    assert "Tamil" in llm.language_instruction("Ta")
    assert "Tamil" in llm.language_instruction("ta-IN")


def test_tamil_fallback_and_sarvam_code():
    assert fallback_reply("ta") == "Sorry, clear-ஆ கேக்கல. கொஞ்சம் repeat பண்ணுங்க please."
    assert fallback_reply("en").startswith("Sorry")
    assert Settings(CALL_LANGUAGE="Ta").sarvam_language_code == "ta-IN"


def test_brand_pronounced_kexo():
    from app.services.cartesia_tts import apply_pronunciations

    for variant in ("காக்ஸோ", "கேக்சோ", "காக்ஸ்ஸோ", "காக்ஜ்ஸோ", "Kagzso", "KAGZSO", "kagso"):
        assert apply_pronunciations(f"நான் {variant}-ல இருந்து பேசுறேன்.", "ta") == "நான் கெக்ஸோ-ல இருந்து பேசுறேன்."
    assert apply_pronunciations("This is Priya from Kagzso.", "en") == "This is Priya from Kexo."
    assert apply_pronunciations("வணக்கம் அருண்", "ta") == "வணக்கம் அருண்"  # untouched
    assert 'pronounced "Kexo"' in llm.build_system_prompt("x", {}, language="ta")
    assert "கெக்ஸோ" in llm.build_system_prompt("x", {}, language="ta")


async def test_tts_requests_use_kexo(monkeypatch):
    import json

    import httpx

    from app.core.config import settings
    from app.services.cartesia_tts import CartesiaTTS

    seen = {}

    def handler(req):
        seen["t"] = json.loads(req.content)["transcript"]
        return httpx.Response(200, content=b"\xff")

    monkeypatch.setattr(settings, "CARTESIA_LANGUAGE", "ta")
    tts = CartesiaTTS(settings, client=httpx.AsyncClient(base_url="https://x", transport=httpx.MockTransport(handler)))
    await tts.synthesize("காக்ஸோ நிறுவனம்")
    assert seen["t"] == "கெக்ஸோ நிறுவனம்"


def test_tamil_text_survives_cleanup_and_chunking():
    text = "வணக்கம் அருண், நான் Kagzso-இலிருந்து ப்ரியா பேசுகிறேன். இது பேச சரியான நேரமா?"
    assert llm.clean_spoken_text(text) == text
    ch = llm.SentenceChunker()
    out = ch.feed(text + " ") + ch.flush()
    assert out == ["வணக்கம் அருண், நான் Kagzso-இலிருந்து ப்ரியா பேசுகிறேன்.", "இது பேச சரியான நேரமா?"]
