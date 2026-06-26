/** Deterministic preservation checks for the heal/validate gate. Pure. */
import { alignmentInsertions } from "./align";

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;

/** All numbers in `text`, commas stripped (so "$1,500" and "1500" compare equal). */
export function extractNumbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/[$,]/g, ""));
}

/** Numbers present in `raw` but missing from `healed` (multiset difference). */
export function missingNumbers(raw: string, healed: string): string[] {
  const have = new Map<string, number>();
  for (const n of extractNumbers(healed)) have.set(n, (have.get(n) ?? 0) + 1);
  const missing: string[] = [];
  for (const n of extractNumbers(raw)) {
    const c = have.get(n) ?? 0;
    if (c > 0) have.set(n, c - 1);
    else missing.push(n);
  }
  return missing;
}

/** 1 - (insertions / healed length). 1 means healed adds nothing relative to raw. */
export function charPreservationRatio(raw: string, healed: string): number {
  if (healed.length === 0) return raw.length === 0 ? 1 : 0;
  return 1 - alignmentInsertions(raw, healed) / healed.length;
}
