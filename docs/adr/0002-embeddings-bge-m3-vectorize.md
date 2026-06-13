---
status: accepted
---

# Embeddings: `@cf/baai/bge-m3` at 1024 dimensions, cosine

The Vectorize index `RULES_IDX` uses **`@cf/baai/bge-m3`**, **1024 dimensions**,
**cosine** metric. Created in the central Terraform repo (`../jasonm4130-cf`) via the magodo/restful stopgap,
pinned to 1024 dimensions and the cosine metric (see ADR 0003). For reference only — not
the path used — the equivalent wrangler command would be:

```sh
wrangler vectorize create ggg-rules-index --dimensions=1024 --metric=cosine
```

**Why this is an ADR:** a Vectorize index's dimensions and metric are **immutable after
creation** — changing your mind means re-embedding and re-indexing every chunk. So the
choice is hard to reverse, and the reasons are worth recording.

**Why bge-m3 specifically:**

- **Cheapest in the Workers AI catalog** (~$0.012/M tokens; ~17× cheaper than bge-large) —
  the decisive factor.
- **Multilingual** (100+ languages) — board games are published internationally.
- **1024/cosine future-proofs the index:** it matches bge-large-en-v1.5 and the newer
  qwen3-embedding (also 1024/cosine), so the embedding model can be swapped later
  *without* a re-index. Going 768 to save space would lock out those upgrades.
- **8,192-token context is headroom, not a target.** An earlier version of this ADR claimed
  512-token chunks were "fatal" — that is wrong. BAAI *recommends* chunking bge-m3 at ~512
  tokens, and retrieval **degrades** with larger chunks (MRR@1 ~0.842 at 512 → ~0.739 at
  whole-document). The value of the long context is that our hard cap (1024 tokens; see
  `CHUNK_MAX_TOKENS` in `rag/models.ts`) sits comfortably inside it, so an occasional long
  numbered rule with multi-step sub-clauses embeds whole rather than being truncated — which
  `bge-base`/`bge-large` (512-token cap) would do. We chunk at ~512 target / 1024 cap.

No `pooling` parameter is set — bge-m3 pools internally (unlike bge-base/large, whose
`mean` vs `cls` pooling produce incompatible vector spaces). bge-m3 also needs **no
query/passage instruction prefix** — it dropped the asymmetry older BGE models had, so
queries and passages embed identically.

**Not locked:** the text-generation model. It is easy to reverse, lives behind one config
constant (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), and is not recorded here.
