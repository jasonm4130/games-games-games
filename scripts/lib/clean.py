"""Deterministic markdown cleaning for converted rulebooks. No LLM, no network.

Order matters: NFKC first (folds compatibility chars/ligatures), then unstructured bricks,
then the spaced-letter collapse (which NFKC cannot do — letter-spacing is real U+0020 spaces).
"""
import re
import unicodedata

from unstructured.cleaners.core import (
    clean_extra_whitespace,
    clean_ligatures,
    group_broken_paragraphs,
    replace_unicode_quotes,
)

# A run of single-spaced capitals like "K L A U S  T E U B E R" -> "KLAUS TEUBER".
# Match 3+ capitals each followed by a single space (or end), collapse the inner spaces.
_SPACED_CAPS = re.compile(r"\b(?:[A-Z] ){2,}[A-Z]\b")


def _collapse_spaced_caps(text: str) -> str:
    return _SPACED_CAPS.sub(lambda m: m.group(0).replace(" ", ""), text)


def clean_markdown(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = replace_unicode_quotes(text)
    text = clean_ligatures(text)          # covers ae/oe ligatures NFKC leaves alone
    text = group_broken_paragraphs(text)
    text = _collapse_spaced_caps(text)
    # clean_extra_whitespace collapses runs of 2+ spaces but is applied per LINE so markdown
    # structure (blank lines between blocks) survives.
    return "\n".join(clean_extra_whitespace(line) if line.strip() else "" for line in text.split("\n"))
