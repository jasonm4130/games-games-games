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
 * grounding on weak passages (ADR 0004). Placeholder — calibrate against real recall data.
 */
export const RETRIEVAL_MIN_SCORE = 0.5;
export const RETRIEVAL_TOP_K = 5;
