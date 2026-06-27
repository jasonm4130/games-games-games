/**
 * Answerability-judge eval (multi-model) — does a focused "can these passages answer X?" LLM call
 * separate in-scope from out-of-scope where the reranker SCORE cannot? (See
 * docs/research/2026-06-27-rerank-abstention-calibration.md: reranker scores overlap end-to-end, so
 * no score gate decides scope; ELOQ's fix is an answerability check, a different question than
 * relevance. Workers AI has no NLI model, so the check is a focused LLM call — this trials several.)
 *
 * For each gold question it reconstructs the passages the generator would see (top-RETRIEVAL_TOP_K
 * reranked candidates, NO score floor — answerability is meant to REPLACE the floor), then asks each
 * candidate model to rule ANSWERABLE / PARTIAL / UNANSWERABLE from ONLY those passages. Two gold
 * groups: ANSWERABLE (common.json + catalogue.json, the judge should say yes/partial) and
 * UNANSWERABLE (unanswerable.json — in-game strategy/history/price/opinion + assistant-meta, the
 * judge should say no). It reports, per model, the answer/refuse rates on each group and a balanced
 * accuracy, then ranks the models — the best-in-class answerability judge for this corpus.
 *
 * Cost: retrieval (embed+rerank) once per question + one short judge call per question per model.
 * Judge output is one word, so cost is dominated by the passage input (~$0.0001–0.001/call). Scope a
 * first pass with --games/--limit. gemma-4-26b is deliberately NOT a default: models.ts records it
 * returns "out of scope" on everything on Workers AI (dead id) — pass it via --models to confirm.
 *
 * Usage:
 *   EVAL_SECRET=… tsx answerability-eval.ts [--games Monopoly,Catan] [--limit N]
 *     [--models @cf/meta/llama-3.2-3b-instruct,@cf/...] [--base-url https://games.jasonmatthew.dev]
 */

import { readFile } from "node:fs/promises";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseCitationMarkers } from "worker/rag/eval-metrics";
import { GENERATION_MODEL, RETRIEVAL_TOP_K } from "worker/rag/models";
import { fetchWithRetry } from "./lib/http";
import {
  EVAL_USER_AGENT,
  fail,
  requireEnv,
  resolveCloudflareAuth,
  resolveGameId,
  workersAiRun,
} from "./lib/wrangler";
import { fetchCandidates, type GoldRow, gameChunks, rerankScores } from "./rerank-calibrate";

const DEFAULT_BASE_URL = "https://games.jasonmatthew.dev";
const ANSWERABLE_GOLD = ["eval/gold/common.json", "eval/gold/catalogue.json"];
const UNANSWERABLE_GOLD = "eval/gold/unanswerable.json";
// Candidate judge models (verified ids from the Workers AI catalog/pricing, 2026-06-27). Spread from
// the 70B generator down to the cheapest micro model. gemma-4-26b excluded — dead on Workers AI.
const DEFAULT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/ibm-granite/granite-4.0-h-micro",
];

const SYSTEM = `You are a strict gatekeeper for a tabletop game rules assistant. You are given a QUESTION and numbered PASSAGES from a game's rulebook. Decide ONLY whether the PASSAGES contain enough information to answer the QUESTION. Use ONLY the passages — ignore any outside knowledge you may have about the game. Reply with EXACTLY ONE word and nothing else: ANSWERABLE if the passages directly answer the question, PARTIAL if they answer only part of it, or UNANSWERABLE if the passages do not address the question.`;

export type Verdict = "yes" | "partial" | "no";

/**
 * Map a judge model's reply to a verdict. Checks UNANSWERABLE before ANSWERABLE because the former
 * CONTAINS the latter as a substring — order is load-bearing. null when no keyword is present.
 */
export function parseVerdict(text: string): Verdict | null {
  const t = text.toUpperCase();
  if (t.includes("UNANSWERABLE")) return "no";
  if (t.includes("PARTIAL")) return "partial";
  if (t.includes("ANSWERABLE")) return "yes";
  return null;
}

