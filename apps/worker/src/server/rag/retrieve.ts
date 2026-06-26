import { eq, inArray, sql } from "drizzle-orm";
import type { RetrievedChunk } from "../../shared/types";
import { db } from "../db";
import { chunks, documents, games } from "../db/schema";
import { reciprocalRankFusion, sanitizeFtsQuery } from "./context";
import { embed } from "./embed";
import {
  RERANK_MIN_SCORE,
  RERANK_MODEL,
  RETRIEVAL_FETCH_N,
  RETRIEVAL_MIN_SCORE,
  RETRIEVAL_TOP_K,
  RRF_K,
} from "./models";

export interface RetrieveOptions {
  /**
   * The active Game to scope retrieval to (ADR 0004). Vectors carry `game_id` metadata at
   * upsert, so this becomes a Vectorize metadata filter. With no active Game there is nothing
   * to search, so retrieve returns [].
   */
  gameId?: string;
  /**
   * Retrieval mode (GAP 2 eval seam, default "hybrid"). "hybrid" runs both the dense ANN leg and
   * the lexical BM25 leg and fuses them; "dense" skips the lexical leg for a pure-dense baseline so
   * the eval can measure the dense-vs-hybrid delta. Inert in production (the agent never sets it, so
   * it defaults to hybrid).
   */
  mode?: "dense" | "hybrid";
}

/**
 * Lexical leg (GAP 1): rank chunk ids by BM25 over the FTS5 mirror `chunks_fts`, scoped to the
 * active Game via the documents join (the second of the two Game-scoped legs — the dense leg is
 * scoped by the Vectorize game_id filter). bm25() is ascending (best = most negative), so ORDER BY
 * bm25 ASC is best-first. Returns ids best-first, capped at RETRIEVAL_FETCH_N. The whole call is
 * wrapped so any MATCH-syntax/binding error (or a missing chunks_fts table before migration 0004)
 * degrades to dense-only — it returns [] and never throws.
 */
