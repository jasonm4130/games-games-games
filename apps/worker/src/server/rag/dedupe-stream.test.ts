import { describe, expect, it } from "vitest";
import { dedupeStreamParts } from "./dedupe-stream";

// Minimal structural stand-in for a LanguageModelV3StreamPart (only the fields the deduper reads).
type Part = { type: string; id?: string; delta?: string };
const td = (id: string, delta: string): Part => ({ type: "text-delta", id, delta });
const labels = (parts: Part[]) => parts.map((p) => p.delta ?? p.type);

describe("dedupeStreamParts — workers-ai-provider double-emit workaround", () => {
  it("collapses each immediately-repeated identical text-delta to one", () => {
    // Workers AI sends the same token in both `response` and `choices[].delta.content`, so the
    // provider emits two byte-identical text-deltas per token ("MyMy precious precious …").
    const parts: Part[] = [
      { type: "text-start", id: "t" },
      td("t", "My"),
      td("t", "My"),
      td("t", " precious"),
      td("t", " precious"),
      td("t", " rulebook"),
      td("t", " rulebook"),
      { type: "text-end", id: "t" },
    ];
    expect(labels(dedupeStreamParts(parts))).toEqual([
      "text-start",
      "My",
      " precious",
      " rulebook",
      "text-end",
    ]);
  });

  it("leaves a non-doubled stream untouched", () => {
    const parts: Part[] = [td("t", "a"), td("t", "b"), td("t", "c")];
    expect(dedupeStreamParts(parts)).toEqual(parts);
  });

  it("recovers two genuinely-repeated tokens when each was doubled (a,a,a,a → a,a)", () => {
    const parts: Part[] = [td("t", "go"), td("t", "go"), td("t", "go"), td("t", "go")];
    expect(labels(dedupeStreamParts(parts))).toEqual(["go", "go"]);
  });

  it("a non-text-delta breaks the pairing so a following lone identical delta survives", () => {
    const parts: Part[] = [
      td("t", "x"),
      td("t", "x"), // doubled pair → one x
      { type: "reasoning-start", id: "r" }, // resets the pairing
      td("t", "x"), // lone x → survives
    ];
    expect(labels(dedupeStreamParts(parts))).toEqual(["x", "reasoning-start", "x"]);
  });

  it("does not dedupe identical deltas that carry different ids", () => {
    const parts: Part[] = [td("a", "z"), td("b", "z")];
    expect(dedupeStreamParts(parts)).toEqual(parts);
  });
});
