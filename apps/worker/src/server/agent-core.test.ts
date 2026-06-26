import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "../shared/types";
import { retrieveWithFollowup, speakableText, toCitations } from "./agent-core";

const HIT = [{} as RetrievedChunk]; // a non-empty result stands in for "grounded"
const MISS: RetrievedChunk[] = [];

describe("retrieveWithFollowup", () => {
  it("returns the latest's passages and anchors on it when it grounds alone", async () => {
    const fn = vi.fn(async () => HIT);
    const out = await retrieveWithFollowup(fn, "how does trading work", "old subject");
    expect(out.passages).toBe(HIT);
    expect(out.groundedQuery).toBe("how does trading work");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("how does trading work");
  });

  it("folds in the last grounded query when the terse latest grounds nothing", async () => {
    const fn = vi.fn(async (q: string) => (q.includes("\n") ? HIT : MISS));
    const out = await retrieveWithFollowup(fn, "what about 4 players?", "how does trading work");
    expect(out.passages).toBe(HIT);
    // the anchor stays the last grounded query — a terse follow-up never becomes the new subject
    expect(out.groundedQuery).toBe("how does trading work");
    expect(fn).toHaveBeenNthCalledWith(1, "what about 4 players?");
    expect(fn).toHaveBeenNthCalledWith(2, "how does trading work\nwhat about 4 players?");
  });

  it("does not retry when there is no prior grounded query", async () => {
    const fn = vi.fn(async () => MISS);
    const out = await retrieveWithFollowup(fn, "gibberish", undefined);
    expect(out.passages).toEqual([]);
    expect(out.groundedQuery).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the prior anchor when the folded retry also grounds nothing", async () => {
    const fn = vi.fn(async () => MISS);
    const out = await retrieveWithFollowup(fn, "???", "trading");
    expect(out.passages).toEqual([]);
    expect(out.groundedQuery).toBe("trading");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

function msg(parts: UIMessage["parts"]): UIMessage {
  return { id: "m1", role: "assistant", parts } as UIMessage;
}

describe("speakableText", () => {
  it("joins text parts, strips [N] citation markers, and collapses whitespace", () => {
    const out = speakableText(
      msg([
        { type: "text", text: "You collect $200 [1] when you" },
        { type: "text", text: "pass Go [2].  Always." },
      ]),
    );
    expect(out).toBe("You collect $200 when you pass Go . Always.");
  });

  it("returns an empty string when the message has no text parts", () => {
    expect(speakableText(msg([]))).toBe("");
  });
});

describe("toCitations", () => {
  it("projects each passage to a Citation card (id, source label, page span, score)", () => {
    const passages: RetrievedChunk[] = [
      {
        chunk: {
          id: "c1",
          documentId: "d1",
          ordinal: 3,
          text: "rule text",
          pageStart: 4,
          pageEnd: 5,
          headingPath: null,
        },
        gameName: "Catan",
        documentTitle: "Base Game",
        documentKind: "base",
        score: 0.83,
      },
    ];
    expect(toCitations(passages)).toEqual([
      {
        chunkId: "c1",
        documentId: "d1",
        gameName: "Catan",
        documentTitle: "Base Game",
        ordinal: 3,
        pageStart: 4,
        pageEnd: 5,
        headingPath: null,
        text: "rule text",
        score: 0.83,
      },
    ]);
  });

  it("maps empty passages to no citations", () => {
    expect(toCitations([])).toEqual([]);
  });
});
