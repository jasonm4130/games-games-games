import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkInput, PageText } from "../../shared/types";
import {
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  TABLE_MAX_TOKENS,
} from "./models";

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
 * Baseline character-window splitter, kept for tests and simple callers. The real
 * ingestion path uses `chunkPages` below.
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

export interface ChunkPagesOptions {
  /**
   * Counts bge-m3 tokens for a string. Injected (not imported) so this module carries no
   * tokenizer dependency and stays runnable anywhere — the operator script wires in the
   * real `@huggingface/transformers` tokenizer; tests pass a cheap estimate.
   */
  countTokens: (text: string) => number;
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

// A numbered-rule heading line, e.g. "4.3 Flying", "12. Setup", "7.1a Exception".
const NUMBERED_HEADING = /^\d+(?:\.\d+)*[a-z]?[.)]?\s+\S/;

function headingOf(text: string): string | null {
  const firstLine = (text.split("\n", 1)[0] ?? "").trim();
  return NUMBERED_HEADING.test(firstLine) ? firstLine.slice(0, 80) : null;
}

// Pipe-delimited table block. Robust spatial detection belongs in the PDF extractor
// (TODO(rag): mark table regions during pdfjs extraction where x-coordinates are available).
function looksLikeTable(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const piped = lines.filter((l) => (l.match(/\|/g)?.length ?? 0) >= 2).length;
  return piped >= Math.ceil(lines.length / 2);
}

interface Piece {
  text: string;
  page: number;
}

/**
 * Chunk extracted pages into token-budgeted, page-tagged, heading-enriched chunks
 * (ADR 0002, ADR 0004). Uses `@langchain/textsplitters` for structure-aware boundary
 * splitting, then greedily merges pieces up to `targetTokens` with `overlapTokens` of
 * carry-over, enforcing a hard `maxTokens` cap. Page spans come from tagging each piece
 * with its source page before merging, so a chunk that crosses a page boundary reports the
 * full span. The nearest preceding numbered heading is prepended to `embedText` only.
 */
export async function chunkPages(
  pages: PageText[],
  options: ChunkPagesOptions,
): Promise<ChunkInput[]> {
  const { countTokens } = options;
  const targetTokens = options.targetTokens ?? CHUNK_TARGET_TOKENS;
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;

  // Hard-split a piece that exceeds `cap` tokens by halving at whitespace near the middle.
  function enforceCap(text: string, cap: number): string[] {
    if (countTokens(text) <= cap) return [text];
    const mid = Math.floor(text.length / 2);
    const space = text.lastIndexOf(" ", mid);
    const cut = space > 0 ? space : mid;
    const left = text.slice(0, cut).trim();
    const right = text.slice(cut).trim();
    if (!left || !right) return [text]; // indivisible; emit as-is rather than loop
    return [...enforceCap(left, cap), ...enforceCap(right, cap)];
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: targetTokens * 4, // chars; a generous chars/token so pieces stay mergeable
    chunkOverlap: 0,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  // 1. Fine, structure-aware pieces, each tagged with its source page.
  const pieces: Piece[] = [];
  for (const page of pages) {
    const normalized = page.text.replace(/\r\n/g, "\n").trim();
    if (!normalized) continue;
    for (const part of await splitter.splitText(normalized)) {
      const trimmed = part.trim();
      if (trimmed) pieces.push({ text: trimmed, page: page.pageNumber });
    }
  }

  // 2. Merge pieces up to the token target; tables emit atomically.
  const chunks: ChunkInput[] = [];
  let buf: Piece[] = [];
  let bufTokens = 0;
  let lastHeading: string | null = null;

  const emit = (text: string, pageStart: number, pageEnd: number, isTable: boolean) => {
    const embedText = lastHeading ? `${lastHeading}\n${text}` : text;
    chunks.push({ text, embedText, pageStart, pageEnd, headingPath: lastHeading, isTable });
  };

  const flush = () => {
    if (buf.length === 0) return;
    emit(
      buf.map((p) => p.text).join("\n\n"),
      Math.min(...buf.map((p) => p.page)),
      Math.max(...buf.map((p) => p.page)),
      false,
    );
    // Carry trailing pieces (~overlapTokens) into the next chunk; never the whole buffer.
    const carry: Piece[] = [];
    let carryTokens = 0;
    for (let i = buf.length - 1; i > 0 && carryTokens < overlapTokens; i--) {
      carry.unshift(buf[i]);
      carryTokens += countTokens(buf[i].text);
    }
    buf = carry;
    bufTokens = carryTokens;
  };

  for (const piece of pieces) {
    const heading = headingOf(piece.text);
    if (heading) lastHeading = heading;

    if (looksLikeTable(piece.text)) {
      flush();
      for (const part of enforceCap(piece.text, TABLE_MAX_TOKENS)) {
        emit(part, piece.page, piece.page, true);
      }
      continue;
    }

    for (const part of enforceCap(piece.text, maxTokens)) {
      const tokens = countTokens(part);
      if (bufTokens > 0 && bufTokens + tokens > targetTokens) flush();
      buf.push({ text: part, page: piece.page });
      bufTokens += tokens;
    }
  }
  flush();

  return chunks;
}
