import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk";

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
