# Rulebook Markdown Migration & Healing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pdfjs PDF extraction with an offline PDF→clean-markdown conversion + healing
pipeline, make chunking markdown-structure-aware, re-ingest the Catalogue blue/green, and ship the
held rerank-gate fix + Uno on the cleaner foundation — eliminating the paraphrase over-refusal whose
root cause is input quality.

**Architecture:** Four offline operator stages — `convert-pdfs.py` (Python: Docling, escalating to
Marker `--use_llm`; deterministic clean) → `heal.ts` (Node: bounded Kimi per-`##`-section heal +
character-alignment guardrail) → `validate-md.ts` (Node: number/char preservation + bge-m3 similarity
+ sampled LLM judge) → `ingest.ts` (Node: reads markdown, markdown-aware chunking, stores
`heading_path`). The Worker hot path is unchanged. Re-ingest is blue/green against a parallel
Vectorize index, gated on a regenerated Gold set; the human performs all prod-mutating steps.

**Tech Stack:** TypeScript (Worker + operator scripts, Vitest, Biome), Python via `uv` (Docling,
unstructured, marker-pdf), Kimi k2.7 (Moonshot REST), bge-m3 (Workers AI REST), Vectorize / D1
(Drizzle + FTS5) / R2, Cloudflare Workers.

**Design source of truth:** `docs/superpowers/specs/2026-06-14-rulebook-markdown-migration-design.md`
and `docs/adr/0008-pdf-to-markdown-conversion.md`. All file/line anchors below were verified against
the working tree on 2026-06-14.

**Security / process constraints (carry through every task):**
- The repo is **public** — never commit healed text of copyrighted rulebooks. Copyrighted `.md` →
  R2 + gitignored `rulebooks/`. Only code, validation reports, and public-domain rulebooks are
  committed.
- Workflows/scripts must **not** apply remote D1 migrations, create the Vectorize index, write
  Vectorize, deploy, or git push. The **human** performs every prod-mutating step (Phase 3).
- Never set `CLOUDFLARE_API_TOKEN`; cloud commands run with `env -u CLOUDFLARE_API_TOKEN`. Secrets
  (`MOONSHOT_API_KEY`, `GOOGLE_API_KEY`, `EVAL_SECRET`, `ELEVENLABS_API_KEY`) are never printed.
- `pnpm check` / `pnpm test` / `pnpm build` must be green before any task is called done; quote a
  success line.

---

## File Structure

**New files:**
- `scripts/convert-pdfs.py` — Python: Docling/Marker conversion + deterministic clean. One responsibility: PDF bytes → cleaned raw markdown on disk + R2.
- `scripts/lib/clean.py` — Python: the deterministic clean functions (NFKC, unstructured bricks, spaced-letter regex), importable + unit-testable.
- `scripts/heal.ts` — Node: per-section Kimi heal orchestration.
- `scripts/lib/align.ts` — pure character-alignment guardrail (`alignmentInsertions`, `acceptHeal`). Shared, unit-tested.
- `scripts/lib/align.test.ts` — Vitest for the guardrail.
- `scripts/validate-md.ts` — Node: 3-layer validation orchestration; writes a committed report.
- `scripts/lib/preserve.ts` — pure number/char preservation checks (`extractNumbers`, `missingNumbers`, `charPreservationRatio`). Shared, unit-tested.
- `scripts/lib/preserve.test.ts` — Vitest.
- `migrations/0006_chunks_heading_path.sql` — adds `heading_path` to `chunks` (NOT to FTS).
- `pyproject.toml` — pins the Python toolchain (docling, unstructured, marker-pdf) for the operator.

**Prerequisite (already created):** `docs/adr/0008-pdf-to-markdown-conversion.md` exists in the repo
and records this decision; no task creates it. Tasks reference it.

**Modified files:**
- `src/server/rag/chunk.ts` — module-scope `enforceCap`; new `parseMarkdownSections` + `chunkMarkdown`; ATX-heading awareness.
- `src/server/rag/chunk.test.ts` — markdown-section + boundary-merge tests.
- `src/shared/types.ts` — `ChunkInput.pageStart/pageEnd` → nullable; `Chunk.headingPath`; widen `RetrievedChunk` Pick; `Citation.headingPath?`.
- `src/server/db/schema.ts` — `headingPath` column on `chunks`.
- `scripts/ingest.ts` — `--md-path`; drop pdfjs `extractPages`/`fetchPdf`; `readMarkdown`; `chunkMarkdown`; INSERT writes `heading_path`; nullable page handling.
- `src/server/rag/retrieve.ts` — select + map `headingPath`.
- `src/server/agent-core.ts` — `toCitations` carries `headingPath`.
- `src/client/theme.ts` — `sourceLabel()` prefers heading over page.
- `eval/gold/catalogue.json` — regenerated after re-ingest (Phase 3).
- `.gitignore` — `rulebooks/`, `.venv/`, validation working dirs.
- `CLAUDE.md` — drop the stale "pdfjs" extraction gotcha; point at ADR 0008.

---

## Phase 0 — Toolchain & converter

### Task 1: Python toolchain + gitignore

**Files:**
- Create: `pyproject.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Pin the Python tools**

Create `pyproject.toml`:

```toml
[project]
name = "ggg-rulebook-tools"
version = "0.0.0"
description = "Offline operator tooling: PDF -> healed markdown (not shipped to the Worker)"
requires-python = ">=3.11"
dependencies = [
  "docling>=2.102.1",
  "unstructured>=0.23.1",
  "marker-pdf>=1.10.2",   # escalation only (--use_llm); needs GOOGLE_API_KEY at runtime
]
```

- [ ] **Step 2: Ignore generated + local-only artifacts**

Append to `.gitignore`:

```
# Operator-side rulebook conversion (copyrighted markdown stays out of the public repo)
rulebooks/
.venv/
scripts/.validate-cache/
```

- [ ] **Step 3: Create the env and verify the converters import**

Run:
```bash
cd /Users/jasonmatthew/Work/Git/games-games-games
uv venv && uv pip install -e .
uv run python -c "import docling, unstructured; from docling.document_converter import DocumentConverter; print('docling+unstructured OK')"
```
Expected: `docling+unstructured OK` (first run downloads Docling models — may take a minute).

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml .gitignore
git commit -m "build: pin offline python rulebook-conversion toolchain"
```

---

### Task 2: Deterministic clean functions (`scripts/lib/clean.py`)

The clean pass is separated from conversion so it is importable and the spaced-letter regex is
testable. **Key verified fact:** NFKC does NOT collapse `K L A U S` (real `U+0020`); a dedicated
regex does.

**Files:**
- Create: `scripts/lib/clean.py`

- [ ] **Step 1: Write the clean module**

```python
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
```

- [ ] **Step 2: Sanity-check the spaced-caps collapse**