async function lexicalSearch(env: Env, query: string, gameId: string): Promise<string[]> {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  try {
    const rows = await db(env).all<{ id: string }>(sql`
      SELECT f.chunk_id AS id
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ${match} AND d.game_id = ${gameId}
      ORDER BY bm25(chunks_fts)
      LIMIT ${RETRIEVAL_FETCH_N}
    `);
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * The fused candidate window that reaches the reranker: the dense ANN leg + the lexical BM25 leg
 * (skipped in "dense" mode), floored, fused by RRF, sliced to RETRIEVAL_FETCH_N. `ids` are in fused
 * order; `cosineById` carries each dense hit's cosine score (lexical-only hits are absent → scored 0
 * downstream). Extracted (GAP 2) so the eval endpoint can report Recall@20 over this window without
 * a generation call; retrieveDetailed calls it and then hydrates + reranks. Returns [] ids when
 * nothing survives both legs, so retrieve's out-of-scope refusal still fires.
 */
async function retrieveCandidates(
  env: Env,
  question: string,
  opts: RetrieveOptions = {},
): Promise<{ ids: string[]; cosineById: Map<string, number> }> {
  const query = question.trim();
  if (!opts.gameId || !query) return { ids: [], cosineById: new Map() };
  const gameId = opts.gameId;

  const [vector] = await embed(env.AI, [query]);
  if (!vector) return { ids: [], cosineById: new Map() };

  // Run the dense ANN leg and the lexical BM25 leg in parallel. Both are Game-scoped (the dense leg
  // by the Vectorize game_id filter, the lexical leg by its documents join). The lexical leg never
  // throws (it degrades to []), so the dense leg alone always carries the pipeline. In "dense" mode
  // (the eval baseline) the lexical leg is skipped entirely for a pure-dense ranking.
  const [result, ftsIds] = await Promise.all([
    env.RULES_IDX.query(vector, {
      topK: RETRIEVAL_FETCH_N,
      returnMetadata: "none",
      filter: { game_id: gameId },
    }),
    opts.mode === "dense" ? Promise.resolve<string[]>([]) : lexicalSearch(env, query, gameId),
  ]);

  // Noise bound on the dense leg: drop obviously-unrelated candidates cheaply before fusion. This
  // is a permissive floor, NOT the relevance judge — the cross-encoder below decides what grounds a
  // Ruling. (Cross-game isolation is the game_id filter above, not this floor.) Cosine scores are
  // kept so the final result can carry them for Citation display.
  const denseHits = result.matches.filter((match) => match.score >= RETRIEVAL_MIN_SCORE);
  const cosineById = new Map(denseHits.map((match) => [match.id, match.score]));
  const denseIds = denseHits.map((match) => match.id);

  // Fuse the two ranked id-lists with RRF before the reranker — a passage strong in either leg
  // surfaces. With an empty lexical leg this is pure dense order; with both legs empty it is [], so
  // retrieve returns [] and the agent's free out-of-scope refusal fires.
  const ids = reciprocalRankFusion([denseIds, ftsIds], RRF_K).slice(0, RETRIEVAL_FETCH_N);
  return { ids, cosineById };
}

/**
 * Retrieve the Chunks most relevant to a question, scoped to one Game, AND the fused candidate
 * window they were selected from. Builds the fused candidate window (retrieveCandidates: dense ANN +
 * lexical BM25 legs, floored + RRF-fused, GAP 1), hydrates those (text + page span + Game name) from
 * D1, reranks with bge-reranker-base, and keeps those at/above RERANK_MIN_SCORE — the in-scope gate
 * (ADR 0004) — in reranker order, PLUS the RRF-consensus top candidate (see the rescue note below the
 * rerank). Returns `{ passages, candidateIds }`: `passages` is empty (so the agent's free out-of-scope
 * refusal still fires) only when retrieval surfaced NO candidates at all; once there is a fused
 * window, its consensus-#1 chunk is always kept so the LLM — not the reranker's absolute score — makes
 * the in/out-of-scope call. `candidateIds` is the pre-rerank fused window in fused order (for the
 * eval's Recall@20). `.score` on each passage is the cosine score (0 for a lexical-only hit, which had
 * no dense score), for Citation display.
 *
 * The eval's /api/eval/retrieve calls THIS once so it gets both the post-rerank `final` and the
 * pre-rerank `candidates` from a single embed + Vectorize query, instead of running retrieve() and
 * retrieveCandidates() side by side (which would embed + query twice for the same input).
 */
export async function retrieveDetailed(
  env: Env,
  question: string,
  opts: RetrieveOptions = {},
): Promise<{ passages: RetrievedChunk[]; candidateIds: string[] }> {
  const query = question.trim();
  const { ids, cosineById } = await retrieveCandidates(env, query, opts);
  if (ids.length === 0) return { passages: [], candidateIds: [] };

  const rows = await db(env)
    .select({
      id: chunks.id,
      documentId: chunks.documentId,
      ordinal: chunks.ordinal,
      text: chunks.text,
      pageStart: chunks.pageStart,
      pageEnd: chunks.pageEnd,
      headingPath: chunks.headingPath,
      gameName: games.name,
      documentTitle: documents.title,
      documentKind: documents.kind,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .innerJoin(games, eq(games.id, documents.gameId))
    .where(inArray(chunks.id, ids));

  const byId = new Map(rows.map((row) => [row.id, row]));

  // The fused window for the eval's Recall@20 is the candidate ids regardless of hydration outcome.
  // Build ordered survivors in fused (RRF) order; skip any id missing its D1 row.
  const survivors: RetrievedChunk[] = ids.flatMap((id) => {
    const row = byId.get(id);
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
          headingPath: row.headingPath,
        },
        gameName: row.gameName,
        documentTitle: row.documentTitle,
        documentKind: row.documentKind,
        // cosine score — preserved for Citation display; 0 for a lexical-only hit (no dense score).
        score: cosineById.get(id) ?? 0,
      },
    ];
  });

  if (survivors.length === 0) return { passages: [], candidateIds: ids };

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

  const passages = reranked.response
    .filter(({ score }) => score >= RERANK_MIN_SCORE)
    .flatMap(({ id }) => {
      const chunk = survivors[id];
      return chunk ? [chunk] : [];
    });

  // Rescue the RRF-consensus top candidate. survivors[0] is the chunk the dense + BM25 legs most
  // agree on; the cross-encoder is a reliable RANKER but an unreliable ABSOLUTE judge (see
  // models.ts RERANK_MIN_SCORE), and for natural-language META questions it scores that candidate
  // below the gate even when it is the answer — measured: "what's in the box?" reranks the Quacks
  // components chunk ~0.03 (gated out) though it is candidate #1, so the gate returned a degraded
  // set and the model refused, while "list of components" passed. The gate's job is to drop garbage,
  // not to veto strong retrieval consensus to an empty/degraded set: the LLM is the relevance judge
  // (it refuses on content when a passage genuinely doesn't fit — proven for the off-topic/injection
  // cases that already reach it). Keep the consensus #1 so the model always gets it to decide on.
  const consensusTop = survivors[0];
  if (consensusTop && !passages.some((p) => p.chunk.id === consensusTop.chunk.id)) {
    passages.unshift(consensusTop);
  }
  return { passages, candidateIds: ids };
}

/**
 * Convenience wrapper returning just the reranked passages — the agent and /api/eval/answer don't
 * need the candidate window. Delegates to retrieveDetailed so there is one retrieval implementation.
 */
export async function retrieve(
  env: Env,
  question: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  return (await retrieveDetailed(env, question, opts)).passages;
}