/**
 * Score one model's verdicts for one gold group. "Correct" = answer (yes/partial) on the answerable
 * group, refuse (no) on the unanswerable group. Unparseable replies are excluded from the rate
 * denominator but counted, since a model that won't follow the one-word format is itself disqualifying.
 */
export function groupStats(verdicts: (Verdict | null)[], answerableExpected: boolean) {
  const parsed = verdicts.filter((v): v is Verdict => v !== null);
  const correct = parsed.filter((v) =>
    answerableExpected ? v === "yes" || v === "partial" : v === "no",
  ).length;
  return {
    n: verdicts.length,
    yes: parsed.filter((v) => v === "yes").length,
    partial: parsed.filter((v) => v === "partial").length,
    no: parsed.filter((v) => v === "no").length,
    unparseable: verdicts.length - parsed.length,
    correctRate: parsed.length ? correct / parsed.length : Number.NaN,
  };
}

const pct = (v: number) => (Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`);

/**
 * Classify a production answer as answered vs refused, robustly. A grounded ruling carries [n]
 * citation markers (the prompt requires one on every rule sentence); a refusal ("That is not in my
 * rulebook.") and the pre-LLM canned path (empty answer) carry none. Citation-presence sidesteps the
 * phrase-match trap where "you get 7 cards [1], but the rest is not in my rulebook" reads as a refusal
 * — it cites, so it ANSWERED (partial coverage).
 */
export function classifyAnswer(answer: string): "answered" | "refused" {
  return parseCitationMarkers(answer).length > 0 ? "answered" : "refused";
}

/** Call the REAL production pipeline (retrieve WITH the rerank floor → inline-judge prompt → generate). */
async function inlineAnswer(
  baseUrl: string,
  secret: string,
  gameId: string,
  query: string,
): Promise<string> {
  const res = await fetchWithRetry(
    `${baseUrl}/api/eval/answer`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eval-secret": secret,
        "user-agent": EVAL_USER_AGENT,
      },
      body: JSON.stringify({ gameId, query }),
    },
    { label: "eval/answer" },
  );
  if (!res.ok) fail(`/api/eval/answer → ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { answer: string }).answer;
}

interface Probe {
  row: GoldRow;
  gameId: string;
  answerable: boolean;
  passages: string[];
}

/** Reconstruct the passages the generator would see: top-RETRIEVAL_TOP_K reranked candidates, no floor. */
async function topPassages(
  baseUrl: string,
  secret: string,
  gameId: string,
  query: string,
  auth: { accountId: string; aiToken: string },
): Promise<string[]> {
  const cands = await fetchCandidates(baseUrl, secret, gameId, query);
  const scores = await rerankScores(gameId, query, cands, auth);
  const text = new Map((await gameChunks(gameId)).map((c) => [c.id, c.text]));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RETRIEVAL_TOP_K)
    .map(([id]) => text.get(id) ?? "")
    .filter(Boolean);
}

