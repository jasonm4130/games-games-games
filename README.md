# games-games-games

A Cloudflare-native **RAG-over-rulebooks** app. Upload a tabletop game's rulebook → it is
chunked, embedded into Vectorize, and indexed → the `RulesAgent` answers rules questions
grounded in it, with citations back to the source passages.

> **Status:** setup & tooling scaffold. The app boots, the agent streams replies, and every
> binding is wired. The RAG ingestion/retrieval pipeline exists as typed seams (`src/server/rag/`)
> marked `// TODO(rag):` — that's the next feature phase.

## Stack

- **Runtime / backend:** Cloudflare Workers + the [Agents SDK](https://developers.cloudflare.com/agents/) (`agents`, `@cloudflare/ai-chat`)
- **Frontend:** React 19 + Vite 8, served from the same Worker via `@cloudflare/vite-plugin`
- **LLM:** Workers AI via the Vercel AI SDK v6 (`ai` + `workers-ai-provider`)
- **Storage:** R2 (rulebooks) · Vectorize (embeddings) · D1 (metadata) · Workers AI
- **Tooling:** TypeScript · Biome · Vitest (Workers pool) · Wrangler · Terraform

## Quickstart (local)

```sh
pnpm install
pnpm types        # generate env.d.ts from wrangler.jsonc
pnpm dev          # vite dev — SPA + Worker + agent with HMR
```

`pnpm dev` runs the Worker in the real Workers runtime locally. Note: Workers AI and
Vectorize have **no local simulation** (`remote: true`), so those calls hit your Cloudflare
account and require `wrangler login` (and incur usage). The chat UI loads without them.

## Provisioning the cloud resources

The R2 bucket, D1 database, and Vectorize index are owned by the central Cloudflare
Terraform repo (`../jasonm4130-cf`); this repo owns only the Worker + Durable Object +
bindings (see [ADR 0003](./docs/adr/0003-terraform-wrangler-provisioning-split.md)):

| Resource | Owner |
| --- | --- |
| R2 bucket, D1 database, Vectorize index | **central Terraform repo** (`../jasonm4130-cf`) |
| Worker, Durable Object, bindings | **Wrangler** (this repo) |
| Workers AI | account-level (binding only) |

Provision in two steps:

```sh
# 1. Create the backing resources (central repo)
cd ../jasonm4130-cf && make plan && make apply

# 2. Wire the D1 id into wrangler.jsonc and apply the schema (this repo)
./scripts/provision.sh
```

Then deploy with `pnpm deploy`.

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | SPA + Worker + agent locally with HMR |
| `pnpm build` | Vite build (client bundle + Worker) |
| `pnpm deploy` | `vite build && wrangler deploy` |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` |
| `pnpm check` | Biome (lint + format) + `tsc` |
| `pnpm test` | Vitest (Workers pool) |

## Layout

```
src/
  server/        Worker entry, the agent, and the RAG library
    index.ts     main module — exports RulesAgent + the fetch handler
    agent.ts     RulesAgent (AIChatAgent)
    rag/         embed · chunk · retrieve · ingest  (typed seams, TODO)
  client/        React SPA
  shared/        types shared by server + client
migrations/      D1 schema
scripts/         provision.sh (app-side: D1 id + migration)
docs/
  adr/           architecture decision records
  superpowers/   design specs
CONTEXT.md       domain glossary
CLAUDE.md        how AI agents should work in this repo
```

## For AI agents working here

Read [CLAUDE.md](./CLAUDE.md) first — it has the working rules and the verified
Cloudflare-stack gotchas. [CONTEXT.md](./CONTEXT.md) is the domain glossary; the
`.claude/skills/grill-with-docs/` skill stress-tests plans against it and the ADRs.
