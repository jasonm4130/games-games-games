import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../../shared/types";
import { formatGrounding, reciprocalRankFusion, sanitizeFtsQuery, userTexts } from "./context";

function userMsg(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] } as UIMessage;
}
function assistantMsg(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function passage(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk: {
      id: "c1",
      documentId: "d1",
      ordinal: 0,
      text: "the rule text",
      pageStart: 1,
      pageEnd: 1,
    },
    gameName: "The Quacks of Quedlinburg",
    documentTitle: "Base Game",
    documentKind: "base",
    score: 0.9,
    ...overrides,
  };
}

describe("userTexts", () => {
  it("returns user message texts oldest→newest, ignoring assistant turns", () => {
    const messages = [
      userMsg("how many players?"),
      assistantMsg("Two to four [1]."),
      userMsg("what about 4 players?"),
    ];
    expect(userTexts(messages)).toEqual(["how many players?", "what about 4 players?"]);
  });

  it("joins multiple text parts of one message and trims", () => {
    const msg = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: " how do " },
        { type: "text", text: "I win? " },
      ],
    } as UIMessage;
    expect(userTexts([msg])).toEqual(["how do I win?"]);
  });

  it("skips messages with no text content", () => {
    const empty = { id: "m1", role: "user", parts: [] } as unknown as UIMessage;
    expect(userTexts([empty, userMsg("real question")])).toEqual(["real question"]);
  });
});

describe("formatGrounding", () => {
  it("numbers passages and labels the base game by title only", () => {
    const out = formatGrounding([
      passage({
        chunk: {
          id: "c1",
          documentId: "d1",
          ordinal: 0,
          text: "base rule",
          pageStart: 1,
          pageEnd: 1,
        },
      }),
    ]);
    expect(out).toBe("[1] (Base Game) base rule");
  });

  it("marks an expansion passage with its kind so the model can tell it from the base", () => {
    const out = formatGrounding([
      passage({
        chunk: {
          id: "c1",
          documentId: "d1",
          ordinal: 0,
          text: "base rule",
          pageStart: 1,
          pageEnd: 1,
        },
      }),
      passage({
        documentTitle: "The Herb Witches",
        documentKind: "expansion",
        chunk: {
          id: "c2",
          documentId: "d2",
          ordinal: 0,
          text: "witch rule",
          pageStart: 2,
          pageEnd: 2,
        },
      }),
    ]);
    expect(out).toBe("[1] (Base Game) base rule\n\n[2] (The Herb Witches — expansion) witch rule");
  });
});

describe("reciprocalRankFusion", () => {
  it("floats an id ranked high in both legs to the top", () => {
    // "b" is rank 2 in the dense leg and rank 1 in the lexical leg, so it accrues two strong
    // contributions; "a" leads dense but is absent from lexical, so b should win overall.
    const fused = reciprocalRankFusion(
      [
        ["a", "b", "c"],
        ["b", "d", "e"],
      ],
      15,
    );
    expect(fused[0]).toBe("b");
  });

  it("still ranks an id present in only one leg by its 1/(k+rank) contribution", () => {
    // "x" appears only in the second list (rank 1) but should still rank above "c" (only in the
    // first list at rank 3): 1/(15+1) > 1/(15+3).
    const fused = reciprocalRankFusion([["a", "b", "c"], ["x"]], 15);
    expect(fused.indexOf("x")).toBeLessThan(fused.indexOf("c"));
  });

  it("returns a single list's order unchanged (FTS-empty degradation contract)", () => {
    expect(reciprocalRankFusion([["a", "b", "c"]], 15)).toEqual(["a", "b", "c"]);
  });

  it("degrades to the dense list when the lexical leg is empty", () => {
    expect(reciprocalRankFusion([["a", "b", "c"], []], 15)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty input", () => {
    expect(reciprocalRankFusion([], 15)).toEqual([]);
    expect(reciprocalRankFusion([[], []], 15)).toEqual([]);
  });

  it("breaks ties by first appearance across the legs", () => {
    // Each id appears exactly once at rank 1 of its own leg, so all fused scores are equal; order
    // must be stable by first appearance ("a" before "b" before "c").
    expect(reciprocalRankFusion([["a"], ["b"], ["c"]], 15)).toEqual(["a", "b", "c"]);
  });
});

describe("sanitizeFtsQuery", () => {
  it("neutralises FTS5 operators by quoting each token as a string literal", () => {
    const out = sanitizeFtsQuery('how do I get "out" OR jail?');
    // Every word becomes a double-quoted literal — including the user's "OR", which is now the
    // matched word "or", not the FTS5 OR operator. Quotes and "?" drop out as punctuation; no bare
    // operator survives to throw a MATCH syntax error.
    expect(out).toBe('"how" OR "do" OR "I" OR "get" OR "out" OR "OR" OR "jail"');
  });

  it("returns '' for all-punctuation input (caller then skips the FTS leg)", () => {
    expect(sanitizeFtsQuery("()*^:")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  it("OR-joins quoted tokens for a normal multi-word question", () => {
    expect(sanitizeFtsQuery("how many players")).toBe('"how" OR "many" OR "players"');
  });
});
