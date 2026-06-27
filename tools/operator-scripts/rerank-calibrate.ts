/**
 * Reranker-score CALIBRATION probe (one-shot operator tool).
 *
 * Surfaces the bge-reranker-base score distribution that the live abstention gate
 * (RERANK_MIN_SCORE, src/server/rag/retrieve.ts) hinges on but never exposes: the production
 * pipeline computes reranker scores, gates on them, then DISCARDS them — so RERANK_MIN_SCORE=0.05
 * was set from a single hand-probe of Monopoly (see models.ts). This measures it across the real
 * corpus so the floor (and any future relative/dual-score gate) rests on data, not one anecdote.
 *
 * For each gold question it pulls the REAL fused candidate window from /api/eval/retrieve, fetches
 * candidate texts from D1, and re-runs the EXACT production reranker call (RERANK_MODEL, contexts in
 * fused order, same as retrieve.ts) so the scores match what the live gate sees. It builds three
 * distributions and a threshold sweep:
 *   - in-scope TARGET: reranker score of the gold answer chunk (must clear the floor to ground)
 *   - in-scope TOP:    best reranker score on an answerable query
 *   - OOS TOP:         best reranker score when the query runs against the WRONG game, plus a few
 *                      out-of-domain nonsense queries — the false-positive the gate must reject
 * The sweep reports false-refusal (target gated out) vs false-accept (OOS junk clears) at each cutoff
 * incl. the current 0.05, then a separability verdict. Zero production-code change; bills Workers AI
 * for one reranker call per probed query (same cost class as `pnpm eval`, so scope with --games/--limit).
 *
 * Usage:
 *   EVAL_SECRET=… tsx rerank-calibrate.ts [--gold eval/gold/common.json] [--games Monopoly,Catan]
 *     [--limit N] [--base-url https://games.jasonmatthew.dev]
 */

import { readFile } from "node:fs/promises";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RERANK_MIN_SCORE, RERANK_MODEL } from "worker/rag/models";
import { fetchWithRetry } from "./lib/http";
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
const DEFAULT_GOLD = ["eval/gold/common.json", "eval/gold/catalogue.json"];
// Out-of-domain probes (mirrors the models.ts calibration anecdotes): clearly-irrelevant queries run
// against a real game — the gate must reject these. The cosine floor (RETRIEVAL_MIN_SCORE) may already
// drop them pre-rerank (→ no candidates), which is itself a recorded outcome ("pre-floored").
const NONSENSE_QUERIES = [
  "what is the capital of France",
  "best opening move in Go",
  "how do I castle in chess",
  "what is a good recipe for banana bread",
];
const SWEEP = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];

interface GoldRow {
  game: string;
  edition?: string;
  query: string;
  expectedChunkIds?: string[];
  expectedTextIncludes?: string[];
  _needsReview?: boolean;
}

interface RetrieveResult {
  final: string[];
  scores: number[];
  candidates: string[];
}

// ── pure helpers (unit-tested in rerank-calibrate.test.ts) ─────────────────────────────────────

