# games-games-games

A Cloudflare-native **RAG-over-rulebooks** app: upload a tabletop game's Rulebook → it is
chunked, embedded into Vectorize, and indexed → the `RulesAgent` answers rules questions
grounded in it, with Citations. Read [CONTEXT.md](./CONTEXT.md) for the domain language and
[docs/adr/](./docs/adr/) for the decisions that are hard to reverse.

## How to work here (Karpathy's 4 rules + voice)

1. **Think before coding (and before answering).** State assumptions. Ask only when
   guessing wrong is costly (irreversible action, lost work, wrong direction on multi-step
   work); otherwise state your interpretation and proceed. Ask at most one question — never
   a list.
2. **Simplicity first.** No features beyond what was asked. No abstractions for single-use
   code. If 200 lines could be 50, rewrite it. No filler prose, no flattery openers.
3. **Surgical changes.** Touch only what you must. Match existing style. Every changed line
   should trace to the request. Don't "improve" adjacent code.
4. **Goal-driven execution.** Define the success criterion, loop until verified. Turn "fix
   the bug" into "write a test that reproduces it, then make it pass." Hold positions under
   pushback unless given new evidence or domain context.

When brevity and thoroughness conflict, **accuracy wins.**

## Plan before non-trivial work

For changes that take more than one sentence to describe, produce a plan first
(EnterPlanMode). Skip it only for trivial single-step edits.

## Verification before claiming complete

Before saying work is done: run `pnpm check` / `pnpm test` / `pnpm build`, read the actual
output, and quote a specific success line. "Looks good" without verification is a fail. If
a step can't run in the current environment, say so — don't imply success.

## Code navigation

Prefer LSP (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`) over grepping
for symbols. Use grep for text: TODOs, string literals, config values, log messages.

## Cloudflare: retrieve, don't recall

This stack moves fast and your training data is stale. **Before writing Cloudflare code,
retrieve current docs** — use the `cloudflare`, `agents-sdk`, `durable-objects`, or
`wrangler` skills, or `search_cloudflare_documentation`. Verify package names and config
shapes against docs, not memory.

## Stack (verified 2026-06-13) — gotchas that bite

- **Agent class** `AIChatAgent` is imported from **`@cloudflare/ai-chat`** (a separate
  package), not from `agents`. `routeAgentRequest` is from `agents`.
- **React hooks are split:** `useAgent` from `agents/react`; `useAgentChat` from
  `@cloudflare/ai-chat/react`.
- **Agent route name is kebab-case.** `routeAgentRequest` matches the agent in the URL as the
  kebab-cased DO class name (`RulesAgent` → `/agents/rules-agent/:id`), and
  `useAgent({ agent })` must pass that same kebab string (`"rules-agent"`). PascalCase can
  silently fail to connect.
- **`onChatMessage`'s first param is a no-op callback** — message persistence is automatic via
  `toUIMessageStreamResponse()`. Keep the second `options?` param (it carries `abortSignal`).
- **AI SDK v6 message shape is `parts[]`**, not `content`. `sendMessage({ role, parts })`.
- **Durable Object migration uses `new_sqlite_classes`** (NOT `new_classes`) — the legacy
  key breaks Agents SDK SQLite state.
- **`nodejs_compat`** compatibility flag is required.
- **Dev loop is `vite dev`, not `wrangler dev`** — `@cloudflare/vite-plugin` runs the
  Worker in workerd with HMR.
- **Vectorize has no local simulation.** The index dims/metric are **immutable** (we use
  `@cf/baai/bge-m3`, 1024, cosine — see ADR 0002). `remote: true` on the binding routes
  local dev to the deployed index. The official TF provider has no native Vectorize
  resource, so the central infra repo manages it via the magodo/restful stopgap (ADR 0003).
- **Workers AI always hits the network** — billed even during `vite dev`.
- After editing `wrangler.jsonc`, run **`pnpm types`** to regenerate `env.d.ts`.

## Provisioning (central infra repo + wrangler, see ADR 0003)

The R2 bucket, D1 database, and Vectorize index are owned by the **central Cloudflare
Terraform repo `../jasonm4130-cf`** (Vectorize via the magodo/restful stopgap). This repo
owns only the Worker + Durable Object + bindings. Provision in two steps: `make apply` in
the central repo creates the resources, then `scripts/provision.sh` here wires the D1 id
into `wrangler.jsonc` and applies the D1 migration. Do **not** add a local `terraform/`
dir — account-level resources live in the central repo.

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | `vite dev` — SPA + Worker + agent locally with HMR |
| `pnpm build` | Vite build (client bundle + Worker) |
| `pnpm deploy` | `vite build && wrangler deploy` |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` |
| `pnpm check` | Biome + `tsc` (lint, format-check, typecheck) |
| `pnpm test` | Vitest (Workers pool) |
| `pnpm ingest` | operator ingestion — index a rulebook's markdown (`--md-path`, ADR 0008) |
| `pnpm eval` | retrieval (+ optional `--gen`) eval against a gold set |
| `pnpm gen-gold` | draft gold-set questions for a game |
| `pnpm inject-eval` | prompt-injection eval (LLM-judged) |
| `scripts/provision.sh` | App-side: wire D1 id + apply D1 migration (resources come from `../jasonm4130-cf`) |

## The grill-with-docs skill

`.claude/skills/grill-with-docs/` stress-tests a plan against `CONTEXT.md` and the ADRs,
sharpens terminology, and updates docs inline. Use it when stress-testing a design. Keep
`CONTEXT.md` a glossary only — no implementation detail. Add an ADR only when a decision is
hard to reverse **and** surprising **and** the result of a real trade-off.
