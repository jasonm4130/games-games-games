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

    // routeAgentRequest matches the agent name in the URL as kebab-case ("rules-agent"),
    // derived from the RulesAgent DO class; the client's useAgent({ agent }) must pass the
    // same kebab string. Routes /agents/rules-agent/:session to the RulesAgent DO.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
