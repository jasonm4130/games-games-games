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
 * Permissive noise bound on the raw bge-m3 cosine score. Drop clear garbage cheaply before the
 * reranker, but DO NOT use cosine as the relevance judge - it ranks badly on this corpus. Probed
 * 2026-06-14 with "how do I get out of prison" against the live Monopoly index: the correct Jail
 * passage scored cosine 0.555 while an UNRELATED rent rule scored 0.583 (higher!). Cosine alone
 * mis-ranks; the cross-encoder (RERANK_MIN_SCORE) is the judge. Cross-game isolation is the
 * Vectorize game_id filter (retrieve.ts), not this floor - lowering it cannot reintroduce leakage.
 */
export const RETRIEVAL_MIN_SCORE = 0.15;

/**
 * In-scope gate on the cross-encoder relevance score (sigmoid-normalised to [0,1] by Workers AI).
 * After reranking, passages below this are dropped; if none clear it, Retrieval returns [] and the
 * agent gives its "not covered" reply. THIS, not the cosine floor, decides whether the rulebook
 * answers the question.
 *
 * Calibrated 2026-06-14 against the live Monopoly index with the synonym query "how do I get out of
 * prison": the Jail passage reranked to 0.841, every other candidate to <= 0.0004 - a clean gap.
 * 0.2 sits deep inside it, keeping strong + secondary matches while rejecting noise. (This query
 * previously hit the canned refusal: the old 0.55 cosine floor sat right on the Jail chunk's 0.555
 * score and the reranker was never used as a gate.)
 */
export const RERANK_MIN_SCORE = 0.2;

export const RETRIEVAL_TOP_K = 5;
/** Over-fetch count: how many Vectorize candidates to pull before the reranker narrows to RETRIEVAL_TOP_K. */
export const RETRIEVAL_FETCH_N = 20;

/**
 * Cross-encoder reranking model. Applied after the cosine floor to reorder surviving
 * candidates by actual passage relevance before slicing to RETRIEVAL_TOP_K.
 */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
