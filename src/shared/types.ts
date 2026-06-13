// Domain model — see CONTEXT.md for the canonical definitions.

export type DocumentStatus = "pending" | "ingesting" | "ready" | "failed";

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
  status: DocumentStatus;
  createdAt: string;
}

/** A retrievable segment of a Rulebook — the unit embedded into Vectorize. */
export interface Chunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  vectorId: string;
  createdAt: string;
}

/** A Chunk returned from Retrieval, with its similarity score. */
export interface RetrievedChunk {
  chunk: Pick<Chunk, "id" | "documentId" | "ordinal" | "text">;
  score: number;
}

/** A reference from a Ruling back to the Chunk that supports it. */
export interface Citation {
  chunkId: string;
  documentId: string;
  gameName: string;
  ordinal: number;
  text: string;
  score: number;
}
