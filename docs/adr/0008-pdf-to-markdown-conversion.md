---
status: accepted
supersedes: 0005 (partial — the pdfjs extraction mechanism only)
---

# Rulebooks are converted to healed markdown offline, not extracted from PDF at ingest

Ingestion no longer extracts PDF text with `pdfjs-dist` at ingest time. Each Rulebook PDF is
converted **once, offline, to clean markdown** (Docling, escalating to Marker `--use_llm` for
graphically-designed files), **healed** (a bounded Kimi pass + deterministic cleaning), validated,
and stored as the onboarded source. `tools/operator-scripts/ingest.ts` then reads markdown, not PDF.

This **supersedes only the pdfjs-extraction mechanism described in ADR 0005** — the decision that
Ingestion runs as an operator-side Node script (not a Worker) still stands. Only the source format
(PDF → healed markdown) and the extraction tool (pdfjs → Docling/Marker) change.

## Why this is an ADR

Surprising (a Cloudflare/Node app adding a one-time Python conversion stage), the result of a real
trade-off (input quality vs. tool/runtime complexity), and hard to reverse (re-embedding the whole
corpus into an immutable-dims Vectorize index — ADR 0002 — is a full blue/green re-ingest).

## Why convert to markdown

`pdfjs` mangles graphically-designed rulebooks. Catan *Traders & Barbarians* yielded **994** garbage
"caps-headers" (`K L A U S T E U B E R` — letter-spaced *Klaus Teuber*); Monopoly extracted as one
blob with `$1500` buried in a 507-token chunk that opens with 1934 company history. Those chunks
rerank ~0.11 vs ~0.99 for well-isolated facts — the root cause of the Parlour's wording sensitivity
(the rerank-gate fix in the goblin-voice/retrieval-tuning pass treated the symptom). Conversion
produced **141** real `##` headings for the same Catan file and a clean, isolated `$1500` for
Monopoly. Fixing the input is upstream of any gate or chunker tuning.

## Why Docling primary, Marker `--use_llm` escalation

Verified June 2026 against current docs and benchmarks: **Docling** (MIT; IBM → Linux Foundation
AAIF) is CPU-fast (~0.3–3 s/page vs Marker's 5–53 s/page — this is a GPU-less Mac), scores higher on
tables (TEDS 0.887 vs 0.808) and overall (0.882 vs 0.861), and needs **no API key**. So it is the
baseline. **Marker `--use_llm`** (cloud `gemini-2.0-flash`, `GOOGLE_API_KEY`) is a stronger
vision-based extractor for the hardest graphical layouts, so it is the **per-file escalation when
Docling output fails validation** — not a blanket default. MinerU 3.x (local VLM, GPU-hungry; note:
there is no "2.5" release) and Zerox (unmaintained since Dec 2024) are documented alternatives, not
defaults.

## Why heal + validate (not just convert)

Even good conversion leaves residue (~3 letter-spacing artifacts on Catan; and **NFKC does not fix
real `U+0020` letter-spacing** — a dedicated regex does). One bounded, temperature-0 Kimi pass per
`##` section ("only fix, never add") with **character-level alignment trimming** removes residue
without fabricating rules. Three validation layers gate it: deterministic number/character
preservation, bge-m3 embedding similarity, and a sampled Kimi faithfulness judge.

## Consequences

- New offline operator stages: `tools/rulebook-prep/convert-pdfs.py` (Python) + `tools/operator-scripts/heal.ts` +
  `tools/operator-scripts/validate-md.ts` (Node). The Worker hot path is unchanged — it only queries the index.
- **Public-repo copyright:** the repo is public, so healed text of copyrighted rulebooks is **not
  committed** — it lives in R2 + a gitignored local working copy, exactly as the source PDFs already
  do. Only code, validation reports, and public-domain rulebooks are committed.
- **Citations** move from page numbers to section headings (markdown has no pages). A new
  `heading_path` column on `chunks` (migration 0006) becomes the citation anchor; it is kept **out**
  of the `chunks_fts` BM25 index (verified trigger-safe — the FTS triggers reference only
  `text`/`id`). `page_start`/`page_end` remain for any PDF-era rows.
- Re-embedding the corpus is a re-ingest gated on a regenerated Gold set (ADR 0002 immutable dims).
  Because retrieval joins Vectorize ids to D1 rows and re-ingest changes ids, a Vectorize-only
  blue/green over the shared D1 is invalid; the default is a maintenance-window single-index re-ingest
  (true blue/green needs a parallel D1 too). The human performs the prod-mutating steps (remote D1
  migration, Vectorize writes, deploy).
- A Python toolchain becomes an operator dependency, isolated to the conversion stage.
