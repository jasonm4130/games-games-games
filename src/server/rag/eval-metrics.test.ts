import { describe, expect, it } from "vitest";
import {
  citationValidity,
  hitRateAt,
  parseCitationMarkers,
  precisionAt,
  recallAt,
  tokenOverlap,
} from "./eval-metrics";

describe("parseCitationMarkers", () => {
  it("extracts [N] markers, deduped and sorted ascending", () => {
    expect(parseCitationMarkers("Pay $50 [2], or roll doubles [1]. See [2] again.")).toEqual([
      1, 2,
    ]);
  });

  it("returns [] when the answer cites nothing", () => {
    expect(parseCitationMarkers("That is not in my rulebook.")).toEqual([]);
  });

  it("ignores [0] and non-numeric brackets", () => {
    // [0] is not a valid 1-based passage marker; [x] is not a citation at all.
    expect(parseCitationMarkers("nope [0] [x] but [3] counts")).toEqual([3]);
  });
});

describe("citationValidity", () => {
  it("is 1.0 when every marker maps to a retrieved passage", () => {
    expect(citationValidity([1, 2], 3)).toBe(1);
  });

  it("is <1 when a marker exceeds the passage count (hallucinated citation)", () => {
    // [3] has no passage when only 2 were retrieved → half the markers are valid.
    expect(citationValidity([1, 3], 2)).toBe(0.5);
  });

  it("is 0 when the answer cites no passages at all", () => {
    expect(citationValidity([], 3)).toBe(0);
  });

  it("is 0 when there are no passages to cite", () => {
    expect(citationValidity([1], 0)).toBe(0);
  });
});

describe("tokenOverlap", () => {
  it("is high when the answer echoes the cited passage tokens", () => {
    const j = tokenOverlap("Each player starts with 1500", "Each player starts with 1500 dollars");
    expect(j).toBeGreaterThan(0.6);
  });

  it("is ~0 for disjoint text", () => {
    expect(tokenOverlap("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("ignores case and punctuation", () => {
    expect(tokenOverlap("Roll, doubles!", "roll doubles")).toBe(1);
  });

  it("is 0 for an empty answer", () => {
    expect(tokenOverlap("", "any passage text")).toBe(0);
  });
});

describe("hitRateAt", () => {
  it("is 1 when any expected id is in the top-k", () => {
    expect(hitRateAt(["a", "b", "c", "d", "e", "f"], ["x", "c"], 5)).toBe(1);
  });

  it("is 0 when no expected id is in the top-k", () => {
    // "f" is the 6th ranked id, outside the top-5 window.
    expect(hitRateAt(["a", "b", "c", "d", "e", "f"], ["f"], 5)).toBe(0);
  });

  it("is 0 with no expected ids", () => {
    expect(hitRateAt(["a", "b"], [], 5)).toBe(0);
  });
});

describe("recallAt", () => {
  it("is the fraction of expected ids found in the top-k", () => {
    // 2 of 4 expected ids ("a","c") are within the top-3 window.
    expect(recallAt(["a", "b", "c"], ["a", "c", "x", "y"], 20)).toBeCloseTo(0.5);
  });

  it("is 1 when all expected ids are within the window", () => {
    expect(recallAt(["a", "b", "c"], ["a", "b"], 20)).toBe(1);
  });

  it("is 0 with no expected ids", () => {
    expect(recallAt(["a", "b"], [], 20)).toBe(0);
  });
});

describe("precisionAt", () => {
  it("is the fraction of the top-k slots filled by an expected id", () => {
    // 1 expected id ("a") in a 5-slot window → 1/5.
    expect(precisionAt(["a", "b", "c", "d", "e"], ["a", "z"], 5)).toBeCloseTo(0.2);
  });

  it("divides by k even when fewer than k ids were retrieved", () => {
    // Only 2 retrieved, both expected: 2 hits / 5 slots → 0.4 (a short list cannot be precise@5).
    expect(precisionAt(["a", "b"], ["a", "b"], 5)).toBeCloseTo(0.4);
  });

  it("is 0 with no expected ids", () => {
    expect(precisionAt(["a", "b"], [], 5)).toBe(0);
  });
});
