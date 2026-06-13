// Workers AI model ids used by the RAG pipeline.

/**
 * Embedding model. IMMUTABLE once the Vectorize index exists — the index's
 * dimensions/metric (1024, cosine) are fixed to this model. See docs/adr/0002.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Text-generation model used to synthesise Rulings. Easy to change — swap this
 * constant for any current Workers AI text-gen model.
 */
export const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Chunking budget, in bge-m3 tokens (not characters). Target ~512 (BAAI's own
 * recommendation — retrieval degrades with larger chunks), hard cap 1024 so a long
 * numbered rule with sub-clauses stays whole without nearing bge-m3's 8192 limit, leaving
 * headroom for the contextual blurb prefix. Tables may exceed the cap (kept atomic) up to
 * TABLE_MAX_TOKENS. See docs/adr/0002 and src/server/rag/chunk.ts.
 */
export const CHUNK_TARGET_TOKENS = 512;
export const CHUNK_MAX_TOKENS = 1024;
export const CHUNK_OVERLAP_TOKENS = 50;
export const TABLE_MAX_TOKENS = 1500;

/**
 * Cosine-similarity floor for retrieved Chunks. Matches below it are dropped; if none
 * survive, Retrieval returns [] and the agent gives its "not covered" answer instead of
 * grounding on weak passages (ADR 0004).
 *
 * Calibrated 2026-06-13 against the first live rulebook (Monopoly, bge-m3): in-scope top
 * matches scored 0.61–0.65 (relevant secondaries 0.55–0.57), an easy out-of-scope question
 * ~0.32, and the hard negative — another game's rules (chess) asked against this Game — topped
 * out at ~0.53. 0.55 rejects that cross-game leakage (the worst failure: answering confidently
 * from the wrong rulebook) while keeping in-scope hits, biasing toward "not covered" over a wrong
 * grounded answer. Small sample (one rulebook) — revisit as more Games are onboarded.
 */
export const RETRIEVAL_MIN_SCORE = 0.55;
export const RETRIEVAL_TOP_K = 5;
/** Over-fetch count: how many Vectorize candidates to pull before the reranker narrows to RETRIEVAL_TOP_K. */
export const RETRIEVAL_FETCH_N = 20;

/**
 * Cross-encoder reranking model. Applied after the cosine floor to reorder surviving
 * candidates by actual passage relevance before slicing to RETRIEVAL_TOP_K.
 */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
