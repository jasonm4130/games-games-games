import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../../shared/types";
import { formatGrounding, userTexts } from "./context";

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