Run:
```bash
uv run python -c "from scripts.lib.clean import clean_markdown; print(clean_markdown('K L A U S  T E U B E R designed Catan'))"
```
Expected: `KLAUS TEUBER designed Catan`

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/clean.py
git commit -m "feat(convert): deterministic markdown clean (NFKC + unstructured + spaced-caps)"
```

---

### Task 3: The converter (`scripts/convert-pdfs.py`)

Docling primary; Marker `--use_llm` escalation behind a flag. Reads a local PDF (operator has it, or
pulls from R2 via wrangler first), writes cleaned raw `.md` locally and uploads it to R2.

**Files:**
- Create: `scripts/convert-pdfs.py`

- [ ] **Step 1: Write the converter**

```python
"""Convert a rulebook PDF to cleaned raw markdown (Docling primary, Marker --use_llm escalation).

Usage:
  uv run python scripts/convert-pdfs.py --pdf /path/in.pdf --out rulebooks/catan/tb.md \
      [--engine docling|marker] [--r2-key catan/tb.md]

Docling needs no API key. --engine marker uses Marker with --use_llm (cloud Gemini, needs
GOOGLE_API_KEY) and is the escalation for graphically-designed files Docling mangles. R2 upload
(when --r2-key is given) rides the wrangler login; CLOUDFLARE_API_TOKEN is stripped.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from scripts.lib.clean import clean_markdown

R2_BUCKET = "ggg-rulebooks"


def convert_docling(pdf: Path) -> str:
    from docling.document_converter import DocumentConverter

    result = DocumentConverter().convert(str(pdf))
    return result.document.export_to_markdown()


def convert_marker(pdf: Path) -> str:
    if not os.environ.get("GOOGLE_API_KEY"):
        sys.exit("--engine marker needs GOOGLE_API_KEY for --use_llm")
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(
            ["marker_single", str(pdf), "--use_llm", "--output_format", "markdown", "--output_dir", out],
            check=True,
        )
        md = next(Path(out).rglob("*.md"), None)
        if md is None:
            sys.exit("marker produced no markdown")
        return md.read_text(encoding="utf-8")


def upload_r2(local: Path, r2_key: str) -> None:
    env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}
    subprocess.run(
        ["wrangler", "r2", "object", "put", f"{R2_BUCKET}/{r2_key}", "--file", str(local), "--remote"],
        check=True,
        env=env,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", choices=["docling", "marker"], default="docling")
    ap.add_argument("--r2-key")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    raw = convert_marker(pdf) if args.engine == "marker" else convert_docling(pdf)
    cleaned = clean_markdown(raw)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(cleaned, encoding="utf-8")
    print(f"-> wrote {out} ({len(cleaned)} chars, engine={args.engine})")

    if args.r2_key:
        upload_r2(out, args.r2_key)
        print(f"-> uploaded to {R2_BUCKET}/{args.r2_key}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify CLI wiring (no conversion yet)**

Run: `uv run python scripts/convert-pdfs.py --help`
Expected: usage text listing `--pdf --out --engine --r2-key`.

- [ ] **Step 3: Commit**

```bash
git add scripts/convert-pdfs.py
git commit -m "feat(convert): docling-primary PDF->markdown converter with marker escalation"
```

---

## Phase 1 — Heal & validate (TDD the pure cores), prove on Catan

### Task 4: Character-alignment guardrail (`scripts/lib/align.ts`) — TDD

The anti-hallucination guard. **Character-level** (not word-level) is required: collapsing
`K L A U S`→`KLAUS` is pure deletion (zero insertions → accept), while a fabricated rule is
insertion (→ reject). Word-level would wrongly reject the space-collapse.

**Files:**
- Create: `scripts/lib/align.ts`, `scripts/lib/align.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { acceptHeal, alignmentInsertions } from "./align";

describe("alignmentInsertions", () => {
  it("is zero when healed is a subsequence of raw (pure deletion: spaced-caps collapse)", () => {
    expect(alignmentInsertions("K L A U S", "KLAUS")).toBe(0);
  });
  it("counts inserted characters for fabricated content", () => {
    expect(alignmentInsertions("roll the dice", "roll the dice and win instantly")).toBeGreaterThan(10);
  });
});

describe("acceptHeal", () => {
  it("accepts identical text", () => {
    expect(acceptHeal("Pay $200.", "Pay $200.").accepted).toBe(true);
  });
  it("accepts a small casing/punctuation fix", () => {
    expect(acceptHeal("pay $200", "Pay $200.").accepted).toBe(true);
  });
  it("accepts a spaced-caps collapse (deletion only)", () => {
    expect(acceptHeal("S E T U P phase", "SETUP phase").accepted).toBe(true);
  });
  it("rejects a fabricated sentence (insertion over tolerance)", () => {
    const raw = "Move your token clockwise.";
    const healed = "Move your token clockwise. You may also teleport once per game.";
    expect(acceptHeal(raw, healed).accepted).toBe(false);
  });
  it("rejects gross growth without running LCS", () => {
    expect(acceptHeal("short", "short " + "x".repeat(100)).accepted).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/lib/align.test.ts`
Expected: FAIL — "Cannot find module './align'".

- [ ] **Step 3: Implement**

```ts
/** Character-level alignment guardrail for the heal pass. Pure, dependency-free. */

/** Length of the longest common subsequence of a and b (O(min) space). */
function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array(short.length + 1).fill(0);
  for (let i = 0; i < long.length; i++) {
    const curr = new Array(short.length + 1).fill(0);
    for (let j = 0; j < short.length; j++) {
      curr[j + 1] = long[i] === short[j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    prev = curr;
  }
  return prev[short.length];
}

/** Characters present in `healed` that are NOT part of a common subsequence with `raw`. */
export function alignmentInsertions(raw: string, healed: string): number {
  return healed.length - lcsLength(raw, healed);
}

export interface HealVerdict {
  accepted: boolean;
  insertions: number;
  reason: string;
}

export interface AcceptHealOptions {
  /** Reject before LCS if healed grows beyond this fraction of raw length. */
  maxGrowth?: number;
  /** Per-section absolute insertion tolerance (casing/punctuation fixes). */
  baseTolerance?: number;
  /** Plus this fraction of raw length, for legitimate small edits in longer sections. */
  toleranceRatio?: number;
}

/** Decide whether a healed section is a faithful correction of raw (else keep raw). */
export function acceptHeal(raw: string, healed: string, opts: AcceptHealOptions = {}): HealVerdict {
  const maxGrowth = opts.maxGrowth ?? 0.15;
  const baseTolerance = opts.baseTolerance ?? 8;
  const toleranceRatio = opts.toleranceRatio ?? 0.02;

  if (healed.length > raw.length * (1 + maxGrowth)) {
    return { accepted: false, insertions: healed.length - raw.length, reason: "exceeds max growth" };
  }
  const insertions = alignmentInsertions(raw, healed);
  const tolerance = Math.max(baseTolerance, Math.floor(raw.length * toleranceRatio));
  return insertions <= tolerance
    ? { accepted: true, insertions, reason: "within tolerance" }
    : { accepted: false, insertions, reason: `insertions ${insertions} > tolerance ${tolerance}` };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run scripts/lib/align.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/align.ts scripts/lib/align.test.ts
git commit -m "feat(heal): character-alignment guardrail against heal hallucination"
```

---

### Task 5: Heal orchestration (`scripts/heal.ts`)

One bounded Kimi pass per `##` section, temperature 0, "only fix never add", each section gated by
`acceptHeal`. Reuses the Moonshot plumbing pattern from `scripts/ingest.ts` (`contextualBlurbs`,
`requireEnv`).

**Files:**
- Create: `scripts/heal.ts`

- [ ] **Step 1: Write the heal script**

```ts
/**
 * heal.ts — one bounded Kimi pass per markdown section to remove residual conversion artifacts.
 *
 * Each "## ..." (or top preamble) section is healed independently at temperature 0 with a strict
 * "only fix, never add" prompt, then gated by the character-alignment guardrail (scripts/lib/align):
 * a section whose heal inserts content beyond tolerance is DISCARDED and its raw text kept. Never
 * fabricates rules. Reads/writes local markdown; no D1/Vectorize/R2 writes.
 *
 * Usage: MOONSHOT_API_KEY=... pnpm tsx scripts/heal.ts --in rulebooks/catan/tb.md --out rulebooks/catan/tb.healed.md
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { acceptHeal } from "./lib/align";
import { fail, requireEnv } from "./lib/wrangler";

const MOONSHOT_API = "https://api.moonshot.ai/v1";
const HEAL_MODEL = "kimi-k2.7-code";
const HEAL_SYSTEM =
  "You repair OCR/conversion artifacts in a single tabletop-rulebook markdown section. " +
  "Fix ONLY: broken words, letter-spacing, mojibake, stray hyphenation, and obvious spacing. " +
  "NEVER add, remove, summarize, reorder, or rephrase rules. NEVER invent numbers. " +
  "Preserve every number and markdown heading verbatim. Output ONLY the corrected section text.";

// Split on ATX headings, keeping each heading with its body. Mirrors parseMarkdownSections intent.
function splitSections(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length) {
      sections.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length) sections.push(buf.join("\n"));
  return sections;
}

async function healSection(raw: string, apiKey: string): Promise<string> {
  if (!raw.trim()) return raw;
  const response = await fetch(`${MOONSHOT_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HEAL_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: HEAL_SYSTEM },
        { role: "user", content: raw },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Moonshot ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { choices: { message: { content: string } }[] };
  const healed = json.choices[0]?.message?.content ?? raw;
  const verdict = acceptHeal(raw, healed);
  if (!verdict.accepted) {
    console.warn(`  ! kept raw section (${verdict.reason})`);
    return raw;
  }
  return healed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { in: { type: "string" }, out: { type: "string" } } });
  const inPath = values.in ?? fail("--in is required");
  const outPath = values.out ?? fail("--out is required");
  const apiKey = requireEnv("MOONSHOT_API_KEY");

  const sections = splitSections(await readFile(inPath, "utf-8"));
  console.log(`-> healing ${sections.length} sections from ${inPath}`);
  const healed: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    console.log(`  section ${i + 1}/${sections.length}`);
    healed.push(await healSection(sections[i], apiKey));
  }
  await writeFile(outPath, healed.join("\n"));
  console.log(`-> wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it loads + arg-guards (no API call)**

Run: `pnpm tsx scripts/heal.ts` (no args)
Expected: exits non-zero with `--in is required`.

- [ ] **Step 3: Commit**

```bash
git add scripts/heal.ts
git commit -m "feat(heal): bounded per-section Kimi heal gated by alignment guardrail"
```

---

### Task 6: Preservation checks (`scripts/lib/preserve.ts`) — TDD

**Files:**
- Create: `scripts/lib/preserve.ts`, `scripts/lib/preserve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { charPreservationRatio, extractNumbers, missingNumbers } from "./preserve";

describe("extractNumbers", () => {
  it("extracts currency and plain numbers, comma-normalized", () => {
    expect(extractNumbers("Each player gets $1,500 and rolls 2 dice")).toEqual(["1500", "2"]);
  });
});

describe("missingNumbers", () => {
  it("is empty when all raw numbers survive", () => {
    expect(missingNumbers("collect $200 at GO", "You collect $200 when passing GO")).toEqual([]);
  });
  it("flags a dropped or mutated number", () => {
    expect(missingNumbers("start with $1500", "start with $150")).toEqual(["1500"]);
  });
});

describe("charPreservationRatio", () => {
  it("is 1 for identical text", () => {
    expect(charPreservationRatio("abc", "abc")).toBe(1);
  });
  it("is high for a minor fix and low for a rewrite", () => {
    expect(charPreservationRatio("Pay $200", "Pay $200.")).toBeGreaterThan(0.9);
    expect(charPreservationRatio("Pay $200", "Completely different text here")).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/lib/preserve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** Deterministic preservation checks for the heal/validate gate. Pure. */
import { alignmentInsertions } from "./align";

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;

/** All numbers in `text`, commas stripped (so "$1,500" and "1500" compare equal). */
export function extractNumbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/[$,]/g, ""));
}

/** Numbers present in `raw` but missing from `healed` (multiset difference). */
export function missingNumbers(raw: string, healed: string): string[] {
  const have = new Map<string, number>();
  for (const n of extractNumbers(healed)) have.set(n, (have.get(n) ?? 0) + 1);
  const missing: string[] = [];
  for (const n of extractNumbers(raw)) {
    const c = have.get(n) ?? 0;
    if (c > 0) have.set(n, c - 1);
    else missing.push(n);
  }
  return missing;
}

/** 1 - (insertions / healed length). 1 means healed adds nothing relative to raw. */
export function charPreservationRatio(raw: string, healed: string): number {
  if (healed.length === 0) return raw.length === 0 ? 1 : 0;
  return 1 - alignmentInsertions(raw, healed) / healed.length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run scripts/lib/preserve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/preserve.ts scripts/lib/preserve.test.ts
git commit -m "feat(validate): pure number/char-preservation checks"
```

---

### Task 7: Validation orchestration (`scripts/validate-md.ts`)

Three layers: (1) deterministic — `missingNumbers` must be empty, `charPreservationRatio` above
threshold per section (hard fail); (2) bge-m3 similarity raw-vs-healed per section (warn below
threshold) via Workers AI REST (reuse `resolveCloudflareAuth`, `EMBEDDING_MODEL`); (3) sampled Kimi
faithfulness judge. Writes a committed JSON report.

**Files:**
- Create: `scripts/validate-md.ts`

- [ ] **Step 1: Write the validator**

```ts
/**
 * validate-md.ts — gate a healed rulebook markdown against its raw conversion. Read-only w.r.t.
 * D1/Vectorize. Writes a committed report (the reviewable artifact, since copyrighted markdown is
 * not committed). Layers: deterministic number/char preservation (hard fail), bge-m3 similarity
 * (warn), sampled Kimi faithfulness (warn). Exit non-zero on any hard fail.
 *
 * Usage: pnpm tsx scripts/validate-md.ts --raw rulebooks/catan/tb.md --healed rulebooks/catan/tb.healed.md \
 *   --report docs/research/validation/catan-tb.json [--min-similarity 0.92] [--min-preservation 0.85]
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { EMBEDDING_MODEL } from "../src/server/rag/models";
import { CF_API, fail, requireEnv, resolveCloudflareAuth } from "./lib/wrangler";
import { charPreservationRatio, missingNumbers } from "./lib/preserve";

function splitSections(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length) {
      out.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

async function cosineToRaw(
  raw: string,
  healed: string,
  accountId: string,
  aiToken: string,
): Promise<number> {
  const res = await fetch(`${CF_API}/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [raw, healed] }),
  });
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${await res.text()}`);
  const { result } = (await res.json()) as { result: { data: number[][] } };
  const [a, b] = result.data;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Layer 3: a sampled Kimi faithfulness judge — does the healed section add any rule/number absent
// from the raw? Returns the verdict string ("FAITHFUL" or "FABRICATED: <added text>").
const JUDGE_MODEL = "kimi-k2.7-code";
async function judgeFaithful(raw: string, healed: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Compare a healed rulebook section to its raw source. Reply 'FAITHFUL' if the healed adds NO rule, number, or claim absent from the raw (spacing/casing/spelling corrections are fine). Otherwise reply 'FABRICATED: <quote the added text>'. Reply with nothing else.",
        },
        { role: "user", content: `<raw>\n${raw}\n</raw>\n<healed>\n${healed}\n</healed>` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Moonshot ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return (json.choices[0]?.message?.content ?? "").trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      raw: { type: "string" },
      healed: { type: "string" },
      report: { type: "string" },
      "min-similarity": { type: "string", default: "0.92" },
      "min-preservation": { type: "string", default: "0.85" },
      "judge-sample": { type: "string", default: "8" },
    },
  });
  const rawPath = values.raw ?? fail("--raw is required");
  const healedPath = values.healed ?? fail("--healed is required");
  const reportPath = values.report ?? fail("--report is required");
  const minSim = Number(values["min-similarity"]);
  const minPres = Number(values["min-preservation"]);

  const rawSecs = splitSections(await readFile(rawPath, "utf-8"));
  const healedSecs = splitSections(await readFile(healedPath, "utf-8"));
  if (rawSecs.length !== healedSecs.length) {
    fail(`section count drift: raw ${rawSecs.length} vs healed ${healedSecs.length}`);
  }
  const { accountId, aiToken } = await resolveCloudflareAuth();

  const sections = [];
  let hardFails = 0;
  for (let i = 0; i < rawSecs.length; i++) {
    const missing = missingNumbers(rawSecs[i], healedSecs[i]);
    const preservation = charPreservationRatio(rawSecs[i], healedSecs[i]);
    const similarity = await cosineToRaw(rawSecs[i], healedSecs[i], accountId, aiToken);
    const hardFail = missing.length > 0 || preservation < minPres;
    if (hardFail) hardFails++;
    sections.push({ index: i, missing, preservation, similarity, similarityWarn: similarity < minSim, hardFail, judge: "" });
  }

  // Layer 3: judge an evenly-spaced sample of sections (always runs; cost-bounded by --judge-sample).
  const judgeApiKey = requireEnv("MOONSHOT_API_KEY");
  const sampleN = Math.min(Number(values["judge-sample"]) || 0, sections.length);
  const step = sampleN > 0 ? Math.max(1, Math.floor(sections.length / sampleN)) : sections.length + 1;
  for (let i = 0; i < sections.length; i += step) {
    const verdict = await judgeFaithful(rawSecs[i], healedSecs[i], judgeApiKey);
    sections[i].judge = verdict;
    if (!verdict.startsWith("FAITHFUL")) {
      sections[i].hardFail = true;
      hardFails++;
    }
  }

  const report = { rawPath, healedPath, thresholds: { minSim, minPres, judgeSample: sampleN }, hardFails, sections };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`-> report ${reportPath}: ${hardFails} hard fail(s) across ${sections.length} sections`);
  if (hardFails > 0) {
    console.error("VALIDATION FAILED — fix the source/heal or escalate the converter before ingest.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
```

- [ ] **Step 2: `requireEnv` is exported from `scripts/lib/wrangler.ts`** — confirm import resolves

Run: `pnpm tsx scripts/validate-md.ts` (no args)
Expected: exits non-zero with `--raw is required` (proves imports load).

> Layer 3 (the sampled Kimi faithfulness judge) is implemented above and **always runs** on
> `--judge-sample` evenly-spaced sections (default 8), hard-failing any section the judge marks
> `FABRICATED`. It is sampled (not every section) to bound cost; the sample size is recorded in the
> report so the cap is never silent. Raise `--judge-sample` for a fuller pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-md.ts
git commit -m "feat(validate): 3-layer healed-markdown validation with committed report"
```

---

### Task 8: Prove the pipeline end-to-end on Catan T&B (spike gate)

No new code — this is the gate that de-risks everything downstream. Catan *Traders & Barbarians* is
the hardest file (994 pdfjs artifacts).

**Files:** none (produces `rulebooks/catan/tb*.md` [gitignored] + `docs/research/validation/catan-tb.json` [committed]).

- [ ] **Step 1: Convert (Docling first)**

```bash
uv run python scripts/convert-pdfs.py --pdf /tmp/catan_tb.pdf --out rulebooks/catan/tb.md
```
Expected: `-> wrote rulebooks/catan/tb.md`. Eyeball: real `##` headings, no `K L A U S` runs.

- [ ] **Step 2: If Docling output is poor, escalate to Marker**

```bash
# GOOGLE_API_KEY is NEW (only Marker --use_llm needs it) and is NOT yet in .dev.vars.tpl.
# Locate/confirm its 1Password item (`op item list | grep -i gemini`) and add the op:// path
# to .dev.vars.tpl for the record, then export it for this run:
GOOGLE_API_KEY="<gemini key>" \
  uv run python scripts/convert-pdfs.py --pdf /tmp/catan_tb.pdf --out rulebooks/catan/tb.md --engine marker
```
(Only if needed. Compare heading count / artifact count against Docling.)

- [ ] **Step 3: Heal**

```bash
# MOONSHOT_API_KEY is the SAME env var the existing `pnpm ingest --contextual` flow already
# requires (requireEnv("MOONSHOT_API_KEY")) — source it the same way you already do for ingest
# (it is an operator env var, not a Worker secret, so it is not in .dev.vars.tpl).
MOONSHOT_API_KEY="$MOONSHOT_API_KEY" \
  pnpm tsx scripts/heal.ts --in rulebooks/catan/tb.md --out rulebooks/catan/tb.healed.md
```
Expected: per-section progress; some `! kept raw section` warnings are fine.

- [ ] **Step 4: Validate (the gate)**

```bash
env -u CLOUDFLARE_API_TOKEN pnpm tsx scripts/validate-md.ts \
  --raw rulebooks/catan/tb.md --healed rulebooks/catan/tb.healed.md \
  --report docs/research/validation/catan-tb.json
```
Expected: `0 hard fail(s)`. If it fails, iterate the converter/heal — do NOT proceed to Phase 2.

- [ ] **Step 5: Commit the report only (markdown stays gitignored)**

```bash
git add docs/research/validation/catan-tb.json
git commit -m "test(convert): Catan T&B end-to-end conversion validation report"
```

**GATE:** Only continue to Phase 2 once Catan passes validation and the markdown looks clean on
inspection. This proves the converter/heal/validate stack before any schema or Worker change.

---

## Phase 2 — Markdown-aware chunking, schema, citations (TDD, no prod mutation)

### Task 9: `heading_path` column (migration 0006 + schema mirror)

**Verified:** the migration-0004 FTS triggers reference only `text`/`id` and use `AFTER UPDATE OF
text`, so adding a column is safe; `heading_path` stays OUT of `chunks_fts`.

**Files:**
- Create: `migrations/0006_chunks_heading_path.sql`
- Modify: `src/server/db/schema.ts:40-51`

- [ ] **Step 1: Write the migration**

`migrations/0006_chunks_heading_path.sql`:

```sql
-- Section-heading anchor for markdown-sourced chunks (ADR 0008). Citations use this instead of
-- page numbers (markdown has no pages). Deliberately NOT added to chunks_fts: short structural
-- labels pollute BM25 IDF and add no lexical value (verified: the migration-0004 FTS triggers
-- touch only text/id and are AFTER UPDATE OF text, so this column is transparent to them).
ALTER TABLE chunks ADD COLUMN heading_path TEXT;
```

- [ ] **Step 2: Mirror in the Drizzle schema**

In `src/server/db/schema.ts`, add to the `chunks` table (after `contextBlurb`, before `createdAt`):

```ts
  contextBlurb: text("context_blurb"),
  headingPath: text("heading_path"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
```

- [ ] **Step 3: Apply locally + typecheck**

Run:
```bash
env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 execute ggg-db --local --file migrations/0006_chunks_heading_path.sql
pnpm check
```
> `ggg-db` is the D1 **database name** (confirmed: `database_name` in `wrangler.jsonc` and
> `D1_DATABASE` in `scripts/lib/wrangler.ts`). The Worker binding name `DB` is separate and not used
> by the wrangler CLI. **Do not** pass `--remote` — the remote migration is a Phase 3 human step.
Expected: migration applies; `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add migrations/0006_chunks_heading_path.sql src/server/db/schema.ts
git commit -m "feat(db): add chunks.heading_path for markdown citation anchors (migration 0006)"
```

---

### Task 10: Nullable page types + heading on the shared contract

**Files:**
- Modify: `src/shared/types.ts` (ChunkInput `70-77`, Chunk `47-58`, RetrievedChunk Pick `81`, Citation `92-103`)

- [ ] **Step 1: Make ChunkInput pages nullable + add Chunk.headingPath + widen Pick + Citation.headingPath**

Four edits in `src/shared/types.ts`. Complete before/after for each:

**(a) `ChunkInput` (lines 70-77)** — make pages nullable. Replace:
```ts
export interface ChunkInput {
  text: string;
  embedText: string;
  pageStart: number;
  pageEnd: number;
  headingPath: string | null;
  isTable: boolean;
}
```
with:
```ts
export interface ChunkInput {
  text: string;
  embedText: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string | null;
  isTable: boolean;
}
```

**(b) `Chunk` (lines 47-58)** — add `headingPath`. Replace:
```ts
export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  contextBlurb: string | null;
  createdAt: string;
}
```
with:
```ts
export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  contextBlurb: string | null;
  headingPath: string | null;
  createdAt: string;
}
```

**(c) `RetrievedChunk` Pick (line 81)** — widen. Replace:
```ts
  chunk: Pick<Chunk, "id" | "documentId" | "ordinal" | "text" | "pageStart" | "pageEnd">;
```
with:
```ts
  chunk: Pick<Chunk, "id" | "documentId" | "ordinal" | "text" | "pageStart" | "pageEnd" | "headingPath">;
```

**(d) `Citation` (lines 92-103)** — add `headingPath`. Replace:
```ts
export interface Citation {
  chunkId: string;
  documentId: string;
  gameName: string;
  documentTitle: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  score: number;
}
```
with:
```ts
export interface Citation {
  chunkId: string;
  documentId: string;
  gameName: string;
  documentTitle: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string | null;
  text: string;
  score: number;
}
```

- [ ] **Step 2: Typecheck (expect downstream errors to fix next)**

Run: `pnpm exec tsc --noEmit`
Expected: errors in `chunk.ts`, `ingest.ts`, `retrieve.ts`, `agent-core.ts` (consumers not yet
updated) — these are the next tasks. Confirm the errors are only in those files.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): nullable chunk pages + heading_path on chunk/citation contract"
```

---

### Task 11: Markdown-aware chunking (`chunk.ts`) — TDD

**Files:**
- Modify: `src/server/rag/chunk.ts` (hoist `enforceCap` to module scope; add `parseMarkdownSections` + `chunkMarkdown`)
- Modify: `src/server/rag/chunk.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/rag/chunk.test.ts`. **Do not add a second import line** — expand the existing
import at line 2 to
`import { chunkMarkdown, chunkPages, chunkText, parseMarkdownSections } from "./chunk";`
(Biome `organizeImports` forbids duplicate module imports). Then append these suites:

```ts
describe("parseMarkdownSections", () => {
  it("builds a heading path from ATX heading nesting", () => {
    const md = "# Monopoly\nintro\n## Jail\n### Getting Out\nRoll doubles.";
    const secs = parseMarkdownSections(md);
    expect(secs.at(-1)?.headingPath).toBe("Monopoly > Jail > Getting Out");
    expect(secs.at(-1)?.body).toContain("Roll doubles.");
  });
  it("keeps preamble before the first heading with a null path", () => {
    const secs = parseMarkdownSections("loose intro text\n## First\nbody");
    expect(secs[0].headingPath).toBeNull();
    expect(secs[0].body).toBe("loose intro text");
  });
});

describe("chunkMarkdown", () => {
  it("never merges across a heading boundary", async () => {
    const md = "## A\n" + "alpha ".repeat(30) + "\n## B\n" + "bravo ".repeat(30);
    const chunks = await chunkMarkdown(md, { countTokens, targetTokens: 1000, maxTokens: 2000 });
    for (const c of chunks) {
      const hasA = c.text.includes("alpha");
      const hasB = c.text.includes("bravo");
      expect(hasA && hasB).toBe(false); // no chunk straddles A and B
    }
  });
  it("prefixes the heading path onto embedText and stores it, with null pages", async () => {
    const md = "## Setup\n### Money\nEach player starts with $1500.";
    const [chunk] = await chunkMarkdown(md, { countTokens, targetTokens: 50, maxTokens: 100 });
    expect(chunk.headingPath).toBe("Setup > Money");
    expect(chunk.embedText.startsWith("Setup > Money")).toBe(true);
    expect(chunk.embedText).toContain(chunk.text);
    expect(chunk.pageStart).toBeNull();
    expect(chunk.pageEnd).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/server/rag/chunk.test.ts`
Expected: FAIL — `chunkMarkdown`/`parseMarkdownSections` not exported.

- [ ] **Step 3: Implement in `src/server/rag/chunk.ts`**

First hoist `enforceCap` to module scope (it is currently nested in `chunkPages` at lines ~100-109).
Replace the nested definition with a call to a module-level function and add the function near
`looksLikeTable`:

```ts
// Hard-split a piece that exceeds `cap` tokens by halving at whitespace near the middle.
function enforceCap(text: string, cap: number, countTokens: (t: string) => number): string[] {
  if (countTokens(text) <= cap) return [text];
  const mid = Math.floor(text.length / 2);
  const space = text.lastIndexOf(" ", mid);
  const cut = space > 0 ? space : mid;
  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  if (!left || !right) return [text];
  return [...enforceCap(left, cap, countTokens), ...enforceCap(right, cap, countTokens)];
}
```

Then fix `chunkPages` for the now-hoisted helper:
- Delete the nested `enforceCap` definition inside `chunkPages` (current lines ~100-109).
- Change `enforceCap(piece.text, TABLE_MAX_TOKENS)` → `enforceCap(piece.text, TABLE_MAX_TOKENS, countTokens)`.
- Change `enforceCap(piece.text, maxTokens)` → `enforceCap(piece.text, maxTokens, countTokens)`.

Then add markdown support:

```ts
// An ATX markdown heading line, e.g. "## Setup", "### Getting Out of Jail".
const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export interface MarkdownSection {
  headingPath: string | null;
  level: number;
  body: string;
}

/** Split markdown into heading-delimited sections, each carrying its full heading path. */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let body: string[] = [];
  let level = 0;
  let path: string | null = null;

  // Heading-only sections (no body lines) are skipped — they only advance the heading path for the
  // next section that has content (e.g. a chapter title sitting above its sub-sections).
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ headingPath: path, level, body: text });
    body = [];
  };

  for (const line of lines) {
    const m = ATX_HEADING.exec(line);
    if (m) {
      flush();
      level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      path = stack.map((s) => s.title).join(" > ");
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Chunk markdown into token-budgeted, heading-enriched chunks (ADR 0008). Pieces are merged toward
 * the token target WITHIN a section only — never across a heading boundary — so a fact never shares
 * a chunk with unrelated material. The section heading path is prepended to `embedText` and stored
 * as `headingPath`. Markdown has no pages, so pageStart/pageEnd are null.
 */
export async function chunkMarkdown(
  markdown: string,
  options: ChunkPagesOptions,
): Promise<ChunkInput[]> {
  const { countTokens } = options;
  const targetTokens = options.targetTokens ?? CHUNK_TARGET_TOKENS;
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: targetTokens * 4,
    chunkOverlap: 0,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const chunks: ChunkInput[] = [];
  for (const section of parseMarkdownSections(markdown)) {
    const heading = section.headingPath;
    const emit = (text: string, isTable: boolean) => {
      const embedText = heading ? `${heading}\n${text}` : text;
      chunks.push({ text, embedText, pageStart: null, pageEnd: null, headingPath: heading, isTable });
    };

    let buf: string[] = [];
    let bufTokens = 0;
    const flush = () => {
      if (buf.length === 0) return;
      emit(buf.join("\n\n"), false);
      // Carry trailing pieces (~overlapTokens) within THIS section only; the next section starts a
      // fresh buf, so overlap never crosses a heading boundary (that's the point of section-scoping).
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = buf.length - 1; i > 0 && carryTokens < overlapTokens; i--) {
        carry.unshift(buf[i]);
        carryTokens += countTokens(buf[i]);
      }
      buf = carry;
      bufTokens = carryTokens;
    };

    for (const part of await splitter.splitText(section.body)) {
      const piece = part.trim();
      if (!piece) continue;
      if (looksLikeTable(piece)) {
        flush();
        for (const t of enforceCap(piece, TABLE_MAX_TOKENS, countTokens)) emit(t, true);
        continue;
      }
      for (const capped of enforceCap(piece, maxTokens, countTokens)) {
        const tokens = countTokens(capped);
        if (bufTokens > 0 && bufTokens + tokens > targetTokens) flush();
        buf.push(capped);
        bufTokens += tokens;
      }
    }
    flush();
  }
  return chunks;
}
```

- [ ] **Step 4: Run to verify pass (and no regression in existing chunk tests)**

Run: `pnpm vitest run src/server/rag/chunk.test.ts`
Expected: PASS — new markdown tests plus the existing `chunkText`/`chunkPages` suites all green.

- [ ] **Step 5: Commit**

```bash
git add src/server/rag/chunk.ts src/server/rag/chunk.test.ts
git commit -m "feat(chunk): markdown-aware section chunking with heading-bounded merge"
```

---

### Task 12: Ingest from markdown (`ingest.ts`)

**Files:**
- Modify: `scripts/ingest.ts` (parseArgs `235-243`; drop `fetchPdf` `84-86` + `extractPages` `90-115` + pdfjs import `39-40`; add `readMarkdown`; chunk via `chunkMarkdown`; INSERT `335` adds `heading_path`; nullable pages)

- [ ] **Step 1: Swap the source contract + extraction**

In `scripts/ingest.ts`:
- Remove `import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";` (~line 40) and `import { createRequire } from "node:module";` (line 35) — both are used only by the deleted `extractPages`.
- Change the type import (line 43) from `import type { ChunkInput, DocumentKind, PageText }` to `import type { ChunkInput, DocumentKind }` — `PageText` is now unused (Biome `noUnusedImports` fails otherwise); `ChunkInput` stays (used by `contextualBlurbs`).
- Replace `import { chunkPages }` with `import { chunkMarkdown }` (line 41).
- Delete `fetchPdf` (lines 84-86) and `extractPages` (lines 90-115). Add:

```ts
import { readFile } from "node:fs/promises"; // already imported — reuse

async function readMarkdown(path: string): Promise<string> {
  const md = await readFile(path, "utf-8");
  if (!md.trim()) throw new Error(`empty markdown: ${path}`);
  return md;
}
```

- In `parseArgs`, add `"md-path": { type: "string" }` (keep `"r2-key"` — it remains the document
  identity, now pointing at the `.md` in R2). Require `--md-path`:

```ts
const mdPath = values["md-path"] ?? fail("--md-path is required (the healed .md to ingest)");
```

- [ ] **Step 2: Chunk from markdown + carry headingPath**

Replace the extract+chunk block (currently `fetchPdf` → `extractPages` → `chunkPages`, ~lines
288-306) with:

```ts
    console.log(`-> reading ${mdPath}`);
    const markdown = await readMarkdown(mdPath);
    const tokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-m3");
    const countTokens = (text: string): number => tokenizer.encode(text).length;
    const chunks = await chunkMarkdown(markdown, { countTokens });
    if (chunks.length === 0) throw new Error("chunking produced no chunks");

    let blurbs: string[] = [];
    if (contextual) {
      console.log(`-> generating ${chunks.length} contextual blurbs (Kimi k2.7)`);
      blurbs = await contextualBlurbs(markdown, chunks);
    }
```

- [ ] **Step 3: Persist `heading_path` + nullable pages**

Update the INSERT builder (line ~332-337). Add a small null helper and the column:

```ts
    const numOrNull = (n: number | null) => (n === null ? "NULL" : String(n));
    const insertSql = chunks
      .map((chunk, i) => {
        const blurbSql = contextual && blurbs[i] ? sqlStr(blurbs[i]) : "NULL";
        const headingSql = chunk.headingPath ? sqlStr(chunk.headingPath) : "NULL";
        return `INSERT INTO chunks (id, document_id, ordinal, text, page_start, page_end, context_blurb, heading_path) VALUES (${sqlStr(chunkIds[i])}, ${sqlStr(documentId)}, ${i}, ${sqlStr(chunk.text)}, ${numOrNull(chunk.pageStart)}, ${numOrNull(chunk.pageEnd)}, ${blurbSql}, ${headingSql});`;
      })
      .join("\n");
```

- [ ] **Step 4: Update the usage docstring** (replace the `--r2-key catan/base-5th.pdf` example with
  `--md-path rulebooks/catan/base.healed.md --r2-key catan/base.md`).

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: clean (the type errors from Task 10 in `ingest.ts` are now resolved).

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest.ts
git commit -m "feat(ingest): ingest healed markdown via chunkMarkdown, store heading_path"
```

---

### Task 13: Citations show section headings (`retrieve.ts`, `agent-core.ts`, `theme.ts`) — TDD the label

**Files:**
- Modify: `src/server/rag/retrieve.ts` (select `132-143`, map `152-171`)
- Modify: `src/server/agent-core.ts` (`toCitations` `14-26`)
- Modify: `src/client/theme.ts` (`pageLabel` `18-24`)

- [ ] **Step 1: Select + map `headingPath` in retrieve.ts**

Add `headingPath: chunks.headingPath,` to the select object (after `pageEnd:` at line ~138) and add
`headingPath: row.headingPath,` to the chunk sub-object in the survivor mapping (after `pageEnd` at
line ~163).

- [ ] **Step 2: Carry it in toCitations (agent-core.ts)**

Add `headingPath: p.chunk.headingPath,` to the returned citation object (after `pageEnd:` at line ~22).

- [ ] **Step 3: Write the failing label test**

Create `src/client/theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sourceLabel } from "./theme";
import type { Citation } from "../shared/types";

const base: Citation = {
  chunkId: "c", documentId: "d", gameName: "g", documentTitle: "t",
  ordinal: 0, pageStart: null, pageEnd: null, headingPath: null, text: "x", score: 1,
};

describe("sourceLabel", () => {
  it("prefers the section heading when present", () => {
    expect(sourceLabel({ ...base, headingPath: "Setup > Money" })).toBe("§ Setup > Money");
  });
  it("falls back to the page label for PDF-era rows", () => {
    expect(sourceLabel({ ...base, pageStart: 4, pageEnd: 5 })).toBe("p.4–5");
  });
  it("returns empty when neither is known", () => {
    expect(sourceLabel(base)).toBe("");
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run src/client/theme.test.ts`
Expected: FAIL — `sourceLabel` not exported.

- [ ] **Step 5: Implement sourceLabel in theme.ts** (keep `pageLabel` as the fallback)

```ts
export function sourceLabel(citation: Citation): string {
  if (citation.headingPath) return `§ ${citation.headingPath}`;
  return pageLabel(citation);
}
```

Then update both call sites that render the page label (named, not grep-and-discover):
- `src/client/Chat.tsx:119` — replace `pageLabel(citation)` with `sourceLabel(citation)`; add `sourceLabel` to the existing `./theme` import.
- `src/client/CitationModal.tsx:39` — replace `pageLabel(citation)` with `sourceLabel(citation)`; add `sourceLabel` to the existing `./theme` import.

- [ ] **Step 6: Run to verify pass + full check**

Run: `pnpm vitest run src/client/theme.test.ts && pnpm check`
Expected: PASS; `tsc`/Biome clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/rag/retrieve.ts src/server/agent-core.ts src/client/theme.ts src/client/theme.test.ts src/client/Chat.tsx src/client/CitationModal.tsx
git commit -m "feat(citations): anchor citations on section heading, page fallback"
```

---

### Task 14: Full check + docs hygiene (CONTEXT.md glossary, CLAUDE.md)

**Files:**
- Modify: `CONTEXT.md` (Chunk + Citation glossary), `CLAUDE.md` (only if it mentions pdfjs)

- [ ] **Step 1: Update the CONTEXT.md glossary**

The Chunk and Citation anchors changed. In `CONTEXT.md`:
- **Chunk** — note a Chunk now carries a section `headingPath`, and that page numbers are absent for
  markdown-sourced Chunks (pageStart/pageEnd nullable).
- **Citation** — note a Citation anchors on the section heading (`headingPath`), falling back to page
  numbers only for any PDF-era Chunks.
Keep CONTEXT.md a glossary — no implementation detail.

- [ ] **Step 2: Update CLAUDE.md only if it references pdfjs**

Run `grep -n "pdfjs" CLAUDE.md`. If a gotcha bullet mentions pdfjs extraction, replace it with a
one-line pointer to ADR 0008 (rulebooks are converted to healed markdown offline; pdfjs is no longer
in the ingest path). If grep finds nothing, skip — the pdfjs reference lives in ADR 0005, which ADR
0008 supersedes, so no CLAUDE.md change is needed.

- [ ] **Step 3: Full verification**

Run: `pnpm check && pnpm test && pnpm build`
Expected: all green — quote the Vitest pass line and the build success line.

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md CLAUDE.md
git commit -m "docs: update Chunk/Citation glossary + ingest gotcha for markdown conversion"
```

---

## Phase 3 — Rollout, re-ingest, ship (human performs prod mutations)

> Everything in Phase 3 that mutates production (remote D1 migration, Vectorize writes, deploy, git
> push) is performed by **you (the human/main agent)**, not a workflow/subagent. The steps below are
> the runbook.

> **Rollout strategy — read first.** The spec's original "blue/green parallel Vectorize index" is
> NOT viable as written: retrieval hydrates chunk text from D1 by joining on the vector id
> (`retrieve.ts` `byId.get(id)`), and re-ingest assigns NEW chunk ids (`ingest.ts` DELETE+INSERT). A
> parallel Vectorize index over the SAME D1 would leave the live (green) index's vector ids with no
> matching D1 rows → every hydration drops → live Recall goes to zero during the window. There is no
> parallel index without also parallelizing D1. Two correct options:
> - **(Default) Maintenance window, single index** — for a personal, low-traffic app: deploy the new
>   (backward-compatible) Worker, then re-ingest in place at a quiet time. The only degraded window is
>   the re-ingest run itself; after it completes, D1 and the index are consistent again.
> - **(Optional) True blue/green** — provision a parallel D1 *and* Vectorize index, re-ingest into
>   both, eval via local `pnpm dev` pointed at the blue bindings, then cut over both bindings
>   atomically (zero downtime). See "Zero-downtime alternative" at the end.
>
> Tasks 15-18 describe the **default (maintenance-window)** path.

### Task 15: Convert + heal + validate the rest of the Catalogue

- [ ] **Step 1: List the documents to migrate**

```bash
env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 execute ggg-db --remote --command \
  "SELECT g.name, g.edition, d.title, d.r2_key, d.kind FROM documents d JOIN games g ON g.id=d.game_id ORDER BY g.name"
```

- [ ] **Step 2: For each document, run convert → heal → validate** (Catan already done in Task 8).
  Pull each PDF from R2 (`wrangler r2 object get ggg-rulebooks/<key> --file /tmp/x.pdf --remote`),
  convert (Docling; escalate to Marker only on validation failure), heal, validate to
  `docs/research/validation/<slug>.json`. Commit only the reports.
- [ ] **Step 3: Per-game exceptions** — Uno: hand-write `rulebooks/uno/uno.md` (own words; gitignored,
  copyrighted). Euchre/Five Hundred: source public-domain text (Wikipedia / pagat permission);
  these `.md` MAY be committed. Monopoly/Hasbro: convert as normal, markdown stays gitignored
  (internal-only).
- [ ] **Step 4: Commit the validation reports**

```bash
git add docs/research/validation/
git commit -m "test(convert): catalogue-wide conversion validation reports"
```

### Task 16: Apply migration 0006 remotely + deploy the new Worker

- [ ] **Step 1 (human): Apply migration 0006 to remote D1, then verify the column exists**

```bash
env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 execute ggg-db --remote --file migrations/0006_chunks_heading_path.sql
env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 execute ggg-db --remote --command "PRAGMA table_info(chunks)"
```
Expected: the second command lists a `heading_path` column. It is nullable, so the deployed Worker
keeps working on existing rows.

- [ ] **Step 2 (human): Deploy the new Worker code**

The new query-path code (retrieve.ts `heading_path` select, agent-core `toCitations`, theme
`sourceLabel`) plus the staged `RERANK_MIN_SCORE = 0.05` are backward-compatible: `heading_path` is
null on old chunks, so `sourceLabel` falls back to `pageLabel`. Deploy:
```bash
env -u CLOUDFLARE_API_TOKEN pnpm deploy
```
> Deploying before re-ingest means the live site briefly serves the OLD chunks with the NEW code —
> fully functional (citations just show page numbers until re-ingest populates headings).

### Task 17: Re-ingest in place + regenerate the Gold set

- [ ] **Step 1 (human): Re-ingest every game from its healed markdown** (run at a quiet time — the
  re-ingest run is the only degraded window). For each document:
```bash
env -u CLOUDFLARE_API_TOKEN MOONSHOT_API_KEY="$MOONSHOT_API_KEY" pnpm ingest \
  --md-path rulebooks/<game>/<doc>.healed.md --r2-key <game>/<doc>.md \
  --game "<name>" --document "<title>" --kind <kind> [--edition "<ed>"] [--contextual]
```
ingest is idempotent per (game, r2_key): it replaces that document's chunks in D1 + Vectorize.

- [ ] **Step 2: Verify chunk growth + heading population**

```bash
env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 execute ggg-db --remote --command \
  "SELECT count(*) AS with_heading FROM chunks WHERE heading_path IS NOT NULL"
```
Expected: most chunks have a `heading_path`; Monopoly/Sushi Go! chunk counts rise well above 11/6.

- [ ] **Step 3: Regenerate + curate the Gold set** — re-ingest changed every chunk id, so
  `eval/gold/catalogue.json` `expectedChunkIds` are stale (including the two staged Monopoly
  regression rows). Per game: `pnpm gen-gold --game "<name>" --out eval/gold/<slug>.generated.json`,
  then curate into `catalogue.json` (re-derive the Monopoly starting-money + escape-Jail rows against
  the new chunks).

- [ ] **Step 4: Eval gate**

```bash
EVAL_SECRET="$EVAL_SECRET" env -u CLOUDFLARE_API_TOKEN pnpm eval --gold eval/gold/catalogue.json
```
**Gate:** Hit-Rate@5 and Recall@20 ≥ the recorded baseline. If it regresses, iterate the
converter/heal/chunking and re-ingest (repeatable) before announcing. Record the numbers.

- [ ] **Step 5: Commit the regenerated gold**

```bash
git add eval/gold/catalogue.json
git commit -m "test(eval): regenerate gold set against re-ingested markdown corpus"
```

### Task 18: Ship Uno + final verification

- [ ] **Step 1 (human): Ingest Uno** from its hand-written markdown (same command shape as Task 17,
  `--game "Uno"`).
- [ ] **Step 2: Live smoke** — against the deployed site: the Monopoly starting-money and escape-Jail
  paraphrases return real rulings (not `NOT_COVERED`); a genuinely off-topic question still refuses;
  citations show section headings; an Uno question is answered.
- [ ] **Step 3: Commit the shipped gate fix** (already staged) + push

```bash
git add src/server/rag/models.ts
git commit -m "feat(rag): ship rerank-gate 0.05 on the markdown-sourced index"
git push
```

### Zero-downtime alternative (optional — skip if using the maintenance window)

If brief degradation during Task 17's re-ingest is unacceptable:
1. **ingest.ts overrides** — add `--vectorize-index` (defaulting to `VECTORIZE_INDEX`) threaded
   through `vectorizeUpsert`/`vectorizeDeleteByIds`, and `--d1-database` (defaulting to `D1_DATABASE`)
   threaded through the `d1Run`/`d1File`/`d1Select` helpers (these use the `D1_DATABASE` constant in
   `scripts/lib/wrangler.ts`).
2. **Provision blue** — a parallel D1 (`ggg-db-blue`) + Vectorize index (`ggg-rules-index-blue`) in
   the central infra repo (`../jasonm4130-cf`, ADR 0003).
3. **Re-ingest into blue** — run Task 17's ingest with
   `--vectorize-index ggg-rules-index-blue --d1-database ggg-db-blue`. Green is untouched.
4. **Eval blue locally** — temporarily point `wrangler.jsonc`'s `DB` + `RULES_IDX` bindings at the
   blue resources, `pnpm types`, `pnpm dev`, then `pnpm eval --base-url http://localhost:5173`. Revert
   `wrangler.jsonc` afterwards (a local revert, not a prod mutation).
5. **Cut over** — once the gate passes, point both bindings at blue in `wrangler.jsonc`, `pnpm types`,
   `pnpm deploy`. Retire green.

---

## Self-Review

- **Spec coverage:** sourcing (Task 15 exceptions), converter (Tasks 2-3, Docling primary + Marker
  escalation), heal (Tasks 4-5), 3-layer validation (Tasks 6-7), markdown chunking (Task 11),
  `heading_path`/citations (Tasks 9-10, 13), re-ingest + gold regen + ship (Tasks 15-18), ADR
  0008 (already written; prerequisite noted in File Structure), sequencing (Catan spike gate Task 8).
  All covered.
- **Type consistency:** `ChunkInput.pageStart/pageEnd: number | null`, `Chunk.headingPath`,
  `RetrievedChunk` Pick widened to include `headingPath`, `Citation.headingPath: string | null`,
  `chunkMarkdown(markdown, ChunkPagesOptions)`, `enforceCap(text, cap, countTokens)`,
  `acceptHeal(raw, healed)`, `missingNumbers(raw, healed)`, `sourceLabel(citation)` — used
  consistently across tasks.
- **No placeholders:** every code step has complete code, including the layer-3 sampled Kimi
  faithfulness judge (Task 7), which always runs on a cost-bounded sample.
- **Rollout corrected:** the spec's parallel-Vectorize blue/green was unviable over the shared D1
  (re-ingest's new chunk ids would orphan the live index's hydration). Phase 3 now defaults to a
  maintenance-window single-index re-ingest, with true blue/green (parallel D1 + index) documented as
  an optional zero-downtime path.
- **Honest verification limits:** converter/heal/eval steps hit the network (Workers AI, Moonshot,
  Gemini) and cannot be unit-tested — they are integration runs (Tasks 8, 15-18). The pure cores
  (align, preserve, chunkMarkdown, sourceLabel) are TDD'd.
