// Domain model — see CONTEXT.md for the canonical definitions.

import type { UIMessage } from "ai";

export type DocumentStatus = "pending" | "ingesting" | "ready" | "failed";

/** Per-Session state held by the RulesAgent Durable Object (persists across hibernation). */
export interface RulesAgentState {
  /** The Game the Session is scoped to; undefined until the user picks one (ADR 0004). */
  activeGameId: string | undefined;
}

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

/** One page of extracted rulebook text — the input to chunking. */
export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * A chunk ready to embed + persist. `text` is the raw chunk stored in D1 and shown in
 * Citations; `embedText` carries the heading-path prefix and is used only for embedding.
 */
export interface ChunkInput {
  text: string;
  embedText: string;
  pageStart: number;
  pageEnd: number;
  headingPath: string | null;
  isTable: boolean;
}

/** A Chunk returned from Retrieval, with its similarity score. */
export interface RetrievedChunk {
  chunk: Pick<Chunk, "id" | "documentId" | "ordinal" | "text" | "pageStart" | "pageEnd">;
  /** Name of the Game the chunk belongs to (retrieval is Game-scoped) — for Citations. */
  gameName: string;
  /** Title of the source Rulebook (Document) — disambiguates which book within a Game. */
  documentTitle: string;
  /** base | expansion | errata — lets the grounding tell the model which book a passage is from. */
  documentKind: DocumentKind;
  score: number;
}

/** A reference from a Ruling back to the Chunk that supports it, for verification. */
export interface Citation {
  chunkId: string;
  documentId: string;
  gameName: string;
  /** Title of the source Rulebook — shown so a Citation names which book within a Game. */
  documentTitle: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  score: number;
}

/**
 * The chat's UI message shape: assistant turns carry a `data-citations` part alongside the
 * streamed text, so the client can render verifiable Citation cards keyed to the [N] markers.
 */
export type RulesUIMessage = UIMessage<never, { citations: Citation[] }>;
