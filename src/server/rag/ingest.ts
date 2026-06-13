export interface IngestInput {
  gameId: string;
  documentId: string;
  r2Key: string;
}

export interface IngestResult {
  chunks: number;
}

/**
 * Turn an uploaded Rulebook into indexed Chunks: fetch the file from R2
 * (env.RULEBOOKS), parse it to text, chunk it (chunkText), embed the chunks
 * (embed), upsert vectors to Vectorize (env.RULES_IDX), and record chunk rows in
 * D1 (env.DB).
 *
 * TODO(rag): implement the pipeline and advance documents.status as it runs
 * (pending -> ingesting -> ready | failed).
 */
export async function ingest(_env: Env, _input: IngestInput): Promise<IngestResult> {
  return { chunks: 0 };
}
