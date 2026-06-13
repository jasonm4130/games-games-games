import { eq, inArray } from "drizzle-orm";
import type { RetrievedChunk } from "../../shared/types";
import { db } from "../db";
import { chunks, documents, games } from "../db/schema";
import { embed } from "./embed";
import { RERANK_MIN_SCORE, RERANK_MODEL, RETRIEVAL_FETCH_N, RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K } from "./models";

export interface RetrieveOptions {
  /**
   * The active Game to scope retrieval to (ADR 0004). Vectors carry `game_id` metadata at
   * upsert, so this becomes a Vectorize metadata filter. With no active Game there is nothing
   * to search, so retrieve returns [].
   */
  gameId?: string;
  topK?: number;
}

/**
 * Retrieve the Chunks most relevant to a question, scoped to one Game. Embeds the question
 * (bge-m3, no query prefix), queries Vectorize filtered by `game_id` (over-fetching RETRIEVAL_FETCH_N
 * candidates), drops matches below the cosine grounding floor (the in-scope gate — ADR 0004), hydrates
 * text + page span + Game name from D1, then reranks survivors with bge-reranker-base and returns the
 * top RETRIEVAL_TOP_K in reranker order. `.score` on each result stays the original cosine score.
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
    topK: opts.topK ?? RETRIEVAL_FETCH_N,
    returnMetadata: "none",
    filter: { game_id: opts.gameId },
  });

  // Noise bound: drop obviously-unrelated candidates cheaply before the reranker. This is a
  // permissive floor, NOT the relevance judge — the cross-encoder below decides what grounds a
  // Ruling. (Cross-game isolation is the game_id filter above, not this floor.)
  const hits = result.matches.filter((match) => match.score >= RETRIEVAL_MIN_SCORE);
  if (hits.length === 0) return [];

  const ids = hits.map((match) => match.id);
  const rows = await db(env)
    .select({
      id: chunks.id,
      documentId: chunks.documentId,
      ordinal: chunks.ordinal,
      text: chunks.text,
      pageStart: chunks.pageStart,
      pageEnd: chunks.pageEnd,
      gameName: games.name,
      documentTitle: documents.title,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .innerJoin(games, eq(games.id, documents.gameId))
    .where(inArray(chunks.id, ids));

  const byId = new Map(rows.map((row) => [row.id, row]));

  // Build ordered survivors (preserving Vectorize score order; skip any match missing its D1 row).
  const survivors: RetrievedChunk[] = hits.flatMap((match) => {
    const row = byId.get(match.id);
    if (!row) return [];
    return [
      {
        chunk: {
          id: row.id,
          documentId: row.documentId,
          ordinal: row.ordinal,
          text: row.text,
          pageStart: row.pageStart,
          pageEnd: row.pageEnd,
        },
        gameName: row.gameName,
        documentTitle: row.documentTitle,
        score: match.score, // cosine score — preserved in final output for Citation display
      },
    ];
  });

  if (survivors.length === 0) return [];

  // Rerank with a cross-encoder and gate on its relevance score. The reranker judges the
  // (query, passage) pair together, so it handles synonyms/paraphrase the embedding floor can't.
  // It returns results best-first; keep those at/above RERANK_MIN_SCORE.
  //
  // The generated type for bge-reranker-base omits `query` and marks output fields optional;
  // cast through unknown so tsc accepts the correct runtime shape.
  const reranked = (await (
    env.AI.run as (m: string, i: Record<string, unknown>) => Promise<unknown>
  )(RERANK_MODEL, {
    query,
    contexts: survivors.map((c) => ({ text: c.chunk.text })),
    top_k: Math.min(RETRIEVAL_TOP_K, survivors.length),
  })) as { response: { id: number; score: number }[] };

  return reranked.response
    .filter(({ score }) => score >= RERANK_MIN_SCORE)
    .flatMap(({ id }) => {
      const chunk = survivors[id];
      return chunk ? [chunk] : [];
    });
}
