/**
 * gen-gold — PROPOSE candidate gold Q&A for the eval harness (GAP 2, ADR 0007). Operator-side.
 *
 * Reads a RANDOM sample of a Game's chunks read-only from D1, then asks a Workers AI model to write,
 * for each, ONE natural rules question a player would ask — in the player's OWN words, not echoing the
 * excerpt — plus a short VERBATIM evidence quote from the excerpt that answers it. It emits
 *   { game, edition?, query, expectedTextIncludes: [evidence], _targetChunkId, _needsReview: true }
 * marked _needsReview so the operator MUST curate before feeding it to `pnpm eval`.
 *
 * De-biased vs. the naive generator (#3): the sample is RANDOM (was `ORDER BY length DESC`, which
 * over-tested big chunks and under-tested terse rules), and the question is explicitly PARAPHRASED so
 * the gold stops echoing the answering chunk's vocabulary — echoing inflated both retrieval legs vs.
 * real player phrasing. The gold key is expectedTextIncludes (a content substring) NOT a chunk id, so
 * it survives a PDF→markdown re-ingest's chunk-id churn (eval.ts resolves it back to ids).
 *
 * ponytail: findability ("answerable only by this chunk", does retrieval surface it) is NOT verified
 * here by running retrieval — that would be circular (building the eval with the system under test,
 * silently discarding the hard questions that expose its weaknesses). Curate, then `pnpm eval` reports
 * MRR/nDCG/false-refusal so the operator SEES findability against the real pipeline.
 *
 * Auth + REST: identical to ingest.ts — `wrangler whoami` for the account, `wrangler auth token` for
 * the bearer, Workers AI /ai/run REST for the generation. CLOUDFLARE_API_TOKEN is stripped from every
 * wrangler subprocess so a stale shell token can't shadow the login. NOTHING is written to D1 /
 * Vectorize / the index — this only reads chunks and writes a local JSON file.
 *
 * Usage:
 *   pnpm gen-gold --game "Monopoly" [--edition "…"] --out eval/gold/monopoly.generated.json [--max 8]
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { GENERATION_MODEL } from "worker/rag/models";
import {
  d1Select,
  fail,
  resolveCloudflareAuth,
  resolveGameId,
  sqlStr,
  workersAiRun,
} from "./lib/wrangler";

const DEFAULT_MAX = 8;
// A question (~15-25 tokens) + a verbatim evidence quote (~30-60) + the JSON wrapper; 300 leaves
// headroom so a longer quote isn't truncated (which would make parseQA fail and drop the chunk).
const GEN_MAX_TOKENS = 300;

interface ProposedQA {
  question: string;
  evidence: string;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The model's evidence is only usable if it's a genuine (whitespace-normalized) substring of the
 *  chunk — and long enough to pin a single passage in eval.ts (12+ chars rules out trivial fragments). */
function containsNormalized(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length >= 12 && normalize(haystack).includes(n);
}

/** Salient verbatim seed when the model didn't return a usable quote: the longest body line that fits
 *  a substring seed (≤120 chars), else the first 120 chars of the chunk. */
function fallbackEvidence(chunkText: string): string {
  const lines = chunkText
    .split(/\n+/)
    .map((line) => line.trim())
    // Gate on the NORMALIZED length (what eval.ts resolves against), not raw — a whitespace-heavy
    // line could be ≥12 raw chars but normalize below the 12-char floor and match multiple chunks.
    .filter((line) => normalize(line).length >= 12 && line.length <= 120)
    .sort((a, b) => b.length - a.length);
  return lines[0] ?? chunkText.trim().slice(0, 120);
}

/** Extract a {question, evidence} object from a model reply, tolerant of surrounding prose. */
function parseQA(raw: string): { question?: string; evidence?: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { question?: unknown; evidence?: unknown };
    return {
      question: typeof obj.question === "string" ? obj.question : undefined,
      evidence: typeof obj.evidence === "string" ? obj.evidence : undefined,
    };
  } catch {
    return null;
  }
}

// ── Workers AI REST text generation (one paraphrased question + verbatim evidence per chunk) ─────

