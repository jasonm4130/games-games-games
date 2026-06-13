import { routeAgentRequest } from "agents";

// The DurableObject class must be a named export of the Worker's main module.
export { RulesAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // Ingestion is NOT a Worker route — it runs as an operator-side Node script
    // (scripts/ingest.ts, see ADR 0005). The Worker only serves the SPA, the agent, and
    // query-time endpoints.

    // Per-IP guardrail on agent traffic (connections + messages all hit /agents/*). Keyed by
    // the client IP so one abuser can't exhaust the global budget; checked before the agent
    // is even routed. Per-colo, so it caps bursts, not a daily total (that's the D1 breaker).
    if (url.pathname.startsWith("/agents/")) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.IP_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
    }

    // routeAgentRequest matches the agent name in the URL as kebab-case ("rules-agent"),
    // derived from the RulesAgent DO class; the client's useAgent({ agent }) must pass the
    // same kebab string. Routes /agents/rules-agent/:session to the RulesAgent DO.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
