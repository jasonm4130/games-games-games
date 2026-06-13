# games-games-games

A Cloudflare-native **RAG-over-rulebooks** app. Upload a tabletop game's rulebook → it is
chunked, embedded into Vectorize, and indexed → the `RulesAgent` answers rules questions
grounded in it, with citations back to the source passages.

> **Status:** RAG pipeline implemented. Retrieval runs in the Worker (Game-scoped, grounded,
> cited); ingestion is an operator script (`pnpm ingest`). Build, typecheck, and unit tests are
> green; live end-to-end verification and calibration of the retrieval score floor are the
> remaining step.

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

## Onboarding a rulebook (operator ingestion)

Ingestion runs as an **operator-side Node script** ([ADR 0005](./docs/adr/0005-operator-script-ingestion.md))
— a Worker can't parse a large PDF within its 128 MB / 30 s limits. The script reads a PDF from
R2, extracts per-page text (`pdfjs-dist`), chunks it on bge-m3 token budgets, embeds it, and
writes vectors (Vectorize) + chunk rows (D1). Re-running for the same `--game` + `--r2-key`
replaces that document's chunks.

**One-time** — the Vectorize metadata indexes must exist *before* the first ingest (`game_id`
filtering only applies to vectors written after the index exists):

```sh
wrangler vectorize create-metadata-index ggg-rules-index --property-name=game_id --type=string
wrangler vectorize create-metadata-index ggg-rules-index --property-name=document_id --type=string
```

**Per rulebook:**

```sh
# 1. Upload the PDF to R2
wrangler r2 object put ggg-rulebooks/catan/base-5th.pdf --file ./base-5th.pdf --remote

# 2. Ingest it (everything rides your `wrangler login` — no Cloudflare token to export)
pnpm ingest --game "Catan" --edition "5th" --document "Base rules" \
  --r2-key catan/base-5th.pdf            # [--kind base|expansion|errata] [--contextual]
```

**Auth:** Everything rides your `wrangler login` session — no Cloudflare token to manage. R2, D1,
and Vectorize go through `wrangler` directly. Embedding is the one call `wrangler` can't run (it has
no AI-inference command), so it hits the Workers AI REST API — but the bearer and account id for it
are pulled from your session too (`wrangler auth token` + `wrangler whoami`), so there's still no
`CLOUDFLARE_AI_TOKEN` and no `CLOUDFLARE_ACCOUNT_ID` to set (the latter only if your login spans
multiple accounts). Every `wrangler` subprocess has `CLOUDFLARE_API_TOKEN` stripped so a stale shell
token can't shadow the login. The only key the script ever needs is `MOONSHOT_API_KEY`, and only
with `--contextual` (Contextual Retrieval — a one-line situating blurb per chunk via **Kimi k2.7**
on Moonshot, prepended at embed time only); without the flag, no key at all. Realtime answers stay
on Workers AI (Llama 3.3 70B); only this offline blurb step calls Moonshot.

Notes: only text-layer PDFs are supported (no OCR — a scanned PDF fails loudly). Vectors index
asynchronously, so allow a few seconds after ingest before querying. `documents.status`
advances `pending → ingesting → ready` (or `failed`).

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | SPA + Worker + agent locally with HMR |
| `pnpm build` | Vite build (client bundle + Worker) |
| `pnpm deploy` | `vite build && wrangler deploy` |
| `pnpm ingest` | operator ingestion — onboard a rulebook PDF (see above) |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` |
| `pnpm check` | Biome (lint + format) + `tsc` |
| `pnpm test` | Vitest (Workers pool) |

## Layout

```
src/
  server/        Worker entry, the agent, and the RAG library
    index.ts     main module — exports RulesAgent + the fetch handler
    agent.ts     RulesAgent (AIChatAgent)
    rag/         embed · chunk · retrieve · models  (query-time RAG, in the Worker)
  client/        React SPA
  shared/        types shared by server + client
migrations/      D1 schema
scripts/         provision.sh (D1 id + migration) · ingest.ts (operator ingestion)
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
