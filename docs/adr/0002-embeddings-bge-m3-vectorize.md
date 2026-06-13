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

- **8,192-token context.** `bge-base`/`bge-large-en-v1.5` cap input at 512 tokens and
  silently truncate beyond it — fatal for rulebook chunks with multi-step exception
  clauses and tables.
- **Cheapest in the Workers AI catalog** (~$0.012/M tokens; ~17× cheaper than bge-large).
- **Multilingual** (100+ languages) — board games are published internationally.
- **1024/cosine future-proofs the index:** it matches bge-large-en-v1.5 and the newer
  qwen3-embedding (also 1024/cosine), so the embedding model can be swapped later
  *without* a re-index. Going 768 to save space would lock out those upgrades.

No `pooling` parameter is set — bge-m3 pools internally (unlike bge-base/large, whose
`mean` vs `cls` pooling produce incompatible vector spaces).

**Not locked:** the text-generation model. It is easy to reverse, lives behind one config
constant (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), and is not recorded here.
