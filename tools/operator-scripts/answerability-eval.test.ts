import { describe, expect, it } from "vitest";
import { groupStats, parseVerdict } from "./answerability-eval";

describe("parseVerdict", () => {
  it("checks UNANSWERABLE before ANSWERABLE (substring trap)", () => {
    expect(parseVerdict("UNANSWERABLE")).toBe("no");
    expect(parseVerdict("  unanswerable.")).toBe("no");
    expect(parseVerdict("The answer is UNANSWERABLE")).toBe("no");
  });
  it("maps the other verdicts", () => {
    expect(parseVerdict("ANSWERABLE")).toBe("yes");
    expect(parseVerdict("partial")).toBe("partial");
    expect(parseVerdict('"Partial"')).toBe("partial");
  });
  it("returns null when no keyword present", () => {
    expect(parseVerdict("I think maybe")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("groupStats", () => {
  it("answerable group: yes/partial are correct, no is wrong; null excluded from rate", () => {
    const s = groupStats(["yes", "partial", "no", null], true);
    expect(s.n).toBe(4);
    expect(s.unparseable).toBe(1);
    expect(s.correctRate).toBeCloseTo(2 / 3); // 2 correct of 3 parsed
    expect([s.yes, s.partial, s.no]).toEqual([1, 1, 1]);
  });
  it("unanswerable group: only no is correct", () => {
    const s = groupStats(["no", "no", "yes", "partial"], false);
    expect(s.correctRate).toBeCloseTo(2 / 4);
  });
  it("NaN rate when every reply is unparseable", () => {
    expect(groupStats([null, null], true).correctRate).toBeNaN();
  });
});
