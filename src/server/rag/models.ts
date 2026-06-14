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
 * Generation models the EVAL HARNESS (GAP 2) compares answer quality across — NEVER the
 * production default. The eval's --gen mode runs each gold question through every model here and
 * scores citation validity + token overlap so the human can judge a cutover (e.g. gemma's larger
 * context + ~8x cheaper output). GENERATION_MODEL above stays llama-3.3-70b until a human switches
 * it deliberately; this list does not change the agent. gemma id/pricing verified 2026-06-14:
 * @cf/google/gemma-4-26b-a4b-it — 256k-token context, $0.10/M in + $0.30/M out (vs llama-3.3-70b's
 * 24k context, $0.29/$2.25).
 */
export const GEN_EVAL_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/google/gemma-4-26b-a4b-it",
] as const;

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
 * NOISE floor on the cross-encoder relevance score (sigmoid-normalised to [0,1] by Workers AI).
 * After reranking, passages below this are dropped; if none clear it, Retrieval returns [] and the
 * agent gives its canned "not covered" reply (no model call). This floor is NOT the relevance judge
 * — the LLM is (see prompt.ts "WHEN THE PASSAGES FALL SHORT"). Its only job is to keep obvious
 * garbage from reaching the model, while letting the genuinely-but-weakly-relevant through.
 *
 * Why low (re-calibrated 2026-06-14, was 0.2). The reranker is a good RANKER but an unreliable
 * ABSOLUTE judge, so no single cutoff separates in-scope from out-of-scope. Probed live on Monopoly:
 *   - genuine matches for awkward paraphrases score as LOW as ~0.10 ("how much money does each
 *     player start with" -> 0.110 rank #1; "how can a player escape jail" -> 0.102 rank #1), yet
 *   - genuinely-irrelevant chunks score as HIGH as ~0.99 (a Texas-Hold'em-poker question reranks a
 *     Monopoly chunk to 0.996; "how do I castle in chess" -> 0.456).
 * The old 0.2 cutoff dropped the 0.10–0.11 genuine matches (canned-refusing equivalent paraphrases
 * that should ground) while the 0.46/0.99 garbage sailed past it to the model anyway. So the cutoff
 * was doing the wrong job. We now set it to a NOISE floor of 0.05, which sits in the measured gap
 * between clear garbage (<= ~0.025: "capital of France" 0.0006, "best opening move in Go" 0.0225)
 * and genuine-weak matches (>= ~0.10). Verified end-to-end (real reranker + prompt + Llama 3.3 70B):
 * the awkward paraphrases now ground correctly, and out-of-scope/injection questions — including the
 * 0.46/0.99 cases that reach the model — still get the in-character "not in my rulebook" refusal.
 * Cross-game gold calibration: 39/40 genuine matches rerank >= 0.05 (identical to >= 0.2; natural
 * phrasings rerank ~0.99), so lowering costs no precision on well-phrased questions.
 */
export const RERANK_MIN_SCORE = 0.05;

export const RETRIEVAL_TOP_K = 5;
/** Over-fetch count: how many Vectorize candidates to pull before the reranker narrows to RETRIEVAL_TOP_K. */
export const RETRIEVAL_FETCH_N = 20;

/**
 * Reciprocal Rank Fusion damping constant. RRF scores a candidate as Σ 1/(RRF_K + rank) over the
 * dense + lexical (BM25) legs, fusing them before the reranker (GAP 1). The textbook k=60 was tuned
 * for TREC-scale lists of thousands; on this 30–80-chunk corpus it over-flattens — every rank's
 * 1/(60+rank) contribution collapses toward the same value, erasing the top-rank signal both legs
 * agree on. A smaller k keeps the head of each list dominant, which is what we want when the
 * reranker (not RRF) makes the final call. ~15 sits in the 10–20 band that preserves that signal.
 */
export const RRF_K = 15;

/**
 * Cross-encoder reranking model. Applied after the cosine floor to reorder surviving
 * candidates by actual passage relevance before slicing to RETRIEVAL_TOP_K.
 */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
