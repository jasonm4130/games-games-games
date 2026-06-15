"""Unit tests for the deterministic markdown cleaner. Run: uv run pytest scripts/lib

Covers the run-in ALL-CAPS header promotion (the Monopoly-structure fix) and a couple of the
existing deterministic transforms, so a regression in clean.py is caught before it reaches a
full-corpus re-ingest."""

from clean import _promote_runin_headers, clean_markdown


def test_promotes_runin_header_to_atx():
    out = _promote_runin_headers("OBJECT... The object of the game is to win.")
    assert out == "### Object\n\nThe object of the game is to win."


def test_promotes_multiword_header_titlecased():
    out = _promote_runin_headers("BUYING PROPERTY... Whenever you land on an unowned property.")
    assert out.startswith("### Buying Property\n\n")
    assert "Whenever you land on an unowned property." in out


def test_leaves_ordinary_prose_untouched():
    # No trailing "..." -> not a run-in header; an all-caps word mid-sentence must not be promoted.
    prose = "You collect $200 as you pass GO each time around the board."
    assert _promote_runin_headers(prose) == prose


def test_does_not_promote_lowercase_or_single_cap():
    assert _promote_runin_headers("Note... this is just prose.") == "Note... this is just prose."


def test_clean_markdown_end_to_end_promotes_and_unescapes():
    # Docling separates blocks with blank lines, so a run-in header sits at the start of its own line
    # (group_broken_paragraphs only joins lines NOT separated by a blank line).
    raw = "## Monopoly\n\nPlay Cities &amp; Knights.\n\nTHE PLAY... Starting with the Banker, roll."
    out = clean_markdown(raw)
    assert "Cities & Knights" in out  # html.unescape ran
    assert "### The Play" in out  # run-in header promoted
    assert out.endswith("\n")