/** Nearest-rank percentile of a numeric sample (p in [0,1]); NaN on empty so callers can show "—". */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * For a candidate cutoff t, the two error rates a scope gate trades off:
 *   - falseRefusal: in-scope queries whose retrieved target chunk scores BELOW t (right answer gated
 *     out). Denominator is only rows where the target actually reached the reranker (a target missing
 *     from candidates is a retrieval miss, not a gate failure — excluded so the gate isn't blamed for it).
 *   - falseAccept: OOS queries whose BEST candidate scores at/above t (irrelevant junk clears the gate
 *     and reaches the model). Denominator is OOS queries that produced any reranked candidate.
 */
export function sweepRow(
  t: number,
  inScopeTargets: { targetScore: number; targetInCandidates: boolean }[],
  oosTops: number[],
): { t: number; falseRefusal: number; falseAccept: number } {
  const gateable = inScopeTargets.filter((r) => r.targetInCandidates);
  const refused = gateable.filter((r) => r.targetScore < t).length;
  const accepted = oosTops.filter((s) => s >= t).length;
  return {
    t,
    falseRefusal: gateable.length ? refused / gateable.length : Number.NaN,
    falseAccept: oosTops.length ? accepted / oosTops.length : Number.NaN,
  };
}

// ── corpus access ──────────────────────────────────────────────────────────────────────────────

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

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Gold row → the chunk ids it considers correct (explicit ids, or whitespace-normalized text matches). */
async function expectedIds(row: GoldRow, gameId: string): Promise<string[]> {
  if (row.expectedChunkIds?.length) return row.expectedChunkIds;
  if (!row.expectedTextIncludes?.length) return [];
  const chunks = await gameChunks(gameId);
  const norm = chunks.map((c) => ({ id: c.id, text: normalize(c.text) }));
  const ids = new Set<string>();
  for (const needle of row.expectedTextIncludes) {
    const lower = normalize(needle);
    for (const chunk of norm) if (chunk.text.includes(lower)) ids.add(chunk.id);
  }
  return [...ids];
}

async function fetchCandidates(
  baseUrl: string,
  secret: string,
  gameId: string,
  query: string,
): Promise<string[]> {
  // Retry on the rate-limit 500s the eval endpoints throw under Workers-AI contention (backoff spaces
  // a long run out instead of aborting it on one transient blip).
  const res = await fetchWithRetry(
    `${baseUrl}/api/eval/retrieve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eval-secret": secret,
        "user-agent": EVAL_USER_AGENT,
      },
      body: JSON.stringify({ gameId, query, mode: "hybrid" }),
    },
    { label: "eval/retrieve" },
  );
  if (res.status === 404)
    fail("/api/eval/retrieve 404 — EVAL_SECRET unset on the Worker or mismatched");
  if (!res.ok) fail(`/api/eval/retrieve → ${res.status}: ${await res.text()}`);
  return ((await res.json()) as RetrieveResult).candidates;
}

/**
 * Re-run the production reranker over a fused candidate window and return chunkId → reranker score.
 * Mirrors retrieve.ts exactly: contexts in fused order, same RERANK_MODEL; the response `id` indexes
 * into the contexts we sent. top_k = all candidates (top_k bounds only how many rows return, not the
 * per-pair scores) so we observe every score, including the sub-gate ones production discards.
 */
async function rerankScores(
  gameId: string,
  query: string,
  candidateIds: string[],
  auth: { accountId: string; aiToken: string },
): Promise<Map<string, number>> {
  if (candidateIds.length === 0) return new Map();
  const byId = new Map((await gameChunks(gameId)).map((c) => [c.id, c.text]));
  const present = candidateIds.flatMap((id) => {
    const text = byId.get(id);
    return text ? [{ id, text }] : [];
  });
  if (present.length === 0) return new Map();
  const out = await workersAiRun<{ result?: { response?: { id: number; score: number }[] } }>(
    RERANK_MODEL,
    { query, contexts: present.map((c) => ({ text: c.text })), top_k: present.length },
    auth,
  );
  const scores = new Map<string, number>();
  for (const { id, score } of out.result?.response ?? []) {
    const cand = present[id];
    if (cand) scores.set(cand.id, score);
  }
  return scores;
}

// ── reporting ────────────────────────────────────────────────────────────────────────────────

const pct = (v: number) => (Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const sc = (v: number) => (Number.isNaN(v) ? "—" : v.toFixed(4));

function distRow(label: string, values: number[]) {
  return {
    n: values.length,
    min: sc(percentile(values, 0)),
    p10: sc(percentile(values, 0.1)),
    p50: sc(percentile(values, 0.5)),
    p90: sc(percentile(values, 0.9)),
    max: sc(values.length ? Math.max(...values) : Number.NaN),
    label,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      gold: { type: "string", multiple: true },
      games: { type: "string" },
      limit: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
    },
  });
  const goldPaths = values.gold?.length ? values.gold : DEFAULT_GOLD;
  const baseUrl = (values["base-url"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const secret = requireEnv("EVAL_SECRET");
  const gameFilter = values.games?.split(",").map((g) => g.trim().toLowerCase());
  const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;

  let rows: GoldRow[] = [];
  for (const path of goldPaths) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GoldRow[];
    rows.push(...parsed);
  }
  rows = rows.filter((r) => !r._needsReview);
  if (gameFilter) rows = rows.filter((r) => gameFilter.includes(r.game.toLowerCase()));

  // Resolve each row to a gameId once; drop rows whose Game/target can't resolve (a retrieval-setup
  // problem, not a gate problem). Cap per game with --limit for cheap exploratory runs.
  const auth = await resolveCloudflareAuth();
  const perGameCount = new Map<string, number>();
  const resolved: { row: GoldRow; gameId: string; targetIds: string[] }[] = [];
  for (const row of rows) {
    const gameId = await resolveGameId(row.game, row.edition);
    if (!gameId) continue;
    const n = perGameCount.get(gameId) ?? 0;
    if (n >= limit) continue;
    const targetIds = await expectedIds(row, gameId);
    if (targetIds.length === 0) continue;
    perGameCount.set(gameId, n + 1);
    resolved.push({ row, gameId, targetIds });
  }
  if (resolved.length === 0)
    fail("no gold rows resolved (no Games matched / no targets / all capped)");

  // A distinct, deterministic game ring for cross-game OOS pairing (each in-scope query is also run
  // against the NEXT game in first-seen order — same query, wrong rulebook).
  const ring: { name: string; gameId: string }[] = [];
  const seen = new Set<string>();
  for (const r of resolved) {
    if (!seen.has(r.gameId)) {
      seen.add(r.gameId);
      ring.push({ name: r.row.game, gameId: r.gameId });
    }
  }

  console.log(
    `rerank-calibrate → ${baseUrl} | ${resolved.length} in-scope rows across ${ring.length} game(s)` +
      ` | gate=RERANK_MIN_SCORE=${RERANK_MIN_SCORE}\n`,
  );

  const inScopeTargets: { targetScore: number; targetInCandidates: boolean }[] = [];
  const inScopeTops: number[] = [];
  const oosTops: number[] = [];
  let oosPreFloored = 0;

  for (let i = 0; i < resolved.length; i++) {
    const { row, gameId, targetIds } = resolved[i] as (typeof resolved)[number];

    // In-scope: query against its OWN game.
    const cands = await fetchCandidates(baseUrl, secret, gameId, row.query);
    const scores = await rerankScores(gameId, row.query, cands, auth);
    const all = [...scores.values()];
    const targetIn = targetIds.some((id) => scores.has(id));
    const targetScore = Math.max(
      ...targetIds.map((id) => scores.get(id) ?? Number.NEGATIVE_INFINITY),
    );
    inScopeTargets.push({
      targetScore: targetIn ? targetScore : Number.NEGATIVE_INFINITY,
      targetInCandidates: targetIn,
    });
    if (all.length) inScopeTops.push(Math.max(...all));

    // OOS cross-game: same query, next game in the ring (skip if only one game in scope).
    if (ring.length > 1) {
      const other = ring[
        (ring.findIndex((g) => g.gameId === gameId) + 1) % ring.length
      ] as (typeof ring)[number];
      const oCands = await fetchCandidates(baseUrl, secret, other.gameId, row.query);
      const oScores = [...(await rerankScores(other.gameId, row.query, oCands, auth)).values()];
      if (oScores.length) oosTops.push(Math.max(...oScores));
      else oosPreFloored++;
    }
    process.stdout.write(`\r  probed ${i + 1}/${resolved.length}`);
  }

  // Out-of-domain nonsense queries against the first in-scope game.
  const probeGame = ring[0] as (typeof ring)[number];
  for (const q of NONSENSE_QUERIES) {
    const cands = await fetchCandidates(baseUrl, secret, probeGame.gameId, q);
    const s = [...(await rerankScores(probeGame.gameId, q, cands, auth)).values()];
    if (s.length) oosTops.push(Math.max(...s));
    else oosPreFloored++;
  }
  console.log("\n");

  console.log("Reranker-score distributions (sigmoid-normalised [0,1]):");
  console.table([
    distRow(
      "in-scope TARGET chunk",
      inScopeTargets.filter((r) => r.targetInCandidates).map((r) => r.targetScore),
    ),
    distRow("in-scope TOP candidate", inScopeTops),
    distRow("OOS TOP candidate", oosTops),
  ]);
  const missing = inScopeTargets.filter((r) => !r.targetInCandidates).length;
  console.log(
    `Retrieval misses (target chunk never reached the reranker): ${missing}/${inScopeTargets.length}` +
      ` — these are a retrieval problem, excluded from the gate sweep below.`,
  );
  console.log(`OOS queries pre-floored by the cosine floor (no candidates): ${oosPreFloored}\n`);

  console.log(
    "Threshold sweep — false-refusal (in-scope target gated out) vs false-accept (OOS junk clears):",
  );
  console.table(
    SWEEP.map((t) => {
      const r = sweepRow(t, inScopeTargets, oosTops);
      return {
        cutoff: t === RERANK_MIN_SCORE ? `${t} (current)` : `${t}`,
        "false-refusal": pct(r.falseRefusal),
        "false-accept": pct(r.falseAccept),
      };
    }),
  );

  // Separability verdict: is there any swept cutoff with both error rates ≤ 10%?
  const clean = SWEEP.map((t) => sweepRow(t, inScopeTargets, oosTops)).filter(
    (r) => r.falseRefusal <= 0.1 && r.falseAccept <= 0.1,
  );
  console.log(
    clean.length
      ? `\nVERDICT: SEPARABLE — cutoff(s) ${clean.map((r) => r.t).join(", ")} keep both error rates ≤10%. ` +
          "A calibrated absolute floor (or dual-score gate) is viable."
      : "\nVERDICT: OVERLAPPING — no swept cutoff keeps both error rates ≤10%. Reranker score alone " +
          "cannot gate scope on this corpus; an answerability/NLI check is the real fix (see RESEARCH).",
  );
}

// Run only when executed directly (tsx rerank-calibrate.ts), not when the test imports the helpers.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
