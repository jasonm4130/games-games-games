"""Deterministic markdown cleaning for converted rulebooks. No LLM, no network.

Order matters: NFKC first (folds compatibility chars/ligatures), then unstructured bricks,
then the spaced-letter collapse (which NFKC cannot do — letter-spacing is real U+0020 spaces).
"""
import html
import re
import unicodedata

from unstructured.cleaners.core import (
    clean_extra_whitespace,
    clean_ligatures,
    group_broken_paragraphs,
    replace_unicode_quotes,
)

# A run of letter-spaced capitals -> joined token, e.g. "K  L  A  U  S T  E  U  B  E  R" ->
# "KLAUSTEUBER". Docling encodes letter-spacing with VARIABLE gaps (often 2 spaces between
# letters, 1 between words — the inverse of typographic intuition), so match 1+ spaces between
# each capital. 3-cap minimum avoids touching "D 6" or single caps in prose. The joined token is
# a title/credit proper noun (not rules body), so dropping the intra-run word break is harmless;
# the heal pass restores spacing if it ever matters.
_SPACED_CAPS = re.compile(r"\b(?:[A-Z] +){2,}[A-Z]\b")


def _collapse_spaced_caps(text: str) -> str:
    return _SPACED_CAPS.sub(lambda m: m.group(0).replace(" ", ""), text)


def clean_markdown(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    # Docling's markdown export HTML-escapes literal & < > (e.g. "Cities &amp; Knights"); unescape
    # so the embedded text is human-readable. Runs before quote normalization so any entity-encoded
    # quotes (&quot;, &#8217;) resolve to real chars that replace_unicode_quotes then folds.
    text = html.unescape(text)
    # Docling emits a "<!-- image -->" placeholder per figure (138 in Catan T&B). Strip all HTML
    # comments BEFORE group_broken_paragraphs, which otherwise shreds them across lines into "<!-",
    # "-", "image -", ... noise. Rulebook markdown carries no meaningful HTML comments.
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = replace_unicode_quotes(text)
    text = clean_ligatures(text)          # covers ae/oe ligatures NFKC leaves alone
    text = group_broken_paragraphs(text)
    text = _collapse_spaced_caps(text)
    # clean_extra_whitespace collapses runs of 2+ spaces but is applied per LINE so markdown
    # structure (blank lines between blocks) survives.
    text = "\n".join(clean_extra_whitespace(line) if line.strip() else "" for line in text.split("\n"))
    # Collapse the runs of blank lines left by stripped image comments to a single blank line.
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