async function judge(
  model: string,
  question: string,
  passages: string[],
  auth: { accountId: string; aiToken: string },
): Promise<Verdict | null> {
  if (passages.length === 0) return "no"; // nothing retrieved → trivially unanswerable
  const out = await workersAiRun<{
    result?: { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  }>(
    model,
    {
      max_tokens: 16,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `QUESTION: ${question}\n\nPASSAGES:\n${passages
            .map((p, i) => `[${i + 1}] ${p}`)
            .join("\n\n")}`,
        },
      ],
    },
    auth,
  );
  // Workers AI returns either native `result.response` (llama) or an OpenAI-shaped
  // `result.choices[0].message.content` (granite + other OpenAI-compat ids) — accept both. workersAiRun
  // already throws on non-2xx, so a missing field means unparseable, not an error to swallow.
  const raw = out.result?.response ?? out.result?.choices?.[0]?.message?.content;
  return raw == null ? null : parseVerdict(typeof raw === "string" ? raw : JSON.stringify(raw));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      games: { type: "string" },
      limit: { type: "string" },
      models: { type: "string" },
      baseline: { type: "boolean", default: false },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
    },
  });
  const baseUrl = (values["base-url"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const secret = requireEnv("EVAL_SECRET");
  const models = values.models?.split(",").map((m) => m.trim()) ?? DEFAULT_MODELS;
  const gameFilter = values.games?.split(",").map((g) => g.trim().toLowerCase());
  const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;

  const answerableRows: GoldRow[] = [];
  for (const path of ANSWERABLE_GOLD) {
    answerableRows.push(...(JSON.parse(await readFile(path, "utf8")) as GoldRow[]));
  }
  const unanswerableRows = JSON.parse(await readFile(UNANSWERABLE_GOLD, "utf8")) as GoldRow[];
  const tag = (rows: GoldRow[], answerable: boolean) =>
    rows
      .filter((r) => !r._needsReview)
      .filter((r) => !gameFilter || gameFilter.includes(r.game.toLowerCase()))
      .map((row) => ({ row, answerable }));
  // --limit caps the big answerable group per game (cheap exploratory runs); the small unanswerable
  // set always runs in full — it is the whole point of the test.
  const perGame = new Map<string, number>();
  const work = [
    ...tag(answerableRows, true).filter((w) => {
      const n = perGame.get(w.row.game) ?? 0;
      if (n >= limit) return false;
      perGame.set(w.row.game, n + 1);
      return true;
    }),
    ...tag(unanswerableRows, false),
  ];

  // --baseline: measure the CURRENT system (rerank floor + inline-judge prompt + generation) on the
  // same probes, so the separate 70B answerability gate (§8: 89.2% balanced) has a head-to-head. Uses
  // /api/eval/answer (its own retrieval WITH the floor) and classifies answered/refused by citations.
  // Spends generation credits (one llama-3.3-70b answer per probe), so it skips the judge-model loop.
  if (values.baseline) {
    const results: { answerable: boolean; cls: "answered" | "refused" }[] = [];
    for (let i = 0; i < work.length; i++) {
      const w = work[i] as (typeof work)[number];
      const gameId = await resolveGameId(w.row.game, w.row.edition);
      if (!gameId) continue;
      const answer = await inlineAnswer(baseUrl, secret, gameId, w.row.query);
      results.push({ answerable: w.answerable, cls: classifyAnswer(answer) });
      process.stdout.write(`\r  answered ${i + 1}/${work.length}`);
    }
    console.log("\n");
    const ans = results.filter((r) => r.answerable);
    const uns = results.filter((r) => !r.answerable);
    const ansRate = ans.length
      ? ans.filter((r) => r.cls === "answered").length / ans.length
      : Number.NaN;
    const unsRate = uns.length
      ? uns.filter((r) => r.cls === "refused").length / uns.length
      : Number.NaN;
    console.log(
      `CURRENT pipeline (rerank floor + inline judge + ${GENERATION_MODEL.replace("@cf/", "")}) ` +
        `on ${ans.length} answerable + ${uns.length} unanswerable:`,
    );
    console.table([
      {
        "answerable→answer": pct(ansRate),
        "unanswerable→refuse": pct(unsRate),
        "balanced acc": pct((ansRate + unsRate) / 2),
      },
    ]);
    console.log(
      "\nHead-to-head: a SEPARATE 70B answerability gate scored 89.2% balanced (§8 of the research note).\n" +
        "If this baseline matches/beats it, the inline judge already suffices — don't add a second call.",
    );
    return;
  }

  const auth = await resolveCloudflareAuth();
  const probes: Probe[] = [];
  for (let i = 0; i < work.length; i++) {
    const w = work[i] as (typeof work)[number];
    const gameId = await resolveGameId(w.row.game, w.row.edition);
    if (!gameId) continue;
    const passages = await topPassages(baseUrl, secret, gameId, w.row.query, auth);
    probes.push({ row: w.row, gameId, answerable: w.answerable, passages });
    process.stdout.write(`\r  retrieved ${i + 1}/${work.length}`);
  }
  console.log("");

  const nAns = probes.filter((p) => p.answerable).length;
  console.log(
    `answerability-eval → ${baseUrl} | ${nAns} answerable + ${probes.length - nAns} unanswerable` +
      ` probes | ${models.length} model(s) | passages=top-${RETRIEVAL_TOP_K}, no floor\n`,
  );

  // verdicts[model][probeIndex]. Judge all models for a probe concurrently (bounded fan-out = #models);
  // probes stay sequential so retrieval/judging is gentle on Workers-AI rate limits.
  const verdicts = new Map<string, (Verdict | null)[]>(models.map((m) => [m, []]));
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i] as Probe;
    const results = await Promise.all(models.map((m) => judge(m, p.row.query, p.passages, auth)));
    models.forEach((m, j) => {
      (verdicts.get(m) as (Verdict | null)[]).push(results[j] as Verdict | null);
    });
    process.stdout.write(`\r  judged ${i + 1}/${probes.length}`);
  }
  console.log("\n");

  // Per-model scorecard, ranked by balanced accuracy (answerable answer-rate + unanswerable refuse-rate)/2.
  const ansMask = probes.map((p) => p.answerable);
  const ranked = models
    .map((model) => {
      const v = verdicts.get(model) as (Verdict | null)[];
      const ans = groupStats(
        v.filter((_, i) => ansMask[i]),
        true,
      );
      const uns = groupStats(
        v.filter((_, i) => !ansMask[i]),
        false,
      );
      const balanced = (ans.correctRate + uns.correctRate) / 2;
      return { model, ans, uns, balanced };
    })
    .sort(
      (a, b) =>
        (Number.isNaN(b.balanced) ? -1 : b.balanced) - (Number.isNaN(a.balanced) ? -1 : a.balanced),
    );

  console.log("Per-model answerability scorecard (ranked by balanced accuracy):");
  console.table(
    ranked.map((r) => ({
      model: r.model.replace("@cf/", ""),
      "answerable→answer": pct(r.ans.correctRate),
      "unanswerable→refuse": pct(r.uns.correctRate),
      "balanced acc": pct(r.balanced),
      "ans y/p/n": `${r.ans.yes}/${r.ans.partial}/${r.ans.no}`,
      "uns y/p/n": `${r.uns.yes}/${r.uns.partial}/${r.uns.no}`,
      unparseable: r.ans.unparseable + r.uns.unparseable,
    })),
  );

  // Curation aid: unanswerable probes a MAJORITY of models judged answerable are probably bad gold
  // (the rulebook does cover them) — surface for review rather than trusting the score blindly.
  const suspect = probes
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.answerable)
    .filter(({ i }) => {
      const says = models.filter((m) => {
        const v = (verdicts.get(m) as (Verdict | null)[])[i];
        return v === "yes" || v === "partial";
      }).length;
      return says > models.length / 2;
    });
  if (suspect.length) {
    console.log(
      "\n⚠ Unanswerable gold a majority of models judged ANSWERABLE (review — maybe bad gold):",
    );
    for (const { p } of suspect) console.log(`  - [${p.row.game}] ${p.row.query}`);
  }

  const winner = ranked[0];
  if (winner && !Number.isNaN(winner.balanced)) {
    console.log(
      `\nBest on this corpus: ${winner.model.replace("@cf/", "")} ` +
        `(balanced ${pct(winner.balanced)}). Compare against the LLM-as-scope-judge baseline already ` +
        "in prompt.ts before wiring a separate call into retrieve.ts.",
    );
  }
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