async function proposeQA(
  chunkText: string,
  headingPath: string | null,
  accountId: string,
  aiToken: string,
): Promise<ProposedQA | null> {
  const excerpt = headingPath ? `Section: ${headingPath}\n\n${chunkText}` : chunkText;
  const json = await workersAiRun<{ result?: { response?: string }; success: boolean }>(
    GENERATION_MODEL,
    {
      max_tokens: GEN_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content:
            'You write evaluation questions for a tabletop-rules assistant. Given ONE rulebook excerpt, write a SINGLE natural rules question a real player would ask, in the player\'s OWN words. Use everyday phrasing and common synonyms; do NOT reuse the excerpt\'s distinctive wording, exact numbers, or rare terms — a good eval question tests retrieval, so it must NOT be a near-copy of the text. It must be answerable from this excerpt. Also copy a SHORT verbatim quote from the excerpt that contains the answer. Reply with ONLY a JSON object: {"question": "<the question>", "evidence": "<verbatim quote, copied exactly from the excerpt>"} and nothing else.',
        },
        { role: "user", content: excerpt },
      ],
    },
    { accountId, aiToken },
  );
  if (!json.success) return null;
  // Workers AI returns result.response as a string for most models, but some return a parsed object;
  // coerce to text so parseQA's string ops don't throw (same shape-guard as eval.ts's judge).
  const rawResponse = json.result?.response;
  const responseText =
    typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse ?? "");
  const parsed = parseQA(responseText);
  if (!parsed?.question?.trim()) return null;
  // Evidence must be a genuine substring of THIS chunk; if the model paraphrased it, fall back to a
  // salient line so expectedTextIncludes still resolves to this chunk in eval.ts.
  const evidence =
    parsed.evidence && containsNormalized(chunkText, parsed.evidence)
      ? parsed.evidence.trim()
      : fallbackEvidence(chunkText);
  return { question: parsed.question.trim(), evidence };
}

// ── orchestration ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string" },
      edition: { type: "string" },
      out: { type: "string" },
      max: { type: "string", default: String(DEFAULT_MAX) },
    },
  });

  const game = values.game ?? fail("--game is required");
  const out = values.out ?? fail("--out <path> is required");
  const edition = values.edition?.trim() || null;
  const max = Number(values.max) || DEFAULT_MAX;

  const { accountId, aiToken } = await resolveCloudflareAuth();

  const gameId =
    (await resolveGameId(game, edition ?? undefined)) ??
    fail(`Game "${game}" not found in the Catalogue`);

  // Read-only: a RANDOM sample of the Game's chunks (no length bias — terse rules get tested too).
  const chunks = await d1Select<{ id: string; text: string; heading_path: string | null }>(
    `SELECT c.id AS id, c.text AS text, c.heading_path AS heading_path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.game_id = ${sqlStr(gameId)} ORDER BY RANDOM() LIMIT ${max}`,
  );
  if (chunks.length === 0) fail(`no chunks found for "${game}" — has it been ingested?`);

  console.log(`→ proposing ${chunks.length} questions for "${game}" (${GENERATION_MODEL})`);
  const proposed: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const qa = await proposeQA(chunk.text, chunk.heading_path, accountId, aiToken);
    if (!qa) {
      console.warn(
        `  ⚠ skipped chunk ${chunk.id} — model returned no usable QA (raise --max to compensate)`,
      );
      continue;
    }
    proposed.push({
      game,
      ...(edition ? { edition } : {}),
      query: qa.question,
      expectedTextIncludes: [qa.evidence],
      _targetChunkId: chunk.id,
      _needsReview: true,
    });
    console.log(`  • ${qa.question}`);
  }

  await writeFile(out, `${JSON.stringify(proposed, null, 2)}\n`);
  console.log(
    `\n✓ wrote ${proposed.length} PROPOSED gold rows to ${out}.\n` +
      "⚠ PROPOSED — REVIEW BEFORE USE. These are model-written and may be leading, vague, or\n" +
      "  answerable by other chunks. Check each expectedTextIncludes really pins the answer, then\n" +
      "  drop _needsReview / _targetChunkId before `pnpm eval`.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
