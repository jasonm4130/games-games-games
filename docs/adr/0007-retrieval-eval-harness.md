---
status: accepted
---

# Retrieval eval via a secret-gated Worker endpoint

Date: 2026-06-14

Hybrid retrieval (GAP 1) added a lexical leg + RRF + a tunable `RRF_K`, but there was no way to
measure whether hybrid actually beats dense-only, or to judge a generation-model cutover
(llama-3.3-70b → gemma-4-26b-a4b-it). The eval needs to exercise the REAL pipeline — dense + lexical
legs, RRF fusion, the cross-encoder rerank, and the `RERANK_MIN_SCORE` gate — not a reimplementation.

**Why this is an ADR:** the chosen mechanism is a secret-gated PUBLIC Worker endpoint that reuses
`retrieve()`. That is a real trade-off (DRY/accuracy vs. attack surface) and mildly surprising (an
authenticated route that can spend generation credits outside the agent's daily-budget breaker), and
it is non-trivial to remove once operator tooling depends on it — it meets the bar.

**Decision:** Two operator-only routes, `POST /api/eval/retrieve` and `POST /api/eval/answer`, gated
by an `x-eval-secret` header matched against the `EVAL_SECRET` secret. When `EVAL_SECRET` is unset OR
the header mismatches they return **404, not 403**, so the surface is invisible unless explicitly
enabled. They are not rate-limited or budget-counted — the secret is the gate (an operator tool).

- `/api/eval/retrieve` returns the post-gate `final` ids+scores AND the pre-rerank fused
  `candidates` window, so Recall@20 is measured over what actually reached the reranker. A
  `mode: "dense" | "hybrid"` option on `RetrieveOptions` (default hybrid) skips the lexical leg for
  the dense baseline — the one production seam the eval needs, inert in prod.
- `/api/eval/answer` retrieves then generates with a `model` override (default `GENERATION_MODEL`),
  so the llama-vs-gemma compare never mutates the production default. `GEN_EVAL_MODELS` lists the
  compared models; the agent keeps llama-3.3-70b until a human switches it deliberately.
- `tools/operator-scripts/eval.ts` drives a gold set (`eval/gold/*.json`) and prints Hit-Rate@5 / Recall@20 /
  Precision@5 with a hybrid−dense delta; `--gen` adds the answer-quality compare (citation validity
  + token-overlap heuristic in `apps/worker/src/server/rag/eval-metrics.ts`). `tools/operator-scripts/gen-gold.ts` PROPOSES
  candidate gold Q&A (marked `_needsReview`) for the operator to curate.

**Rejected:** REST-replicating retrieval in the script (like `tools/operator-scripts/ingest.ts`) — `retrieve()`
depends on the AI + Vectorize bindings + the reranker, painful to reproduce faithfully in Node, and
the reimplementation would silently drift from production. Mutating `GENERATION_MODEL` for the gen
compare — would risk shipping the non-default model; an endpoint param keeps the default untouched.

**Consequences:**

- A new authenticated surface that can spend Workers AI credits (embedding + reranker on every
  retrieval eval; 2 model calls per question on `--gen`), outside the agent's daily breaker. The
  secret is the only guard — keep it high-entropy and unset in any environment that should not expose
  it. `/api/eval/retrieve` is zero-GENERATION-cost; `/api/eval/answer` is not.
- The endpoints only run meaningfully against the deployed Worker (Vectorize + AI are remote-only),
  so the harness targets prod by default (`--base-url`). The FTS5 path still cannot be unit-tested in
  the workers pool; the SQL + triggers are integration-tested by the operator after migration 0004.
- Reversible: delete the two routes + the `mode` seam + the two scripts; nothing in the agent or the
  production retrieval path changes.

## First eval run — results (2026-06-14)

Gold set: `eval/gold/catalogue.json` — 40 questions across all 8 Games (weighted to the larger
corpora: Catan 8, Quacks 6, Mistborn 6, Five Hundred 5, the rest 3–4), each `expectedChunkId`
verified to exist for the right Game against live D1.

**Retrieval — dense vs hybrid (40 Q):**

| Metric | dense | hybrid | Δ |
| --- | --- | --- | --- |
| Hit-Rate@5 | 92.5% | 95.0% | +2.5% |
| Recall@20 | 97.5% | 97.5% | +0.0% |
| Precision@5 | 18.5% | 19.0% | +0.5% |

Hybrid is ≥ dense on every metric, never worse — the lexical leg moves one borderline exact-term
answer into the top-5. Precision@5 sits at its ceiling (one relevant Chunk per question → max 20%, so
it just restates Hit-Rate). **Decision: keep hybrid; keep `RRF_K = 15`** — a sweep on 40
single-answer questions would be noise.

**Generation — Llama 3.3 70B vs Gemma 4 26B (`--gen`, 40 Q):**

| Model | answered | mean citation validity | mean token overlap |
| --- | --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 39/40 | 97.4% | 9.6% |
| `@cf/google/gemma-4-26b-a4b-it` | 22/40 | 81.8% | 6.2% |

Gemma 4 returns an empty completion (`success: true, response: null`) on ~45% of grounded prompts —
confirmed at the model level via direct Workers AI REST (bypassing the AI SDK + workers-ai-provider),
so it is not an integration artifact. **Decision: keep `GENERATION_MODEL = llama-3.3-70b`; do not cut
over to Gemma 4** despite its cheaper pricing / 256K context — it does not reliably produce grounded
answers on Workers AI today. Re-run this compare when Gemma's Workers AI deployment changes.
