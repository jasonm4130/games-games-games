// Domain model — see CONTEXT.md for the canonical definitions.

export type DocumentStatus = "pending" | "ingesting" | "ready" | "failed";

/** A Rulebook's role within its Game; errata overrides base rules (ADR 0004). */
export type DocumentKind = "base" | "expansion" | "errata";

/** A specific tabletop game whose rules the system can answer about. */
export interface Game {
  id: string;
  name: string;
  edition: string | null;
  createdAt: string;
}

/** A source document describing a Game's rules, stored in R2. */
export interface RulebookDocument {
  id: string;
  gameId: string;
  r2Key: string;
  title: string;
  kind: DocumentKind;
  status: DocumentStatus;
  /** Number of indexed Chunks once status is "ready"; null otherwise. */
  chunksCount: number | null;
  ingestedAt: string | null;
  createdAt: string;
}

/**
 * A retrievable segment of a Rulebook — the unit embedded into Vectorize. The Chunk `id`
 * doubles as the Vectorize vector id (ADR 0004).
 */
export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  /** Source page span for Citations; null for non-paginated sources. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Contextual-retrieval blurb; prepended to `text` at embed time only. */
  contextBlurb: string | null;
  createdAt: string;
}

/** A Chunk returned from Retrieval, with its similarity score. */
export interface RetrievedChunk {
  chunk: Pick<Chunk, "id" | "documentId" | "ordinal" | "text" | "pageStart" | "pageEnd">;
  score: number;
}

/** A reference from a Ruling back to the Chunk that supports it, for verification. */
export interface Citation {
  chunkId: string;
  documentId: string;
  gameName: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  score: number;
}
