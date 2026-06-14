// Pure, decorator-free helpers extracted from RulesAgent so they can be unit-tested without the
// @callable() TC39 decorators that the vitest-pool-workers V8 can't compile at test time (the whole
// agent module is mocked in tts.test.ts for that reason). Keep everything here free of `this` and
// Durable Object APIs.

import type { UIMessage } from "ai";
import type { Citation, RetrievedChunk } from "../shared/types";

/**
 * Map retrieved passages to the Citation cards the client renders, keyed to the [N] markers in the
 * answer. Pure projection (chunk id/page span/source label + score) — extracted from the agent so it
 * can be unit-tested without the Durable Object.
 */
export function toCitations(passages: RetrievedChunk[]): Citation[] {
  return passages.map((p) => ({
    chunkId: p.chunk.id,
    documentId: p.chunk.documentId,
    gameName: p.gameName,
    documentTitle: p.documentTitle,
    ordinal: p.chunk.ordinal,
    pageStart: p.chunk.pageStart,
    pageEnd: p.chunk.pageEnd,
    text: p.chunk.text,
    score: p.score,
  }));
}

/**
 * The speakable text of an assistant turn: its text parts joined, with the inline [N] citation
 * markers stripped (they read as noise aloud) and whitespace collapsed. Returns "" when the turn
 * has no text. The TTS `speak` RPC resolves the text from the persisted message server-side (so
 * only real rulings can be voiced), then passes it here. Mirrors the client's old cleanup.
 */
export function speakableText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two-pass retrieval for conversational follow-ups. A terse follow-up ("what about 4 players?")
 * embeds poorly on its own and would fall through to the out-of-scope refusal even mid-topic — so
 * when the latest message grounds nothing, retry with the last query that DID ground folded in.
 *
 * We fold in `lastGroundedQuery` (the last user turn that grounded on its own), NOT simply the
 * previous user turn: NOT_COVERED refusals persist as assistant turns, so the previous user turn
 * may itself have been off-topic, and folding it in would drag a stale subject back into scope.
 * Returns the passages plus the query to remember as the anchor — `latest` when it grounds alone,
 * otherwise the unchanged `lastGroundedQuery` (a terse follow-up never becomes the new anchor).
 */
export async function retrieveWithFollowup(
  retrieveFn: (query: string) => Promise<RetrievedChunk[]>,
  latest: string,
  lastGroundedQuery: string | undefined,
): Promise<{ passages: RetrievedChunk[]; groundedQuery: string | undefined }> {
  const passages = await retrieveFn(latest);
  if (passages.length > 0) return { passages, groundedQuery: latest };
  if (lastGroundedQuery) {
    return {
      passages: await retrieveFn(`${lastGroundedQuery}\n${latest}`),
      groundedQuery: lastGroundedQuery,
    };
  }
  return { passages, groundedQuery: lastGroundedQuery };
}
