---
status: accepted
---

# Ingestion runs as an operator-side Node script, not a Worker route

The Catalogue is **operator-onboarded** — there is no end-user upload (see CONTEXT.md).
Onboarding a Game runs Ingestion as an **operator-side Node/TypeScript script**
(`tools/operator-scripts/ingest.ts`), not a Worker fetch handler. The script parses + chunks the PDF
locally in Node, then calls the Workers AI and Vectorize **REST APIs** with an account token
to embed and upsert; it writes chunk rows to D1. The Worker keeps only query-time retrieval
and chat.

> **Update (superseded in part by [ADR 0008](./0008-pdf-to-markdown-conversion.md)):** the
> PDF-extraction mechanism described below no longer applies — `tools/operator-scripts/ingest.ts` now ingests
> pre-converted **markdown** (`--md-path`) via `chunkMarkdown`, not PDF text via pdfjs. The decision
> that ingestion runs as an operator-side script (everything else here) still stands.

**Why this is an ADR:** it is surprising in a Cloudflare-native app (you would expect
ingestion *in* the Worker), it is the result of a real trade-off against in-platform options,
and moving it in-platform later is non-trivial work — worth recording the reasoning.

**Why a script, not in the Worker:**

- A Worker (and a Durable Object) caps at **128 MB memory / ~30 s CPU**. A 20–80 MB rulebook
  PDF, parsed and run through hundreds of embed calls, blows both. There is no end-user
  waiting on a request, so latency is irrelevant — an operator can run a CLI step.
- Node (plus Python for the offline PDF→markdown conversion, ADR 0008) gives the full
  document-parsing ecosystem and no memory ceiling. Doing that conversion inside workerd would
  need a wasm/pure-JS parser that fits 128 MB.
- Avoids standing up a Queue (a new account-level resource in the central Terraform repo) or
  a Durable Object alarm loop purely to dodge the request lifetime.

**Rejected:** a synchronous Worker upload handler (dies on large PDFs); a Queue consumer or
DO-alarm batch job (Cloudflare-native with retries, but adds infra and a PDF parser that fits
128 MB — not worth it for a small, curated, operator-driven Catalogue).

**Consequences:**

- `tools/operator-scripts/ingest.ts` owns the full pipeline orchestration; the chunking helper (`chunk.ts`) is
  pure/Node-compatible and shared with the Worker, while embedding uses the Workers AI REST API
  directly (`embed.ts` is Worker-binding-only — there is no Node equivalent of the `Ai` binding).
  Shared wrangler/D1/auth plumbing lives in `tools/operator-scripts/lib/wrangler.ts`.
- Ingestion is idempotent: re-onboarding a Document deletes its existing D1 chunks + Vectorize
  vectors (by the chunk ids captured from D1 — Vectorize has no delete-by-metadata, see ADR 0004)
  before re-inserting, so a re-run replaces that document's index.
- The operator needs an account API token with Workers AI + Vectorize write scope (the
  central repo already manages Cloudflare tokens via 1Password).
