import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkInput } from "../../shared/types";
import {
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  MIN_CHUNK_CHARS,
  TABLE_MAX_TOKENS,
} from "./models";

export interface ChunkOptions {
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

// Pipe-delimited table block: a run of lines where at least half carry two-or-more pipe chars.
// Docling emits rulebook tables as markdown pipe rows, so chunkMarkdown keeps them atomic.
function looksLikeTable(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const piped = lines.filter((l) => (l.match(/\|/g)?.length ?? 0) >= 2).length;
  return piped >= Math.ceil(lines.length / 2);
}

// Hard-split a piece that exceeds `cap` tokens by halving at whitespace near the middle.
function enforceCap(text: string, cap: number, countTokens: (t: string) => number): string[] {
  if (countTokens(text) <= cap) return [text];
  const mid = Math.floor(text.length / 2);
  const space = text.lastIndexOf(" ", mid);
  const cut = space > 0 ? space : mid;
  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  if (!left || !right) return [text];
  return [...enforceCap(left, cap, countTokens), ...enforceCap(right, cap, countTokens)];
}

// An ATX markdown heading line, e.g. "## Setup", "### Getting Out of Jail".
const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export interface MarkdownSection {
  headingPath: string | null;
  level: number;
  body: string;
}

/** Split markdown into heading-delimited sections, each carrying its full heading path. */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let body: string[] = [];
  let level = 0;
  let path: string | null = null;

  // Heading-only sections (no body lines) are skipped — they only advance the heading path for the
  // next section that has content (e.g. a chapter title sitting above its sub-sections).
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ headingPath: path, level, body: text });
    body = [];
  };

  for (const line of lines) {
    const m = ATX_HEADING.exec(line);
    if (m) {
      flush();
      level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      path = stack.map((s) => s.title).join(" > ");
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Chunk markdown into token-budgeted, heading-enriched chunks (ADR 0008). Pieces are merged toward
 * the token target WITHIN a section only — never across a heading boundary — so a fact never shares
 * a chunk with unrelated material. The section heading path is prepended to `embedText` and stored
 * as `headingPath`. Markdown has no pages, so pageStart/pageEnd are null.
 */
export async function chunkMarkdown(
  markdown: string,
  options: ChunkOptions,
): Promise<ChunkInput[]> {
  const { countTokens } = options;
  const targetTokens = options.targetTokens ?? CHUNK_TARGET_TOKENS;
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: targetTokens * 4,
    chunkOverlap: 0,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const chunks: ChunkInput[] = [];
  for (const section of parseMarkdownSections(markdown)) {
    const heading = section.headingPath;
    const emit = (text: string, isTable: boolean) => {
      // Skip near-empty chunks from Docling's spurious headings over page furniture / labels.
      if (text.trim().length < MIN_CHUNK_CHARS) return;
      const embedText = heading ? `${heading}\n${text}` : text;
      chunks.push({
        text,
        embedText,
        pageStart: null,
        pageEnd: null,
        headingPath: heading,
        isTable,
      });
    };

    let buf: string[] = [];
    let bufTokens = 0;
    const flush = () => {
      if (buf.length === 0) return;
      emit(buf.join("\n\n"), false);
      // Carry trailing pieces (~overlapTokens) within THIS section only; the next section starts a
      // fresh buf, so overlap never crosses a heading boundary (that's the point of section-scoping).
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = buf.length - 1; i > 0 && carryTokens < overlapTokens; i--) {
        carry.unshift(buf[i]);
        carryTokens += countTokens(buf[i]);
      }
      buf = carry;
      bufTokens = carryTokens;
    };

    for (const part of await splitter.splitText(section.body)) {
      const piece = part.trim();
      if (!piece) continue;
      if (looksLikeTable(piece)) {
        flush();
        for (const t of enforceCap(piece, TABLE_MAX_TOKENS, countTokens)) emit(t, true);
        continue;
      }
      for (const capped of enforceCap(piece, maxTokens, countTokens)) {
        const tokens = countTokens(capped);
        if (bufTokens > 0 && bufTokens + tokens > targetTokens) flush();
        buf.push(capped);
        bufTokens += tokens;
      }
    }
    flush();
  }
  return chunks;
}
