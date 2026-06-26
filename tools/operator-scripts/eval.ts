/**
 * Retrieval + generation EVAL HARNESS (GAP 2, ADR 0007) — an operator-side Node script.
 *
 * It exercises the REAL pipeline through the secret-gated Worker endpoints (POST /api/eval/*), so
 * the numbers reflect production retrieval (dense + lexical legs, RRF, reranker, gate) rather than a
 * script reimplementation that would drift. Two modes:
 *
 *   RETRIEVAL (default) — for each gold question, retrieve in BOTH dense and hybrid mode and report
 *     Hit-Rate@5, Recall@20, Precision@5 per mode plus the hybrid−dense delta. Zero GENERATION-LLM
 *     cost, but it DOES bill Workers AI for the embedding + reranker on every query (per project
 *     notes, Workers AI always hits the network).
 *
 *   GENERATION (--gen) — additionally run each gold question through every model in GEN_EVAL_MODELS
 *     (llama-3.3-70b + gemma-4-26b-a4b-it) and print a citation-validity + token-overlap heuristic
 *     side by side. This SPENDS GENERATION CREDITS (2 model calls per question) and bypasses the
 *     agent's daily budget breaker — run it on a SMALL subset, deliberately.
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
  citationValidity,
  hitRateAt,
  parseCitationMarkers,
  precisionAt,
  recallAt,
  tokenOverlap,
} from "worker/rag/eval-metrics";
import { GEN_EVAL_MODELS } from "worker/rag/models";
import { d1Select, EVAL_USER_AGENT, fail, requireEnv, resolveGameId, sqlStr } from "./lib/wrangler";

const DEFAULT_BASE_URL = "https://games.jasonmatthew.dev";
const HIT_K = 5;
const RECALL_K = 20;
const PRECISION_K = 5;

interface GoldRow {
  game: string;
  edition?: string;
  query: string;
  expectedChunkIds?: string[];
  expectedTextIncludes?: string[];
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
      });
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
    [`Recall@${RECALL_K}`]: metricRow("recall"),
    [`Precision@${PRECISION_K}`]: metricRow("precision"),
  });
}

async function runGenerationEval(rows: GoldRow[], baseUrl: string, secret: string): Promise<void> {
  console.log(
    `\n⚠ GENERATION compare: ${rows.length} question(s) × ${GEN_EVAL_MODELS.length} models = ` +
      `${rows.length * GEN_EVAL_MODELS.length} model calls (spends credits, bypasses the daily budget).\n`,
  );
  // Accumulate per-model scores so we can print one aggregate verdict at the end (the per-question
  // tables are for qualitative review; the aggregate is the "should we swap models" signal).
  const perModel: Record<string, { cv: number[]; ov: number[]; answered: number }> = {};
  for (const m of GEN_EVAL_MODELS) perModel[m] = { cv: [], ov: [], answered: 0 };

  for (const row of rows) {
    const gameId = await resolveGameId(row.game, row.edition);
    if (!gameId) {
      console.warn(`⚠ skipping "${row.query}" — Game "${row.game}" not found`);
      continue;
    }
    console.log(`\nQ: ${row.query}`);
    const table: Record<string, { "citation validity": string; "token overlap": string }> = {};
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
      if (cv !== null && ov !== null) {
        perModel[model].answered++;
        perModel[model].cv.push(cv);
        perModel[model].ov.push(ov);
      }
      table[model] = {
        "citation validity": cv === null ? "—" : pct(cv),
        "token overlap": ov === null ? "—" : pct(ov),
      };
      console.log(`\n  [${model}]\n  ${res.answer.replace(/\n/g, "\n  ") || "(out of scope)"}`);
    }
    console.table(table);
  }

  // Aggregate verdict across all scored questions, one row per model.
  const summary: Record<string, Record<string, string>> = {};
  for (const m of GEN_EVAL_MODELS) {
    summary[m] = {
      answered: `${perModel[m].answered}/${rows.length}`,
      "mean citation validity": pct(mean(perModel[m].cv)),
      "mean token overlap": pct(mean(perModel[m].ov)),
    };
  }
  console.log("\n=== Generation compare (aggregate over scored questions) ===");
  console.table(summary);
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

  console.log(`Eval target: ${baseUrl} | gold: ${goldPath} (${rows.length} rows)`);
  await runRetrievalEval(rows, baseUrl, secret);
  if (values.gen) await runGenerationEval(rows, baseUrl, secret);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
