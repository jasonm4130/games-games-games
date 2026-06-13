export interface ChunkOptions {
  /** Maximum characters per chunk. */
  maxChars?: number;
  /** Characters of overlap carried between adjacent chunks. */
  overlap?: number;
}

/**
 * Split rulebook text into overlapping chunks. Pure and deterministic — this is
 * the unit exercised by the smoke test.
 *
 * Baseline character-window splitter. TODO(rag): replace with structure-aware,
 * token-budgeted chunking via @langchain/textsplitters + the bge-m3 tokenizer — split on
 * numbered-rule headings first (\n\d+\.\d+), then paragraphs/lines/sentences; target
 * CHUNK_TARGET_TOKENS, cap CHUNK_MAX_TOKENS, overlap CHUNK_OVERLAP_TOKENS (see ./models);
 * keep tables atomic; prepend the heading path to the embed text only, not the stored text.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  // Default overlap scales with maxChars so a small maxChars stays valid.
  const overlap = options.overlap ?? Math.min(150, Math.floor(maxChars / 5));

  if (maxChars <= 0) throw new Error("maxChars must be positive");
  if (overlap < 0 || overlap >= maxChars) {
    throw new Error("overlap must be >= 0 and < maxChars");
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  const step = maxChars - overlap;
  for (let start = 0; start < normalized.length; start += step) {
    const piece = normalized.slice(start, start + maxChars).trim();
    if (piece.length > 0) chunks.push(piece);
    if (start + maxChars >= normalized.length) break;
  }
  return chunks;
}
