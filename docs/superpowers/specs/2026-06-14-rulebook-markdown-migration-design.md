# Rulebook Markdown Migration & Healing — Design

- **Date:** 2026-06-14
- **Status:** Accepted
- **Scope:** Replace the PDF→pdfjs extraction step in Ingestion with a one-time **PDF→clean-markdown
  conversion + healing** pipeline, then make chunking markdown-structure-aware, re-ingest the
  Catalogue, and ship the held rerank-gate fix + Uno on the cleaner foundation.

## Goal

The Parlour over-refuses semantically-equivalent paraphrases ("How much money does each player start
with?" → *"That is not in my rulebook"*). Across a long diagnosis (see
`docs/superpowers/specs/2026-06-14-goblin-voice-and-retrieval-tuning-design.md` and the
`chunking-rework-holds-gate-and-uno` memory) the proximate cause was the rerank gate, but the **root
cause is input quality**: `pdfjs-dist` mangles graphically-designed rulebooks, so the facts land in
chunks that rerank poorly no matter how the gate or chunker is tuned.

Empirical proof (ran both converters against our two worst rulebooks before committing to this):

| Rulebook | pdfjs (current) | Markdown converter |
| --- | --- | --- |
| Catan *Traders & Barbarians* | **994** garbage "caps-headers" (`K L A U S T E U B E R` — letter-spaced *Klaus Teuber*; `HHHH`; `A2A2`), 218 chunks | **141** real `##` headings |
| Monopoly | one undifferentiated blob, no headings; `$1500` buried in a 507-token chunk that opens with the 1934 company-history intro | clean `$1500`, real section headings |

When `$1500` shares a chunk with unrelated history, the chunk reranks ~0.11 (vs ~0.99 for a
well-isolated fact). Fix the input and the fact isolates; the gate and chunker then work as designed.

This supersedes the *"no change to the chunking pipeline"* deferral in the goblin-voice/retrieval-
tuning design — that pass correctly fixed the symptom (the gate) and explicitly left the root cause
for here.

## Constraints that shape the design

- **The repo is PUBLIC** (`github.com/jasonm4130/games-games-games`). Committing full healed
  rulebook text republishes third-party copyright. The source PDFs already live in **R2, not git**,
  for this reason — healed markdown follows the same rule. **Only code, validation reports, and
  genuinely public-domain rulebooks may be committed.** Copyrighted healed markdown lives in R2 (+ a
  gitignored local working copy). This bends the healing research's "markdown in git for reviewable
  diffs" recommendation: reviewability comes from the committed *validation reports* and local diffs,
  not public git history.
- **Vectorize dims are immutable** (`@cf/baai/bge-m3`, 1024, cosine — ADR 0002). Re-embedding the
  whole corpus = a full re-ingest. We do it **blue/green** against a parallel index and gate on the
  Gold set before cutover.
- **Ingestion is already operator-side** (ADR 0005). Adding an offline Python conversion step fits
  that model; the Worker hot path never touches a PDF or a converter — it only ever queries the
  index.
- **Citations currently anchor on page numbers** (`src/client/theme.ts:19-23` renders `p.N`).
  Markdown has no page numbers but has section headings — a strict UX upgrade, but it requires a
  schema column and plumbing (below).

## Sourcing: convert our own PDFs

Finding pre-made clean markdown is a dead end — `pagat.com` and equivalents are © all-rights-
reserved, and zero of our titles have a usable open-markdown source. We **convert the PDFs we
already hold in R2**, with per-game exceptions:

| Game | Plan |
| --- | --- |
| **Uno** | **Hand-write** clean markdown in our own words (single product sheet; conversion is overkill). Copyrighted → R2/gitignored, not committed. |
| **Monopoly** (and any Hasbro title) | **Keep, internal-only** (your decision). Convert + ingest as today; healed markdown stays in R2/gitignored, never committed. |
| **Euchre / Five Hundred** | Public-domain card games. Source from Wikipedia or request pagat permission; this markdown **may be committed**. |
| **All other titles** | Convert from the R2 PDF; healed markdown → R2/gitignored. |

## Pipeline

Four offline operator stages. **Python only for the unavoidable conversion + deterministic clean;
everything LLM/embedding stays in the existing Node/TypeScript plumbing** (`scripts/lib/wrangler.ts`,
the Moonshot + Workers-AI-REST patterns already in `ingest.ts`).

```
R2 PDF ─┬─ [1] convert-pdfs.py (Python) ─ Marker(/--use_llm | Docling) + unstructured clean + NFKC ─→ raw .md
        │
raw .md ─ [2] heal.ts (Node) ─ per-##-section bounded Kimi heal + char-alignment trim ──────────────→ healed .md
        │
healed .md ─ [3] validate-md.ts (Node) ─ number/char diff + bge-m3 similarity + sampled LLM-judge ──→ report (committed)
        │
healed .md ─ [4] ingest.ts (Node, modified) ─ extractMarkdown + markdown-aware chunkPages ──────────→ blue index + D1
```

### [1] Convert — `scripts/convert-pdfs.py` (Python, new)

