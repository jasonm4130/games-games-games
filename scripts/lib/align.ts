/** Character-level alignment guardrail for the heal pass. Pure, dependency-free. */

/** Length of the longest common subsequence of a and b (O(min) space). */
function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array(short.length + 1).fill(0);
  for (let i = 0; i < long.length; i++) {
    const curr = new Array(short.length + 1).fill(0);
    for (let j = 0; j < short.length; j++) {
      curr[j + 1] = long[i] === short[j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    prev = curr;
  }
  return prev[short.length];
}

/** Characters present in `healed` that are NOT part of a common subsequence with `raw`. */
export function alignmentInsertions(raw: string, healed: string): number {
  return healed.length - lcsLength(raw, healed);
}

export interface HealVerdict {
  accepted: boolean;
  insertions: number;
  reason: string;
}

export interface AcceptHealOptions {
  /** Reject before LCS if healed grows beyond this fraction of raw length. */
  maxGrowth?: number;
  /** Reject if healed shrinks beyond this fraction of raw length (model dropped content). */
  maxShrink?: number;
  /** Per-section absolute insertion tolerance (casing/punctuation fixes). */
  baseTolerance?: number;
  /** Plus this fraction of raw length, for legitimate small edits in longer sections. */
  toleranceRatio?: number;
}

/** Decide whether a healed section is a faithful correction of raw (else keep raw). */
export function acceptHeal(raw: string, healed: string, opts: AcceptHealOptions = {}): HealVerdict {
  const maxGrowth = opts.maxGrowth ?? 0.15;
  const maxShrink = opts.maxShrink ?? 0.4;
  const baseTolerance = opts.baseTolerance ?? 8;
  const toleranceRatio = opts.toleranceRatio ?? 0.02;

  if (healed.length > raw.length * (1 + maxGrowth)) {
    return {
      accepted: false,
      insertions: healed.length - raw.length,
      reason: "exceeds max growth",
    };
  }
  // LCS only measures INSERTIONS, so a heal that drops/summarizes whole passages (a real failure mode
  // when the model condenses instead of fixing) would otherwise pass as "few insertions". A faithful
  // word/spacing fix barely changes length, so reject any heal that shrinks beyond tolerance and keep
  // raw. Guard against a legitimately tiny section (raw shorter than baseTolerance) tripping this.
  if (raw.length > baseTolerance && healed.length < raw.length * (1 - maxShrink)) {
    return {
      accepted: false,
      insertions: healed.length - raw.length,
      reason: "exceeds max shrink",
    };
  }
  const insertions = alignmentInsertions(raw, healed);
  const tolerance = Math.max(baseTolerance, Math.floor(raw.length * toleranceRatio));
  return insertions <= tolerance
    ? { accepted: true, insertions, reason: "within tolerance" }
    : { accepted: false, insertions, reason: `insertions ${insertions} > tolerance ${tolerance}` };
}
