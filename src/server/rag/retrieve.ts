import type { RetrievedChunk } from "../../shared/types";

/**
 * Retrieve the Chunks most relevant to a question.
 *
 * TODO(rag): implement —
 *   const [vector] = await embed(env.AI, [question]);
 *   const matches = await env.RULES_IDX.query(vector, { topK, returnMetadata: "all" });
 *   hydrate chunk text from env.DB by vector_id, map to RetrievedChunk[].
 */
export async function retrieve(_env: Env, _question: string, _topK = 5): Promise<RetrievedChunk[]> {
  return [];
}