- **Marker** primary (offline Python CLI; clean PDFs like Monopoly, Sushi Go!).
- **Marker `--use_llm`** for graphically-designed hard cases (Catan T&B) — the "vision-LLM converter"
  the healing research wanted: prevents artifacts at extraction rather than repairing them. **MinerU
  2.5 / Zerox** are drop-in alternatives if Marker's LLM mode underperforms on a file.
- **Docling** as fallback when Marker chokes on a specific PDF.
- Then a deterministic clean pass on the raw markdown: `unstructured.io` cleaning bricks
  (`replace_unicode_quotes`, `clean_extra_whitespace`, ligature/control-char strip) + **NFKC**
  normalization. This removes most artifacts at zero LLM cost.
- Output: raw `.md` to a gitignored local `rulebooks/<game>/<doc>.md` and uploaded to R2.
- **Toolchain note:** adds a Python dependency for the operator (managed via `uv`/`pip`; documented
  in the plan). Acceptable for an offline operator step (ADR 0005 already establishes operator-side
  tooling); the Node hot path is unaffected.

### [2] Heal — `scripts/heal.ts` (Node, new)

Residual artifacts survive even good conversion (~3 letter-spacing cases on Catan). One **bounded**
LLM pass, reusing the existing Moonshot/Kimi plumbing from `contextualBlurbs`:

- **One Kimi pass per `##` section**, `temperature: 0`, prompt locked to *"only fix existing text,
  never add, never summarize, never reorder"*. One pass — not a loop.
- **Character-level alignment trimming** is the key anti-hallucination guardrail: diff each healed
  section against its raw section at the character level and **reject any span the model *added*
  rather than corrected**. A heal that grows the text beyond alignment tolerance is discarded and the
  raw section kept.
- Output: healed `.md` (same storage rule as raw — R2/gitignored, or committed for PD games).

### [3] Validate — `scripts/validate-md.ts` (Node, new)

Three layers; reuses the Xenova/bge-m3 tokenizer + Workers AI REST embeddings already in the repo:

1. **Deterministic preservation diff** — every number and currency figure in the raw must survive
   into the healed (`$1500` must not become `$1,500` or `$150`); character-preservation ratio above a
   threshold. Hard fail on a missing number.
2. **bge-m3 embedding similarity** — healed-vs-raw per section; flag drift below a threshold for
   human review.
3. **Sampled Kimi LLM-judge faithfulness** — on a sample of sections, ask for verbatim quotes
   supporting "the healed text adds no rule absent from the raw."

The **validation report is committed** (`docs/research/` or `eval/`) — it is the reviewable artifact
that replaces public git diffs of the (copyrighted) markdown.

### [4] Ingest — `scripts/ingest.ts` (Node, modified)

- Replace the source contract: `--r2-key <pdf>` → `--md-path <local healed .md>` (the file the heal
  step just produced and the operator reviewed). The same markdown is mirrored to R2, preserving ADR
  0005's "R2 is the onboarded source."
- Replace `extractPages` (pdfjs) with **`extractMarkdown`**: read the `.md`, split into
  heading-delimited sections, return a `PageText[]`-shaped structure (`pageNumber` retired; carry the
  section/heading instead — see chunking).
- Everything downstream (contextual blurbs, bge-m3 embed, blue-index upsert, D1 rows) is unchanged
  except the new `heading_path` column (below).

## Markdown-aware chunking (`src/server/rag/chunk.ts`)

- Replace the `NUMBERED_HEADING` regex (`chunk.ts:61`, digit-led only) with **markdown `##`/`###`
  heading** detection. Markdown headings are explicit and reliable, unlike the heuristics that
  over-fired on extraction artifacts (the abandoned ALL-CAPS approach).
- **Respect heading boundaries in the greedy merge** (`chunk.ts:158-176`): never fuse text across an
  `##` boundary just to reach `CHUNK_TARGET_TOKENS`. This kills the "fact + unrelated intro in one
  chunk" defect directly. Keep the token-budget cap and overlap carry.
- **Fold the heading path into the contextual blurb / embed text.** The heading path is high-signal
  context; this is exactly Anthropic's Contextual Retrieval, which cut failed retrievals **35%**
  (contextual embeddings) → **49%** (+BM25) → **67%** (+reranking) — we already run all three legs.

## Citations: page numbers → section headings

- Add `heading_path TEXT` to `chunks` (**migration 0006** + the hand-synced `src/server/db/schema.ts`
  mirror). Today `chunk.ts` computes `headingPath` but `ingest.ts`'s INSERT drops it — we now store
  it.
- Plumb it through `retrieve.ts` → the `Citation` type (`src/shared/types.ts`) → `theme.ts`. For
  markdown sources, `page_start`/`page_end` are null and the citation label renders the section
  heading (e.g. *"§ Getting Out of Jail"*) instead of `p.N`. Keep the page columns for back-compat
  with any PDF-sourced rows.

## Re-ingest: blue/green + Gold-set regeneration

- Stand up a **parallel Vectorize index** (the "blue" index) via the central infra repo
  (`../jasonm4130-cf`, ADR 0003 — magodo/restful stopgap), same dims/metric. Re-ingest **all affected
  games in one pass** (your earlier decision) into blue.
