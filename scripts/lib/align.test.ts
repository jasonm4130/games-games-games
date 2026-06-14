import { describe, expect, it } from "vitest";
import { acceptHeal, alignmentInsertions } from "./align";

describe("alignmentInsertions", () => {
  it("is zero when healed is a subsequence of raw (pure deletion: spaced-caps collapse)", () => {
    expect(alignmentInsertions("K L A U S", "KLAUS")).toBe(0);
  });
  it("counts inserted characters for fabricated content", () => {
    expect(alignmentInsertions("roll the dice", "roll the dice and win instantly")).toBeGreaterThan(
      10,
    );
  });
});

describe("acceptHeal", () => {
  it("accepts identical text", () => {
    expect(acceptHeal("Pay $200.", "Pay $200.").accepted).toBe(true);
  });
  it("accepts a small casing/punctuation fix", () => {
    expect(acceptHeal("pay $200", "Pay $200.").accepted).toBe(true);
  });
  it("accepts a spaced-caps collapse (deletion only)", () => {
    expect(acceptHeal("S E T U P phase", "SETUP phase").accepted).toBe(true);
  });
  it("rejects a fabricated sentence (insertion over tolerance)", () => {
    const raw = "Move your token clockwise.";
    const healed = "Move your token clockwise. You may also teleport once per game.";
    expect(acceptHeal(raw, healed).accepted).toBe(false);
  });
  it("rejects gross growth without running LCS", () => {
    expect(acceptHeal("short", `short ${"x".repeat(100)}`).accepted).toBe(false);
  });
});
