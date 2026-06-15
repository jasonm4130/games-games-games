import { generateText } from "ai";
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { createWorkersAI } from "workers-ai-provider";
import { MAX_OUTPUT_TOKENS } from "./agent";
import { formatGrounding } from "./rag/context";
import { GEN_EVAL_MODELS, GENERATION_MODEL } from "./rag/models";
import { buildRulesSystemPrompt } from "./rag/prompt";
import { retrieve, retrieveDetailed } from "./rag/retrieve";

// The DurableObject class must be a named export of the Worker's main module.
export { RulesAgent } from "./agent";

const app = new Hono<{ Bindings: Env }>();

// Per-IP guardrail on agent traffic (connections + messages all hit /agents/*). Keyed by the
// client IP so one abuser can't exhaust the global budget; runs before the agent is routed.
// Per-colo, so it caps bursts, not a daily total (that's the D1 breaker in the agent).
app.use("/agents/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.IP_LIMITER.limit({ key: ip });
  if (!success) {
    return c.text("Too Many Requests", 429, { "Retry-After": "60" });
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Goblin TTS is NOT an HTTP route: it is the RulesAgent `speak` @callable, reachable only over the
// authenticated agent WebSocket (so the ElevenLabs key can't be driven by arbitrary callers, and
// only a ruling the session actually produced can be voiced). See src/server/agent.ts + ADR 0006.

// ── Eval harness (GAP 2, ADR 0007) — operator-only, secret-gated ─────────────────────────────
// These routes reuse the REAL retrieve() so the eval measures the production pipeline (DRY +
// accurate) instead of a script reimplementation that would drift. Both are gated by an
// x-eval-secret header matched against env.EVAL_SECRET: when EVAL_SECRET is unset OR the header
// mismatches they return 404 (not 403) so the surface is invisible unless explicitly enabled.
// They are NOT rate-limited or budget-counted — the secret is the gate (an operator tool).
// /api/eval/answer spends real generation credits (it calls the model); /api/eval/retrieve still
// hits Workers AI for the embedding + reranker. Run them deliberately, on a small gold set.

function evalAuthorized(c: { req: { header: (n: string) => string | undefined }; env: Env }) {
  const secret = c.env.EVAL_SECRET;
  return Boolean(secret) && c.req.header("x-eval-secret") === secret;
}

// Run the real retrieval pipeline for one {gameId, query, mode}. Returns the post-rerank-gate
// `final` ids+scores (for Hit-Rate@5 / Precision@5) AND the pre-rerank fused `candidates` window
// (for Recall@20 over what actually reached the reranker). mode 'dense' skips the lexical leg.
app.post("/api/eval/retrieve", async (c) => {
  if (!evalAuthorized(c)) return c.notFound();
  const body = await c.req
    .json<{ gameId?: string; query?: string; mode?: "dense" | "hybrid" }>()
    .catch(() => null);
  const gameId = body?.gameId?.trim();
  const query = body?.query?.trim();
  if (!gameId || !query) return c.text("Missing gameId or query", 400);
  const mode = body?.mode === "dense" ? "dense" : "hybrid";
  // One call → both the post-rerank `final` and the pre-rerank `candidates` window from a single
  // embed + Vectorize query (retrieveDetailed), instead of running retrieve() and retrieveCandidates()
  // side by side (which would embed + query twice for the same input).
  const { passages, candidateIds } = await retrieveDetailed(c.env, query, { gameId, mode });
  return c.json({
    final: passages.map((p) => p.chunk.id),
    scores: passages.map((p) => p.score),
    candidates: candidateIds,
  });
});

// Retrieve + answer one gold question with a chosen generation model (default GENERATION_MODEL).
// Used by the eval's --gen compare to run a question through llama AND gemma. Returns the answer
// text + the grounding passages (text only) so the script can score citation validity + overlap.
app.post("/api/eval/answer", async (c) => {
  if (!evalAuthorized(c)) return c.notFound();
  const body = await c.req
    .json<{ gameId?: string; query?: string; model?: string }>()
    .catch(() => null);
  const gameId = body?.gameId?.trim();
  const query = body?.query?.trim();
  if (!gameId || !query) return c.text("Missing gameId or query", 400);
  const model = body?.model?.trim() || GENERATION_MODEL;
  // Lock to the eval allowlist (GENERATION_MODEL is its first entry): an operator with the secret
  // can't drive arbitrary, costlier Workers AI models through this endpoint.
  if (!(GEN_EVAL_MODELS as readonly string[]).includes(model)) {
    return c.text("Unknown model", 400);
  }

  const passages = await retrieve(c.env, query, { gameId });
  if (passages.length === 0) {
    return c.json({ model, answer: "", passages: [] as string[] });
  }
  const grounding = formatGrounding(passages);
  const gameName = passages[0]?.gameName ?? "this game";
  const workersai = createWorkersAI({ binding: c.env.AI });
  // Use the SAME system prompt the live agent uses so the eval measures the real goblin (and the
  // injection-eval exercises the real hardening), not a drifted one-shot copy.
  const { text } = await generateText({
    model: workersai(model),
    system: buildRulesSystemPrompt(gameName, grounding),
    prompt: query,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return c.json({ model, answer: text, passages: passages.map((p) => p.chunk.text) });
});

// Ingestion is NOT a Worker route — it runs as an operator-side Node script (scripts/ingest.ts,
// ADR 0005). The SPA is served by the assets binding; its run_worker_first only forwards
// /agents/* and /api/* to this Worker, so everything else never reaches Hono.

// agentsMiddleware handles the WebSocket upgrade + agent HTTP routing for
// /agents/{agent-name}/{instance} (RulesAgent → kebab "rules-agent"); it calls next() for
// non-agent paths, so the routes above still resolve. See hono-agents.
app.use("*", agentsMiddleware());

app.notFound((c) => c.text("Not found", 404));

export default app;
