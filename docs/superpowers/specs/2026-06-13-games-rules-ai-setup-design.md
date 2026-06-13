# games-games-games — Setup & Tooling Design

- **Date:** 2026-06-13
- **Status:** Accepted
- **Scope:** Repository setup & tooling only (see "Out of scope")

## Goal

Stand up a Cloudflare-native **RAG-over-rulebooks** app and make this a first-class
AI-driven-development repository. A user uploads or selects a tabletop game's rulebook;
the document is chunked, embedded, and indexed; a chat agent answers rules questions
grounded in that content with citations.

This document codifies the validated decisions. It is a foundation, not the whole product.

## Scope

**In scope (this pass):**

- A repo that boots: `pnpm dev` serves the SPA and runs the agent locally.
- An agent (`RulesAgent`) that streams a chat reply.
- Every Cloudflare binding wired: Durable Object, R2, Vectorize, D1, Workers AI.
- The D1 metadata schema (`games`, `documents`, `chunks`) as a migration.
- The RAG pipeline as **typed seams with TODOs** — interfaces, not implementations.
- Dev tooling: TypeScript, Biome, Vitest (+ one smoke test), Wrangler.
- AI-dev tooling: `CLAUDE.md` (Karpathy rules + conventions), the `grill-with-docs`
  skill, `CONTEXT.md` glossary, `docs/adr/` with seed ADRs.
- Infrastructure: the R2/D1/Vectorize resources are added to the central Terraform repo
  (`../jasonm4130-cf`); a provisioning script wires the D1 id and applies the migration.

**Out of scope (later feature phases):**

- PDF parsing, chunking, and the embed→upsert ingestion implementation.
- Retrieval-augmented answer wiring (the agent calling Vectorize + citing).
- File-upload UI and auth.
- CI/CD, production deploy, observability dashboards.
- Tests beyond a smoke test.

## Architecture

**Decision: single Worker, single package (option A).** One deployable serves the
Vite/React SPA as static assets *and* runs the agent + API in the same Worker fetch
handler. This is what the official `cloudflare/agents-starter` ships in 2026 — it is the
grain of the platform and gives the simplest dev loop (`vite dev` runs everything via
`@cloudflare/vite-plugin`; there is no separate `wrangler dev`).

Options considered:

- **A. Single Worker, single package (chosen)** — simplest, canonical, agent + ingest
  API share the same bindings.
- **B. pnpm monorepo** (`packages/frontend` + `packages/worker`) — more separation, but
  the Vite plugin's cross-package worker wiring is fiddly and buys nothing here.
- **C. Pages frontend + separate Worker backend** — the legacy split; Cloudflare has
  moved off it for new apps.

Internal structure keeps units small and legible for humans and agents:

```
src/
  server/        Worker entry, the agent, and the RAG library
    index.ts     main module: exports RulesAgent + default fetch handler
    agent.ts     RulesAgent (AIChatAgent) — streams answers, owns the retrieval tool
    rag/         embed.ts · chunk.ts · retrieve.ts · ingest.ts  (seams, mostly TODO)
  client/        React SPA (main.tsx, App.tsx, styles.css)
  shared/        types shared across server + client (domain model)
```

## Stack (verified against npm + Cloudflare docs, 2026-06-13)

| Concern | Choice | Notes |
| --- | --- | --- |
| Backend runtime | Cloudflare Workers + **Agents SDK** `agents@^0.16` | exports `./react`, `./vite`, `./tsconfig`, `./schedule` |
| Chat agent | **`@cloudflare/ai-chat@^0.8`** | `AIChatAgent`; `useAgentChat` from `@cloudflare/ai-chat/react` |
| Agent client hook | `agents/react` | `useAgent` (note: split from `useAgentChat`) |
| LLM glue | `ai@^6` (Vercel AI SDK v6) + `workers-ai-provider@^3` | message shape is `parts[]`, not `content` |
| Frontend | React 19 + Vite 8 + `@cloudflare/vite-plugin@^1.40` | `vite dev` replaces `wrangler dev` |
| Lint + format | **Biome** `@biomejs/biome@^2` | single tool; pinned exact |
| Tests | Vitest + `@cloudflare/vitest-pool-workers@^0.16` | `cloudflareTest` API (the `/config` subpath is gone in 0.16) |
| Types | `wrangler types env.d.ts --include-runtime false` + `@cloudflare/workers-types` | runtime types from the package; bindings interface from wrangler |
| CLI | `wrangler@^4` | wrangler.jsonc is canonical |

## Bindings & resource ownership

| Resource | Binding | Owner | Why |
| --- | --- | --- | --- |
| Durable Object (the agent) | `RulesAgent` | **wrangler** | DO migrations (`new_sqlite_classes`) have no Terraform primitive |
| R2 bucket (rulebook PDFs) | `RULEBOOKS` | **central TF repo** (`cloudflare_r2_bucket`) | account-level; lives in `../jasonm4130-cf` |
| D1 database (metadata) | `DB` | **central TF repo** (`cloudflare_d1_database`) | TF creates the shell; schema via `wrangler d1 migrations` |
| Vectorize index (embeddings) | `RULES_IDX` | **central TF repo** (magodo/restful stopgap) | official provider has no native resource; managed via restful in `../jasonm4130-cf` |
| Workers AI | `AI` | neither | account-level; binding only |

