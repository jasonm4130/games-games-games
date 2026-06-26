import { describe, expect, it } from "vitest";
import { charPreservationRatio, extractNumbers, missingNumbers } from "./preserve";

describe("extractNumbers", () => {
  it("extracts currency and plain numbers, comma-normalized", () => {
    expect(extractNumbers("Each player gets $1,500 and rolls 2 dice")).toEqual(["1500", "2"]);
  });
});

describe("missingNumbers", () => {
  it("is empty when all raw numbers survive", () => {
    expect(missingNumbers("collect $200 at GO", "You collect $200 when passing GO")).toEqual([]);
  });
  it("flags a dropped or mutated number", () => {
    expect(missingNumbers("start with $1500", "start with $150")).toEqual(["1500"]);
  });
});

describe("charPreservationRatio", () => {
  it("is 1 for identical text", () => {
    expect(charPreservationRatio("abc", "abc")).toBe(1);
  });
  it("is high for a minor fix and low for a rewrite", () => {
    // A 1-char fix on an 8-char string scores 1 - 1/9 ≈ 0.889; the operational gate
    // (Task 7 --min-preservation) is 0.85, and real sections are far longer, so legit fixes ≈ 1.
    expect(charPreservationRatio("Pay $200", "Pay $200.")).toBeGreaterThan(0.85);
    expect(charPreservationRatio("Pay $200", "Completely different text here")).toBeLessThan(0.5);
  });
});
