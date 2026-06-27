import { describe, expect, it } from "vitest";
import { percentile, sweepRow } from "./rerank-calibrate";

describe("percentile", () => {
  it("returns NaN on empty, exact ends, nearest-rank middle", () => {
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([0.1, 0.2, 0.3, 0.4], 0)).toBe(0.1);
    expect(percentile([0.1, 0.2, 0.3, 0.4], 1)).toBe(0.4);
    expect(percentile([0.1, 0.2, 0.3, 0.4], 0.5)).toBe(0.2); // ceil(0.5*4)-1 = idx 1
  });
});

describe("sweepRow", () => {
  const inScope = [
    { targetScore: 0.9, targetInCandidates: true }, // strong match
    { targetScore: 0.04, targetInCandidates: true }, // weak paraphrase match
    { targetScore: Number.NEGATIVE_INFINITY, targetInCandidates: false }, // retrieval miss — excluded
  ];
  const oos = [0.99, 0.2, 0.01]; // one irrelevant chunk scores high (the calibration problem)

  it("excludes retrieval misses from the false-refusal denominator", () => {
    const r = sweepRow(0.05, inScope, oos);
    // gateable = 2 rows; the 0.04 target is below 0.05 → 1 refused of 2
    expect(r.falseRefusal).toBeCloseTo(0.5);
    // OOS ≥ 0.05 → 0.99 and 0.2 clear → 2 of 3
    expect(r.falseAccept).toBeCloseTo(2 / 3);
  });

  it("a high cutoff refuses more in-scope and accepts less OOS", () => {
    const r = sweepRow(0.5, inScope, oos);
    expect(r.falseRefusal).toBeCloseTo(0.5); // 0.04 still below; 0.9 still above
    expect(r.falseAccept).toBeCloseTo(1 / 3); // only 0.99 clears
  });

  it("NaN error rates when a side is empty", () => {
    expect(sweepRow(0.05, [], oos).falseRefusal).toBeNaN();
    expect(sweepRow(0.05, inScope, []).falseAccept).toBeNaN();
  });
});
