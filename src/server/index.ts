import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { synthesizeSpeech, TTS_MAX_CHARS } from "./tts";

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

// Read a goblin ruling aloud via ElevenLabs (key is a server secret). Rate-limited per IP since
// each call spends real credits, and length-capped. Returns audio/mpeg; 502 on upstream failure.
app.post("/api/tts", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.TTS_LIMITER.limit({ key: ip })).success) {
    return c.text("Too Many Requests", 429, { "Retry-After": "60" });
  }
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  const text = body?.text?.trim();
  if (!text) return c.text("Missing text", 400);
  if (text.length > TTS_MAX_CHARS) return c.text("Text too long", 400);
  try {
    return await synthesizeSpeech(c.env, text);
  } catch (err) {
    console.error("[tts]", err);
    return c.text("TTS unavailable", 502);
  }
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
