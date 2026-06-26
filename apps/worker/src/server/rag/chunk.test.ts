import { describe, expect, it } from "vitest";
import { chunkMarkdown, parseMarkdownSections } from "./chunk";

// Cheap, deterministic stand-in for the bge-m3 tokenizer (one token per whitespace word).
const countTokens = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

describe("parseMarkdownSections", () => {
  it("builds a heading path from ATX heading nesting", () => {
    const md = "# Monopoly\nintro\n## Jail\n### Getting Out\nRoll doubles.";
    const secs = parseMarkdownSections(md);
    expect(secs.at(-1)?.headingPath).toBe("Monopoly > Jail > Getting Out");
    expect(secs.at(-1)?.body).toContain("Roll doubles.");
  });
  it("keeps preamble before the first heading with a null path", () => {
    const secs = parseMarkdownSections("loose intro text\n## First\nbody");
    expect(secs[0].headingPath).toBeNull();
    expect(secs[0].body).toBe("loose intro text");
  });
});

describe("chunkMarkdown", () => {
  it("never merges across a heading boundary", async () => {
    const md = `## A\n${"alpha ".repeat(30)}\n## B\n${"bravo ".repeat(30)}`;
    const chunks = await chunkMarkdown(md, { countTokens, targetTokens: 1000, maxTokens: 2000 });
    for (const c of chunks) {
      const hasA = c.text.includes("alpha");
      const hasB = c.text.includes("bravo");
      expect(hasA && hasB).toBe(false); // no chunk straddles A and B
    }
  });
  it("prefixes the heading path onto embedText and stores it, with null pages", async () => {
    const md = "## Setup\n### Money\nEach player starts with $1500.";
    const [chunk] = await chunkMarkdown(md, { countTokens, targetTokens: 50, maxTokens: 100 });
    expect(chunk.headingPath).toBe("Setup > Money");
    expect(chunk.embedText.startsWith("Setup > Money")).toBe(true);
    expect(chunk.embedText).toContain(chunk.text);
    expect(chunk.pageStart).toBeNull();
    expect(chunk.pageEnd).toBeNull();
  });
  it("drops degenerate sub-floor chunks (page furniture / card labels) but keeps real content", async () => {
    // Docling promotes component lists and page furniture to headings; their bodies are junk
    // ("back", "5 of 5") and must not become chunks. A real rule line under the same pattern stays.
    const md =
      "## 37 event cards\nback\n## Setup\nEach player draws five cards to form their starting hand.";
    const chunks = await chunkMarkdown(md, { countTokens, targetTokens: 50, maxTokens: 100 });
    expect(chunks.some((c) => c.text.trim() === "back")).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe("Setup");
  });
});
