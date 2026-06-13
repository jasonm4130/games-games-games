import { describe, expect, it } from "vitest";
import { chunkPages, chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps text shorter than the limit as a single chunk", () => {
    const text = "Roll two dice and move your token clockwise.";
    expect(chunkText(text, { maxChars: 100 })).toEqual([text]);
  });

  it("splits long text into multiple chunks within the size limit", () => {
    const text = "word ".repeat(1000).trim(); // ~4999 chars
    const chunks = chunkText(text, { maxChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it("rejects invalid options", () => {
    expect(() => chunkText("abc", { maxChars: 100, overlap: 100 })).toThrow();
    expect(() => chunkText("abc", { maxChars: 0 })).toThrow();
  });
});

// Cheap, deterministic stand-in for the bge-m3 tokenizer (one token per whitespace word).
const countTokens = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

describe("chunkPages", () => {
  it("returns nothing for empty pages", async () => {
    expect(await chunkPages([], { countTokens })).toEqual([]);
    expect(await chunkPages([{ pageNumber: 1, text: "  \n " }], { countTokens })).toEqual([]);
  });

  it("merges small paragraphs toward the token target and respects the hard cap", async () => {
    const text = Array.from({ length: 8 }, (_, i) => `paragraph ${i} has exactly five`).join(
      "\n\n",
    );
    const chunks = await chunkPages([{ pageNumber: 3, text }], {
      countTokens,
      targetTokens: 10,
      maxTokens: 20,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(20);
      expect(chunk.pageStart).toBe(3);
      expect(chunk.pageEnd).toBe(3);
    }
  });

  it("reports a page span when a chunk crosses a page boundary", async () => {
    const chunks = await chunkPages(
      [
        { pageNumber: 1, text: "first page line" },
        { pageNumber: 2, text: "second page line" },
      ],
      { countTokens, targetTokens: 50, maxTokens: 100, overlapTokens: 0 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[0].pageEnd).toBe(2);
  });

  it("prefixes the heading path onto embedText only, not the stored text", async () => {
    const text = "4.3 Flying\nUnits with flight ignore terrain costs when moving.";
    const [chunk] = await chunkPages([{ pageNumber: 1, text }], {
      countTokens,
      targetTokens: 50,
      maxTokens: 100,
    });
    expect(chunk.headingPath).toBe("4.3 Flying");
    expect(chunk.embedText.startsWith("4.3 Flying")).toBe(true);
    expect(chunk.embedText).toContain(chunk.text);
  });

  it("hard-splits an oversized paragraph below the token cap", async () => {
    const text = "token ".repeat(120).trim(); // 120 words, one paragraph
    const chunks = await chunkPages([{ pageNumber: 1, text }], {
      countTokens,
      targetTokens: 10,
      maxTokens: 20,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps a pipe table as its own atomic chunk", async () => {
    const text = "| Unit | Move |\n| Scout | 6 |\n| Tank | 3 |";
    const [chunk] = await chunkPages([{ pageNumber: 5, text }], {
      countTokens,
      targetTokens: 50,
      maxTokens: 100,
    });
    expect(chunk.isTable).toBe(true);
    expect(chunk.pageStart).toBe(5);
  });
});
