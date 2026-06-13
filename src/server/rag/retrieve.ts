import type { RetrievedChunk } from "../../shared/types";

export interface RetrieveOptions {
  /**
   * The active Game to scope retrieval to (ADR 0004). Vectors carry `game_id` metadata at
   * upsert, so this becomes a Vectorize metadata filter. REQUIRED in practice: with no
   * active Game there is nothing to search, so retrieve returns [].
   */
  gameId?: string;
  topK?: number;
}

/**
 * Retrieve the Chunks most relevant to a question, scoped to one Game.
 *
 * TODO(rag): implement, using the constants in ./models —
 *   if (!opts.gameId) return [];                       // no active Game → nothing to search
 *   const [vector] = await embed(env.AI, [question]);  // bge-m3, no query prefix needed
 *   const matches = await env.RULES_IDX.query(vector, {
 *     topK: opts.topK ?? RETRIEVAL_TOP_K,
 *     filter: { game_id: opts.gameId },                // per-Game scoping (ADR 0004)
 *     returnMetadata: "all",
 *   });
 *   keep matches with score >= RETRIEVAL_MIN_SCORE;     // grounding floor — drop weak hits
 *   hydrate chunk text + pages from env.DB by joining match.id = chunks.id (id IS vector_id).
 */
export async function retrieve(
  _env: Env,
  _question: string,
  _opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  return [];
}
