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
 * Generation models the EVAL HARNESS (GAP 2) measures answer quality across in --gen mode — NEVER
 * the production default. Each gold question runs through every model here, scored for citation
 * validity/attribution, faithfulness, and token overlap so a human can judge a model cutover.
 * Currently just the production model, so --gen is a single-model quality baseline of the live
 * answerer. GENERATION_MODEL above stays llama-3.3-70b until a human switches it deliberately; this
 * list never changes the agent.
 *
 * `@cf/google/gemma-4-26b-a4b-it` was removed 2026-06-27: it returned "out of scope" on all 42 gold
 * questions (the same passages llama answered), i.e. the id is dead on Workers AI — it only burned
 * cost and latency. To compare a cheaper cutover, add a VERIFIED current Workers AI text-gen id here.
 */
export const GEN_EVAL_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] as const;

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
// Drop markdown chunks whose body is shorter than this — Docling emits spurious headings over page
// furniture (page numbers "5 of 5", card labels "back", component counts, designer credits), which
// otherwise become near-empty chunks that pollute retrieval. Set below the shortest real rule line
// (~26 chars observed across the corpus) so genuine terse content is never dropped.
export const MIN_CHUNK_CHARS = 20;

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
 * Why this low (re-calibrated 2026-06-27, was 0.05, was 0.2 before that — full analysis in
 * docs/research/2026-06-27-rerank-abstention-calibration.md). A full-corpus probe (102 gold Qs / 9
 * games, `pnpm rerank-calibrate`) proved the reranker score CANNOT gate scope: genuine answer chunks
 * score as low as 0.0007 while irrelevant chunks reach 0.997 — the in-scope and out-of-scope
 * distributions overlap end to end, so NO cutoff separates them (§5). The real cost of the floor is
 * false-refusals: at 0.05 it was dropping the GOLD chunk on ~19% of answerable questions before the
 * LLM ever saw it (the meta-question refusals). An A/B (§9, `pnpm answerability-eval --baseline`)
 * confirmed the LLM judge refuses out-of-scope at 83.3% whether the floor is high or low — the floor
 * buys NO scope precision, only recall cost. So we set it as low as a pure garbage floor allows:
 * 0.01 sits just above clear noise (<= ~0.0025: "capital of France" 0.0006) and cuts the answerable
 * false-refusal rate ~19% -> ~10% (§5 sweep). Trade-off: a lower floor lets more out-of-scope reach
 * the generator (no longer free canned-refused), but the LLM still refuses it and the rate limiters
 * cap abuse; if generation cost on OOS bites, 0.025 is the more conservative setting.
 */
export const RERANK_MIN_SCORE = 0.01;

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