`wrangler.jsonc` references the resources by name (R2, Vectorize) and id (D1). Ordering:
`make apply` in `../jasonm4130-cf` (creates R2 + D1 + Vectorize) → `scripts/provision.sh`
wires the D1 id → `wrangler d1 migrations apply --remote`. The
`assets.run_worker_first` list routes `/agents/*` and `/api/*` to the Worker; everything
else is served as static SPA assets with `not_found_handling: single-page-application`.

## Data model (D1 — `migrations/0001_init.sql`)

```
games(id, name, edition, created_at)
documents(id, game_id → games.id, r2_key, title, status, created_at)
chunks(id, document_id → documents.id, ordinal, text, vector_id, created_at)
```

Vectorize stores the embeddings keyed by `vector_id`; D1 holds metadata and the chunk
text used to render **Citations** back to the user.

## Embedding model — locked (immutable decision)

**`@cf/baai/bge-m3`, 1024 dimensions, cosine metric.** A Vectorize index's dimensions
and metric cannot change after creation, so this is recorded as ADR 0002. Decisive
reasons: bge-m3 has an **8,192-token context** (bge-base/large cap at 512 and silently
truncate — fatal for rulebook chunks with multi-step clauses and tables); it is the
**cheapest** embedding model in the catalog (~$0.012/M tokens); it is **multilingual**;
and **1024/cosine future-proofs** the index (matches bge-large and the newer
qwen3-embedding, both 1024/cosine), so the model can be swapped later without re-indexing.
No `pooling` parameter is needed (bge-m3 pools internally).

Text-generation model is **not** locked in (easy to change): default
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` behind a single config constant.

## What we scaffold vs. stub

- **Real:** the Worker entry + routing, `RulesAgent` streaming a reply via
  `workers-ai-provider`, the D1 migration, all bindings, the full tooling and AI-dev
  tooling, the `ggg_*` resource additions to the central Terraform repo + the
  provisioning script.
- **Typed seams (TODO):** `rag/embed.ts` (call `@cf/baai/bge-m3`), `rag/chunk.ts`
  (split rulebook text), `rag/retrieve.ts` (query Vectorize), `rag/ingest.ts`
  (parse → chunk → embed → upsert). Each has a clear signature and a `// TODO(rag):`
  marker so the feature phase is a fill-in, not a redesign.

## AI-dev tooling

- `.claude/skills/grill-with-docs/` — `SKILL.md` + `CONTEXT-FORMAT.md` + `ADR-FORMAT.md`,
  installed verbatim from mattpocock/skills.
- `CLAUDE.md` — Karpathy's four rules + verification-before-complete + plan-before-
  nontrivial, then project conventions: LSP-first navigation, Cloudflare doc-retrieval
  bias, verified stack gotchas, and the command cheatsheet.
- `CONTEXT.md` — seeded domain glossary (Game, Rulebook, Ruling, Citation, Chunk,
  Ingestion, Retrieval, Session).
- `docs/adr/` — 0001 single-Worker architecture, 0002 embedding/Vectorize, 0003
  Terraform/wrangler split.

## Provisioning workflow

Backing resources live in the central Terraform repo `../jasonm4130-cf` (ADR 0003):

1. `cd ../jasonm4130-cf && make plan && make apply` — creates the R2 bucket, D1 database,
   and Vectorize index (`ggg-rules-index`, 1024/cosine, via the magodo/restful stopgap).
2. `./scripts/provision.sh` (this repo) — resolves the D1 id, wires it into `wrangler.jsonc`,
   and runs `wrangler d1 migrations apply ggg-db --remote`.
3. `pnpm deploy`.

The central repo authenticates with an account-scoped `CLOUDFLARE_API_TOKEN` (R2 Edit,
D1 Edit, Vectorize Edit, Account Settings Read) via 1Password.

## Success criteria

- `pnpm install` clean.
- `pnpm types` regenerates `env.d.ts` with all five bindings.
- `pnpm check` (Biome + `tsc`) passes.
- `pnpm build` (Vite) produces a client bundle and bundles the Worker.
- `pnpm test` runs the smoke test green.
- The R2/D1/Vectorize additions in `../jasonm4130-cf` pass `terraform validate`.

## Implementation checklist

1. Spec + ADRs + CONTEXT.md. *(this doc)*
2. `grill-with-docs` skill files + `CLAUDE.md`.
3. Package + tooling config (package.json, tsconfig, wrangler.jsonc, vite.config.ts,
   biome.json, vitest.config.ts, index.html, .gitignore, .editorconfig, README).
4. `src/` (agent + RAG seams + client) + `migrations/0001_init.sql`.
5. Add R2/D1/Vectorize to the central repo `../jasonm4130-cf`; slim `scripts/provision.sh` to the app-side steps.
6. Install deps, generate types, verify (Biome, tsc, build, test), commit.
