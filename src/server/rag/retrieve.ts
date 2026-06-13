import type { RetrievedChunk } from "../../shared/types";
import { embed } from "./embed";
import { RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K } from "./models";

export interface RetrieveOptions {
  /**
   * The active Game to scope retrieval to (ADR 0004). Vectors carry `game_id` metadata at
   * upsert, so this becomes a Vectorize metadata filter. With no active Game there is nothing
   * to search, so retrieve returns [].
   */
  gameId?: string;
  topK?: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  page_start: number | null;
  page_end: number | null;
  game_name: string;
}

/**
 * Retrieve the Chunks most relevant to a question, scoped to one Game. Embeds the question
 * (bge-m3, no query prefix), queries Vectorize filtered by `game_id`, drops matches below the
 * grounding floor, then hydrates text + page span + Game name from D1 by joining
 * `match.id = chunks.id` (the chunk id IS the vector id — ADR 0004). Score order is preserved.
 */
export async function retrieve(
  env: Env,
  question: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const query = question.trim();
  if (!opts.gameId || !query) return [];

  const [vector] = await embed(env.AI, [query]);
  if (!vector) return [];

  const result = await env.RULES_IDX.query(vector, {
    topK: opts.topK ?? RETRIEVAL_TOP_K,
    returnMetadata: "none",
    filter: { game_id: opts.gameId },
  });

  // Grounding floor: weak matches don't get to ground a Ruling (ADR 0004).
  const hits = result.matches.filter((match) => match.score >= RETRIEVAL_MIN_SCORE);
  if (hits.length === 0) return [];

  const ids = hits.map((match) => match.id);
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.document_id, c.ordinal, c.text, c.page_start, c.page_end, g.name AS game_name
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN games g ON g.id = d.game_id
     WHERE c.id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<ChunkRow>();

  const byId = new Map(results.map((row) => [row.id, row]));

  // Preserve Vectorize score order; skip any match missing its D1 row.
  return hits.flatMap((match) => {
    const row = byId.get(match.id);
    if (!row) return [];
    return [
      {
        chunk: {
          id: row.id,
          documentId: row.document_id,
          ordinal: row.ordinal,
          text: row.text,
          pageStart: row.page_start,
          pageEnd: row.page_end,
        },
        gameName: row.game_name,
        score: match.score,
      },
    ];
  });
}
