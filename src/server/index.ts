import { routeAgentRequest } from "agents";

// The DurableObject class must be a named export of the Worker's main module.
export { RulesAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // TODO(rag): POST /api/games/:id/rulebooks — store the upload in R2
    // (env.RULEBOOKS) and call ingest(env, { gameId, documentId, r2Key }).

    // Routes /agents/rules-agent/:session to the RulesAgent Durable Object.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
