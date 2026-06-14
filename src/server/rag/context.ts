import type { UIMessage } from "ai";
import type { RetrievedChunk } from "../../shared/types";

/** Each user message's text (its text parts joined + trimmed), oldest→newest, skipping empties. */
export function userTexts(messages: UIMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) texts.push(text);
  }
  return texts;
}

/** A passage's source-document label: the base game by title alone, an expansion tagged as such. */
function documentLabel(passage: RetrievedChunk): string {
  return passage.documentKind === "base"
    ? passage.documentTitle
    : `${passage.documentTitle} — ${passage.documentKind}`;
}

/**
 * Number and label each retrieved passage for the model's grounding block. The `[N]` markers key
 * the inline citations; the document label lets the goblin tell a base-game rule from an
 * expansion's and scope its ruling accordingly.
 */
export function formatGrounding(passages: RetrievedChunk[]): string {
  return passages
    .map((passage, i) => `[${i + 1}] (${documentLabel(passage)}) ${passage.chunk.text}`)
    .join("\n\n");
}

/**
 * Reciprocal Rank Fusion: merge several ranked id-lists (here the dense ANN leg + the lexical BM25
 * leg, GAP 1) into one ranking BEFORE the reranker. Each id scores Σ 1/(k + rank) over the lists it
 * appears in (rank is 1-based), and ids sort by descending fused score. An id that ranks well in
 * both legs accrues two contributions and floats up. RRF over a single non-empty list returns that
 * list's order unchanged — so an empty lexical leg degrades to pure dense order. Ties resolve by
 * first appearance across the lists (stable), which keeps the order deterministic.
 */
export function reciprocalRankFusion(lists: string[][], k: number): string[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let seq = 0;
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, seq++);
    });
  }
  return [...scores.keys()].sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    // biome-ignore lint/style/noNonNullAssertion: every id sorted here was inserted into firstSeen.
    return diff !== 0 ? diff : firstSeen.get(a)! - firstSeen.get(b)!;
  });
}

/**
 * Make a user question safe to pass to an FTS5 `MATCH`. FTS5 treats bare words as operators
 * (AND/OR/NOT/NEAR) and reserves `* ^ : " ( )` for query syntax, so a raw question like
 * `how do I get "out"?` is a syntax error. We extract only letter/digit runs as tokens (so every
 * reserved/operator character — quotes included — is dropped at the tokeniser, no escaping needed),
 * wrap each as a double-quoted string literal, and OR-join them. Quoting neutralises any token that
 * happens to spell an operator (AND/OR/NEAR) — it can't be parsed as syntax — and OR
 * (rather than FTS5's implicit AND) keeps lexical recall high for multi-word rules questions; the
 * reranker culls the false positives. Returns '' when no token survives (caller skips the FTS leg).
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return "";
  return tokens.map((token) => `"${token}"`).join(" OR ");
}
