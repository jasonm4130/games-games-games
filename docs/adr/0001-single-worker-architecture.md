---
status: accepted
---

# Single Worker serves the SPA, the agent, and the API

The React (Vite) frontend, the `RulesAgent` chat agent, and the upload/ingest API all
live in **one Cloudflare Worker / one package**, not a monorepo and not a Pages-plus-Worker
split. The Worker serves the built SPA as static assets (`assets` binding,
`not_found_handling: single-page-application`) and handles `/agents/*` and `/api/*` in the
same fetch handler via `run_worker_first`.

**Why:** this is the pattern the official `cloudflare/agents-starter` ships, and
`@cloudflare/vite-plugin` makes `vite dev` run the Worker (in workerd) and the SPA together
with HMR — no separate `wrangler dev`. The agent and the ingest API want the same bindings
(R2, Vectorize, D1, AI), so co-locating them avoids cross-package plumbing.

**Rejected:** a pnpm monorepo (cross-package Vite↔Worker wiring is fiddly and buys nothing
here) and a Pages frontend + separate backend Worker (the legacy split Cloudflare has moved
away from for new apps).
