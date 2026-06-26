import { EMBEDDING_MODEL } from "./models";

/**
 * Embed text with the project's embedding model (bge-m3, 1024-dim). bge-m3 pools
 * internally, so no `pooling` parameter is passed. Returns one vector per input.
 *
 * bge-m3 needs NO query/passage instruction prefix — it dropped the asymmetry older BGE
 * models had, so queries and passages embed identically (do not add a `mode` param).
 *
 * This binding-based path is for query-time Retrieval inside the Worker. Ingestion runs in
 * an operator-side Node script (ADR 0005) where there is no `Ai` binding — it calls the
 * Workers AI REST endpoint instead, batching <=100 texts per request.
 */
export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await ai.run(EMBEDDING_MODEL, { text: texts });
  return (result as { data: number[][] }).data;
}
