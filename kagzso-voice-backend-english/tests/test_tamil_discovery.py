"""Tamil-only discovery rule (approved 2026-11-24): an agent's call with no business on file is told to understand the
customer's work and a problem before any product. Every other language keeps CUSTOMER_BUSINESS_ASK_RULES byte for byte
(fingerprints taken before the change)."""
import hashlib

import pytest

from app.services import llm_service as llm

# sha256 (first 16 hex) of customer_business_rules(business, language, opening) before the Tamil change.
BEFORE = {
    ("en", "", False): "647afd1619206a42", ("en", "", True): "d0902fc113366eb1",
    ("en", "hospital", False): "5b358f6114f142d0", ("en", "hospital", True): "5b358f6114f142d0",
    **{(lang, "", False): "e9ae8850239c8eff" for lang in ("hi", "kn", "te")},
    **{(lang, "", True): "d0902fc113366eb1" for lang in ("hi", "kn", "te")},
    **{(lang, "hospital", op): "87fa2b3aa3bbd8b7" for lang in ("hi", "kn", "te") for op in (False, True)},
    # Tamil: only the rule for a call with no business on file, after the opening, changes.
    ("ta", "", True): "d0902fc113366eb1", ("ta", "hospital", False): "5bb8a95a6466e106",
    ("ta", "hospital", True): "5bb8a95a6466e106",
}


@pytest.mark.parametrize("key", list(BEFORE), ids=lambda k: f"{k[0]}-{k[1] or 'none'}-{'opening' if k[2] else 'later'}")
def test_every_other_rule_is_byte_for_byte_unchanged(key):
    language, business, opening = key
    text = llm.customer_business_rules(business, language, opening=opening)
    assert hashlib.sha256(text.encode()).hexdigest()[:16] == BEFORE[key]


def test_english_ask_rules_are_the_original_text():
    assert "and show how AI automation or software could help with it, using only the approved information." in \
        llm.CUSTOMER_BUSINESS_ASK_RULES
    assert llm.customer_business_rules("", "en").endswith(llm.CUSTOMER_BUSINESS_ASK_RULES.replace(
        "{example}", ', with the meaning of "What kind of business do you run?", never word for word'))


def test_tamil_understands_before_it_pitches():
    ta = llm.customer_business_rules("", "ta")
    assert "show how AI automation or software could help with it" not in ta
    assert "Do not talk about the company or what it offers yet" in ta
    assert "ask one follow-up question built from their answer" in ta
    assert "how big it is, since when, and what they do about it today" in ta
    assert "Only once the problem is clear, connect the one help that fits it" in ta
    assert "If they have no problem or no interest, accept it and close politely." in ta
    assert hashlib.sha256(ta.encode()).hexdigest()[:16] != "8b94674f6dc91c4c"  # it did change
