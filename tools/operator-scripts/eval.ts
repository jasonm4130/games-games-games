/**
 * Retrieval + generation EVAL HARNESS (GAP 2, ADR 0007) — an operator-side Node script.
 *
 * It exercises the REAL pipeline through the secret-gated Worker endpoints (POST /api/eval/*), so
 * the numbers reflect production retrieval (dense + lexical legs, RRF, reranker, gate) rather than a
 * script reimplementation that would drift. Two modes:
 *
 *   RETRIEVAL (default) — for each gold question, retrieve in BOTH dense and hybrid mode and report
 *     Hit-Rate@5, MRR@5, nDCG@5, Recall@20, Precision@5 per mode plus the hybrid−dense delta, and the
 *     hybrid false-refusal rate (answerable gold the live pipeline would refuse). Zero GENERATION-LLM
 *     cost, but it DOES bill Workers AI for the embedding + reranker on every query (per project
 *     notes, Workers AI always hits the network).
 *
 *   GENERATION (--gen) — additionally run each gold question through every model in GEN_EVAL_MODELS
 *     (llama-3.3-70b + gemma-4-26b-a4b-it) and print, side by side: citation validity, citation
 *     attribution (did a CITED passage contain the gold answer text), an LLM-judged faithfulness score,
 *     and token overlap. This SPENDS GENERATION CREDITS (one answer call + one faithfulness-judge call
 *     per question per model) and bypasses the agent's daily budget breaker — run it on a SMALL subset.
 *
 * Gold set: a JSON array of { game, edition?, query, expectedChunkIds? OR expectedTextIncludes? }.
 * expectedTextIncludes (case-insensitive, whitespace-normalized substrings of the answering chunk's
 * text) is resolved to chunk ids ONCE per game via a read-only D1 SELECT, so a seed survives both
 * chunk-id churn and line-break reflow (e.g. a PDF→markdown re-ingest) on re-ingest.
 *
 * Auth: rides your `wrangler login` session for the D1 reads (same as scripts/ingest.ts); the eval
 * endpoints are gated by the EVAL_SECRET env var sent as the x-eval-secret header. CLOUDFLARE_API_
 * TOKEN is stripped from every wrangler subprocess so a stale shell token can't shadow the login.
 *
 * Usage:
 *   EVAL_SECRET=… pnpm eval --gold eval/gold/monopoly.json [--base-url https://games.jasonmatthew.dev]
 *   EVAL_SECRET=… pnpm eval --gold eval/gold/monopoly.json --gen   # adds the llama-vs-gemma compare
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  citationAttributionPrecision,
  citationValidity,
  hitRateAt,
  mrrAt,
  ndcgAt,
  parseCitationMarkers,
  precisionAt,
  recallAt,
  tokenOverlap,
} from "worker/rag/eval-metrics";
import { GEN_EVAL_MODELS, GENERATION_MODEL } from "worker/rag/models";
import {
  d1Select,
  EVAL_USER_AGENT,
  fail,
  requireEnv,
  resolveCloudflareAuth,
  resolveGameId,
  sqlStr,
  workersAiRun,
} from "./lib/wrangler";

const DEFAULT_BASE_URL = "https://games.jasonmatthew.dev";
const HIT_K = 5;
const RECALL_K = 20;
const PRECISION_K = 5;
const RANK_K = 5; // MRR / nDCG window over the post-rerank `final` list (what the model actually reads).
// Faithfulness judge: the strongest general model on Workers AI. It self-judges llama answers and
// cross-judges gemma, so read the absolute number as a heuristic and the llama-vs-gemma DELTA as signal.
const JUDGE_MODEL = GENERATION_MODEL;

interface GoldRow {
  game: string;
  edition?: string;
  query: string;
  expectedChunkIds?: string[];
  expectedTextIncludes?: string[];
  // gen-gold marks proposed rows _needsReview until an operator curates them; main() hard-stops on it.
  _needsReview?: boolean;
}

// ── gold-set resolution: (game, edition) → gameId, expectedTextIncludes → chunk ids ────────────

// chunk text per game, fetched once, for resolving expectedTextIncludes → chunk ids.
const chunkTextCache = new Map<string, { id: string; text: string }[]>();

async function gameChunks(gameId: string): Promise<{ id: string; text: string }[]> {
  const cached = chunkTextCache.get(gameId);
  if (cached) return cached;
  const rows = await d1Select<{ id: string; text: string }>(
    `SELECT c.id AS id, c.text AS text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.game_id = ${sqlStr(gameId)}`,
  );
  chunkTextCache.set(gameId, rows);
  return rows;
}

/** Collapse whitespace runs to a single space + lowercase, so a seed survives line-break reflow. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Map a gold row to the chunk ids it considers correct (explicit ids, or text-substring matches). */
async function expectedIds(row: GoldRow, gameId: string): Promise<string[]> {
  if (row.expectedChunkIds?.length) return row.expectedChunkIds;
  if (!row.expectedTextIncludes?.length) return [];
  const chunks = await gameChunks(gameId);
  // Match on whitespace-normalized text: a PDF→markdown re-ingest reflows line breaks (a needle like
  // "pass the Target to\nanother player" heals to a single space), so an exact substring would miss.
  const normChunks = chunks.map((c) => ({ id: c.id, text: normalize(c.text) }));
  const ids = new Set<string>();
  for (const needle of row.expectedTextIncludes) {
    const lower = normalize(needle);
    for (const chunk of normChunks) {
      if (chunk.text.includes(lower)) ids.add(chunk.id);
    }
  }
  return [...ids];
}

