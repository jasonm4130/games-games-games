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

Resources are split between Terraform and Wrangler (see [ADR 0003](./docs/adr/0003-terraform-wrangler-provisioning-split.md)):

| Resource | Owner |
| --- | --- |
| R2 bucket, D1 database | **Terraform** (`terraform/`) |
| Vectorize index, Worker, Durable Object | **Wrangler** |
| Workers AI | account-level (binding only) |

One command provisions both halves:

```sh
export CLOUDFLARE_API_TOKEN=...   # account-scoped: R2 Edit, D1 Edit, Vectorize Edit, Workers Scripts Edit, Account Settings Read
export TF_VAR_account_id=...      # your Cloudflare account id
./scripts/provision.sh
```

It runs `terraform apply` (creates R2 + D1), `wrangler vectorize create`, and
`wrangler d1 migrations apply`, then prints the D1 `database_id` to paste into
`wrangler.jsonc`. Deploy with `pnpm deploy`.

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
terraform/       R2 + D1 provisioning
scripts/         provision.sh
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
