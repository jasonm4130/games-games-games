export interface IngestInput {
  gameId: string;
  documentId: string;
  r2Key: string;
}

export interface IngestResult {
  chunks: number;
}

/**
 * Turn an onboarded Rulebook into indexed Chunks. This runs as an OPERATOR-SIDE Node script
 * (scripts/ingest.ts), NOT a Worker route (ADR 0005) — a Worker's 128 MB / 30 s ceiling
 * can't parse a large PDF. The script uses the Workers AI + Vectorize REST APIs with an
 * account token; this signature documents the pipeline contract.
 *
 * TODO(rag): implement the pipeline (idempotent — re-onboarding a Game replaces its index):
 *   1. delete existing chunks (D1) + vectors (Vectorize, by game_id+document_id) for a clean re-run
 *   2. fetch the file from R2 (env.RULEBOOKS) and parse with pdfjs-dist, capturing per-page text
 *   3. chunk structure-aware via @langchain/textsplitters + the bge-m3 tokenizer
 *      (CHUNK_TARGET_TOKENS / CHUNK_MAX_TOKENS / CHUNK_OVERLAP_TOKENS; tables atomic)
 *   4. optional `--contextual`: write a 1-line context blurb per chunk (Claude Haiku) -> context_blurb
 *   5. embed (prepend heading path + blurb to the embed text only) via Workers AI REST, batches <=100
 *   6. upsert to Vectorize with id = chunk id and metadata { game_id, document_id }
 *   7. insert chunk rows in D1 (text, page_start, page_end, context_blurb)
 *   8. advance documents.status pending -> ingesting -> ready|failed; set chunks_count + ingested_at
 */
export async function ingest(_env: Env, _input: IngestInput): Promise<IngestResult> {
  return { chunks: 0 };
}