- **Gate on the Gold set before cutover**: re-ingest changes every chunk id, so the existing
  `eval/gold/catalogue.json` `expectedChunkIds` go stale. Regenerate via `pnpm gen-gold` per game +
  operator curation (the propose-then-curate flow in `gen-gold.ts`), then run `pnpm eval` against
  blue and require Hit-Rate@5 / Recall@20 at least as good as the current green index.
- **Cut over** by switching the Worker's Vectorize binding to blue, then retire green.
- The **prod-mutating steps** (central-repo `make apply` for the blue index, remote D1 migration,
  Vectorize writes, binding cutover, deploy) are performed by the human — workflows/scripts prepare
  but do not apply them.

## Ship the held work on the clean foundation

Once blue passes the Gold gate and is cut over:

- **Rerank-gate fix** — `RERANK_MIN_SCORE` 0.2 → 0.05 (already staged in `models.ts`) + the two
  Monopoly regression Gold entries (already staged) ship together.
- **Uno** — ingest the hand-written Uno markdown through the new pipeline.

## ADR 0008

`docs/adr/0008-pdf-to-markdown-conversion.md` records the decision to **convert PDFs to healed
markdown offline rather than extract PDF text at ingest with pdfjs**. It **supersedes only ADR 0005's
pdfjs-extraction claim** — the operator-side-Node-script decision itself still stands; only the
extraction tool and source format change. Captures: the input-quality root cause, the public-repo
copyright constraint, the Marker/heal/validate trade-off, and the Python-toolchain consequence.

## Files touched

- **New:** `scripts/convert-pdfs.py` (Python), `scripts/heal.ts`, `scripts/validate-md.ts`,
  `migrations/0006_chunks_heading_path.sql`, `docs/adr/0008-pdf-to-markdown-conversion.md`, a
  committed validation report.
- **Modified:** `scripts/ingest.ts` (`--md-path`, `extractMarkdown`, store `heading_path`),
  `src/server/rag/chunk.ts` (markdown-heading segmentation, boundary-respecting merge, heading in
  embed text), `src/server/rag/chunk.test.ts` (markdown-heading tests), `src/server/db/schema.ts`
  (`heading_path`), `src/shared/types.ts` (`Citation.headingPath`), `src/server/rag/retrieve.ts` +
  `src/server/agent-core.ts` (plumb `heading_path`), `src/client/theme.ts` (render heading),
  `src/server/rag/models.ts` (un-hold the 0.05 gate), `eval/gold/catalogue.json` (regenerated),
  `CONTEXT.md` (Chunk/Citation glossary if anchors change), `CLAUDE.md` (drop the "pdfjs" gotcha),
  `.gitignore` (`rulebooks/`).

## Success criteria

- **Root cause fixed (acceptance):** on the blue index, the Monopoly starting-money and escape-Jail
  paraphrases (the staged Gold regression rows) return real rulings, not `NOT_COVERED`; the `$1500`
  fact sits in its own heading-scoped chunk and reranks well above the 0.05 floor. Verified live
  during `pnpm dev` against blue (Workers AI always hits the network — integration check, not unit).
- **No fabrication:** `validate-md.ts` passes for every converted rulebook — zero missing numbers,
  similarity above threshold, LLM-judge faithfulness clean. Catan T&B (the hardest) passes first.
- **No regression elsewhere:** `pnpm eval` on blue ≥ green on Hit-Rate@5 and Recall@20 across the
  Catalogue before cutover.
- **Refusal still works:** a genuinely off-topic question still returns `NOT_COVERED`.
- **Unit tests:** `chunk.test.ts` covers markdown-heading segmentation and boundary-respecting merge.
- `pnpm check`, `pnpm test`, `pnpm build` green.

## Sequencing & risks

1. **Prove the whole pipeline end-to-end on Catan T&B first** (the hardest PDF): convert → heal →
   validate → chunk → ingest to a throwaway blue index → eval. If Catan survives, the easy games are
   trivial. Do not build out the rollout before this spike passes.
2. Build the markdown-aware chunker + `heading_path` plumbing (unit-tested, no prod mutation).
3. Convert + heal + validate the rest of the Catalogue (all affected games, one pass).
4. Blue/green re-ingest; regenerate + curate Gold; eval-gate; **human** cuts over.
5. Ship the 0.05 gate fix + Uno on the clean index.

- **Risk — LLM heal hallucination:** mitigated by temp-0 + "only fix" prompt + character-alignment
  trimming + the deterministic number-preservation gate. A section that fails validation keeps its
  raw text.
- **Risk — converter cost/quality on hard PDFs:** Marker `--use_llm` (and MinerU/Zerox fallbacks)
  spend LLM credits on Catan-class files; bounded by being a one-time offline step on a small
  Catalogue.
- **Risk — Gold churn:** every chunk id changes; the blue/green gate forces a regenerated, curated
  Gold set before cutover rather than trusting stale ids.
- **Risk — Python toolchain:** new operator dependency; isolated to the conversion stage, documented
  in the plan, never on the Worker path.