// ── eval endpoint calls ────────────────────────────────────────────────────────────────────

interface RetrieveResult {
  final: string[];
  scores: number[];
  candidates: string[];
}

async function postEval<T>(
  baseUrl: string,
  secret: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    // A browser-ish UA: the custom domain sits behind Cloudflare bot-fight, which 403s (error 1010)
    // a default Node/undici User-Agent before the request ever reaches the Worker.
    headers: {
      "content-type": "application/json",
      "x-eval-secret": secret,
      "user-agent": EVAL_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404) {
    fail(`${path} returned 404 — EVAL_SECRET unset on the Worker or the header mismatched`);
  }
  if (!response.ok) fail(`${path} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

// ── metrics aggregation ──────────────────────────────────────────────────────────────────────

interface ModeScores {
  hit: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function runRetrievalEval(rows: GoldRow[], baseUrl: string, secret: string): Promise<void> {
  const perMode: Record<"dense" | "hybrid", ModeScores[]> = { dense: [], hybrid: [] };
  let scored = 0;
  let hybridRefused = 0;

  for (const row of rows) {
    const gameId = await resolveGameId(row.game, row.edition);
    if (!gameId) {
      console.warn(`⚠ skipping "${row.query}" — Game "${row.game}" not found in the Catalogue`);
      continue;
    }
    const expected = await expectedIds(row, gameId);
    if (expected.length === 0) {
      console.warn(`⚠ skipping "${row.query}" — no expected chunks resolved (check the gold row)`);
      continue;
    }
    scored++;
    for (const mode of ["dense", "hybrid"] as const) {
      const res = await postEval<RetrieveResult>(baseUrl, secret, "/api/eval/retrieve", {
        gameId,
        query: row.query,
        mode,
      });
      perMode[mode].push({
        hit: hitRateAt(res.final, expected, HIT_K),
        recall: recallAt(res.candidates, expected, RECALL_K),
        precision: precisionAt(res.final, expected, PRECISION_K),
        mrr: mrrAt(res.final, expected, RANK_K),
        ndcg: ndcgAt(res.final, expected, RANK_K),
      });
      // False refusal: an answerable gold the LIVE pipeline (hybrid is the prod path) returns nothing
      // for past the rerank gate → the agent says "not in my rulebook". Tracked only on the hybrid leg.
      if (mode === "hybrid" && res.final.length === 0) hybridRefused++;
    }
  }

  if (scored === 0) fail("no gold rows could be scored (no Games matched / no expected chunks)");

  const agg = (mode: "dense" | "hybrid", key: keyof ModeScores) =>
    mean(perMode[mode].map((s) => s[key]));
  const metricRow = (key: keyof ModeScores) => {
    const dense = agg("dense", key);
    const hybrid = agg("hybrid", key);
    const delta = hybrid - dense;
    return {
      dense: pct(dense),
      hybrid: pct(hybrid),
      "Δ (hybrid−dense)": `${delta >= 0 ? "+" : ""}${pct(delta)}`,
    };
  };

  console.log(`\nRetrieval eval over ${scored} gold question(s):\n`);
  console.table({
    [`Hit-Rate@${HIT_K}`]: metricRow("hit"),
    [`MRR@${RANK_K}`]: metricRow("mrr"),
    [`nDCG@${RANK_K}`]: metricRow("ndcg"),
    [`Recall@${RECALL_K}`]: metricRow("recall"),
    [`Precision@${PRECISION_K}`]: metricRow("precision"),
  });
  console.log(
    `\nHybrid false-refusal: ${hybridRefused}/${scored} ` +
      `(${pct(scored ? hybridRefused / scored : 0)}) — answerable gold the live pipeline would refuse.`,
  );
}

/**
 * LLM-judge of GROUNDEDNESS: is every factual claim in the answer supported by the passages it was
 * given? Runs operator-side via the Workers AI REST API (same auth as gen-gold). Returns a 0–1 score,
 * or null when it can't be scored (no answer / no passages / unparseable judge reply). NOTE: the judge
 * is the same model family as one of the answerers, so it self-judges llama; trust the llama-vs-gemma
 * delta over the absolute value.
 */
async function judgeFaithfulness(
  question: string,
  answer: string,
  passages: string[],
  auth: { accountId: string; aiToken: string },
): Promise<number | null> {
  if (!answer || passages.length === 0) return null;
  const json = await workersAiRun<{ result?: { response?: string }; success: boolean }>(
    JUDGE_MODEL,
    {
      max_tokens: 160,
      messages: [
        {
          role: "system",
          content:
            'You grade GROUNDEDNESS for a tabletop-rules assistant. You are given a QUESTION, the assistant\'s ANSWER, and the PASSAGES it was given. Judge ONLY whether every factual rules claim in the ANSWER is directly supported by the PASSAGES — ignore persona, tone, and citation markers. Reply with ONLY a JSON object: {"faithful": <number 0.0-1.0>, "reason": "<short>"} where 1.0 = every claim supported, 0.5 = partly, 0.0 = key claims unsupported or contradicted.',
        },
        {
          role: "user",
          content: `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nPASSAGES:\n${passages
            .map((p, i) => `[${i + 1}] ${p}`)
            .join("\n\n")}`,
        },
      ],
    },
    auth,
  );
  if (!json.success) return null;
  const match = (json.result?.response ?? "").match(/"faithful"\s*:\s*(\d+(?:\.\d+)?)/);
  return match ? Math.max(0, Math.min(1, Number(match[1]))) : null;
}

async function runGenerationEval(rows: GoldRow[], baseUrl: string, secret: string): Promise<void> {
  const auth = await resolveCloudflareAuth();
  console.log(
    `\n⚠ GENERATION compare: up to ${rows.length} question(s) × ${GEN_EVAL_MODELS.length} models = ` +
      `${rows.length * GEN_EVAL_MODELS.length} answer calls + as many faithfulness-judge calls ` +
      `(fewer if games are absent or questions are out of scope; spends credits, bypasses the daily budget).\n`,
  );
  // Accumulate per-model scores so we can print one aggregate verdict at the end (the per-question
  // tables are for qualitative review; the aggregate is the "should we swap models" signal).
  const perModel: Record<
    string,
    { cv: number[]; ov: number[]; attr: number[]; faith: number[]; answered: number }
  > = {};
  for (const m of GEN_EVAL_MODELS)
    perModel[m] = { cv: [], ov: [], attr: [], faith: [], answered: 0 };
  let reachable = 0; // rows that resolved a Game (reached the model) — the honest answered-denominator.

  for (const row of rows) {
    const gameId = await resolveGameId(row.game, row.edition);
    if (!gameId) {
      console.warn(`⚠ skipping "${row.query}" — Game "${row.game}" not found`);
      continue;
    }
    reachable++;
    console.log(`\nQ: ${row.query}`);
    const table: Record<
      string,
      {
        "citation validity": string;
        "citation attribution": string;
        faithfulness: string;
        "token overlap": string;
      }
    > = {};
    for (const model of GEN_EVAL_MODELS) {
      const res = await postEval<{ model: string; answer: string; passages: string[] }>(
        baseUrl,
        secret,
        "/api/eval/answer",
        { gameId, query: row.query, model },
      );
      const markers = parseCitationMarkers(res.answer);
      const cv = res.answer ? citationValidity(markers, res.passages.length) : null;
      const ov = res.answer ? tokenOverlap(res.answer, res.passages.join(" ")) : null;
      // Attribution: did the CITED passages actually contain the gold answer text? Needs the gold row's
      // expectedTextIncludes (— when absent, e.g. an expectedChunkIds-only row).
      const citedPassages = markers
        .map((n) => res.passages[n - 1])
        .filter((p): p is string => typeof p === "string");
      const attr =
        res.answer && row.expectedTextIncludes?.length
          ? citationAttributionPrecision(citedPassages, row.expectedTextIncludes)
          : null;
      const faith = await judgeFaithfulness(row.query, res.answer, res.passages, auth);
      const scores = perModel[model];
      if (cv !== null && ov !== null) {
        scores.answered++;
        scores.cv.push(cv);
        scores.ov.push(ov);
        if (attr !== null) scores.attr.push(attr);
        if (faith !== null) scores.faith.push(faith);
      }
      table[model] = {
        "citation validity": cv === null ? "—" : pct(cv),
        "citation attribution": attr === null ? "—" : pct(attr),
        faithfulness: faith === null ? "—" : pct(faith),
        "token overlap": ov === null ? "—" : pct(ov),
      };
      console.log(`\n  [${model}]\n  ${res.answer.replace(/\n/g, "\n  ") || "(out of scope)"}`);
    }
    console.table(table);
  }

  // Aggregate verdict across all scored questions, one row per model.
  const summary: Record<string, Record<string, string>> = {};
  for (const m of GEN_EVAL_MODELS) {
    const s = perModel[m];
    summary[m] = {
      answered: `${s.answered}/${reachable}`,
      "mean citation validity": s.cv.length ? pct(mean(s.cv)) : "—",
      "mean citation attribution": s.attr.length ? pct(mean(s.attr)) : "—",
      "mean faithfulness": s.faith.length ? pct(mean(s.faith)) : "—",
      "mean token overlap": s.ov.length ? pct(mean(s.ov)) : "—",
    };
  }
  console.log("\n=== Generation compare (aggregate over scored questions) ===");
  console.table(summary);
  console.log(
    "Note: the faithfulness judge is llama-3.3-70b — it self-judges llama's own answers. Read the\n" +
      "llama-vs-gemma delta as the signal, not the absolute score.",
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      gold: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      gen: { type: "boolean", default: false },
    },
  });

  const goldPath = values.gold ?? fail("--gold <path> is required");
  const baseUrl = (values["base-url"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const secret = requireEnv("EVAL_SECRET");

  const rows = JSON.parse(await readFile(goldPath, "utf8")) as GoldRow[];
  if (!Array.isArray(rows) || rows.length === 0) fail(`${goldPath} is not a non-empty JSON array`);
  // Hard stop: gen-gold marks proposed rows _needsReview. The whole point of the flag is to keep
  // uncurated, model-written (vocabulary-echoing) gold out of the metrics — enforce it, don't just
  // document it, or an operator who skips curation gets plausible-looking numbers against bad gold.
  const uncurated = rows.filter((r) => r._needsReview === true);
  if (uncurated.length > 0) {
    fail(
      `${uncurated.length} gold row(s) still flagged _needsReview — curate (drop the flag) before eval`,
    );
  }

  console.log(`Eval target: ${baseUrl} | gold: ${goldPath} (${rows.length} rows)`);
  await runRetrievalEval(rows, baseUrl, secret);
  if (values.gen) await runGenerationEval(rows, baseUrl, secret);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
