// Pure metrics for the EVAL HARNESS (GAP 2). Two families, both side-effect-free so they unit-test
// in the workers pool and the operator scripts can import them:
//   - retrieval quality (Hit-Rate@k, Recall@k, Precision@k) over ranked chunk-id lists vs a gold set;
//   - generation groundedness (citation-marker validity + answer↔passage token overlap) as a cheap
//     heuristic for the llama-vs-gemma answer compare. These are HEURISTICS for a human to read, not
//     a gate — they flag obviously-ungrounded answers, they do not certify correctness.

/** Extract the distinct `[N]` citation markers from an answer, 1-based, deduped and sorted. */
export function parseCitationMarkers(answer: string): number[] {
  const markers = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    // Only 1-based markers are valid passage references; [0] is never a passage.
    if (n >= 1) markers.add(n);
  }
  return [...markers].sort((a, b) => a - b);
}

/**
 * Fraction of an answer's citation markers that point at a real retrieved passage (1..passageCount).
 * 1.0 = every `[N]` maps to a passage; <1 = some markers are out of range (hallucinated citations).
 * 0 when the answer cites nothing or nothing was retrieved — both mean "ungrounded".
 */
export function citationValidity(markers: number[], passageCount: number): number {
  if (markers.length === 0 || passageCount === 0) return 0;
  const valid = markers.filter((n) => n <= passageCount).length;
  return valid / markers.length;
}

/** Lowercased alphanumeric content tokens (the bag used for the overlap heuristic). */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
}

/**
 * Jaccard overlap of content tokens between an answer and the passages it draws on — a cheap proxy
 * for "is the answer's vocabulary actually in the source". 1 = identical token sets, 0 = disjoint
 * (or an empty answer). Not a correctness measure; a low value flags an answer that doesn't echo its
 * grounding for a human to inspect.
 */
export function tokenOverlap(answer: string, passages: string): number {
  const a = new Set(tokens(answer));
  const b = new Set(tokens(passages));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Top-k slice of a ranked id-list (k may exceed the list length). */
function topK(ranked: string[], k: number): string[] {
  return ranked.slice(0, k);
}

/** Hit-Rate@k: 1 if ANY expected id appears in the top-k of the ranked list, else 0. */
export function hitRateAt(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const window = new Set(topK(ranked, k));
  return expected.some((id) => window.has(id)) ? 1 : 0;
}

/** Recall@k: fraction of the expected ids that appear in the top-k of the ranked list. */
export function recallAt(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const window = new Set(topK(ranked, k));
  const found = expected.filter((id) => window.has(id)).length;
  return found / expected.length;
}

/**
 * Precision@k: expected ids in the top-k, over k slots (NOT over the retrieved count) — so a list
 * shorter than k cannot score a perfect precision, matching the standard definition.
 */
export function precisionAt(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  const hits = topK(ranked, k).filter((id) => expectedSet.has(id)).length;
  return hits / k;
}

/**
 * MRR@k (per-query reciprocal rank): 1 / (1-based rank of the FIRST expected id within the top-k),
 * or 0 if none appear. Hit-Rate@k scores a hit at rank 1 and rank k identically; MRR rewards ranking
 * the answer-bearing passage HIGHER — the signal that decides whether it lands in the few passages the
 * model actually reads.
 */
export function mrrAt(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  const window = topK(ranked, k);
  for (let i = 0; i < window.length; i++) {
    const id = window[i];
    if (id !== undefined && expectedSet.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with BINARY relevance (an id is relevant iff it's in `expected`). DCG = Σ rel_i / log2(rank+1)
 * over the top-k (rank 1-based); IDCG is the same sum for the ideal ordering (all relevant items first,
 * capped at k). Returns DCG/IDCG in [0,1]; 0 when nothing relevant is retrieved. Captures graded ranking
 * quality across the whole top-k, where Hit-Rate sees only "any hit" and MRR only the first.
 */
export function ndcgAt(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  const window = topK(ranked, k);
  const counted = new Set<string>();
  let dcg = 0;
  for (let i = 0; i < window.length; i++) {
    const id = window[i];
    // i is 0-based → rank i+1 → discount log2((i+1)+1) = log2(i+2). Count each relevant id once: a
    // duplicate in the ranked list must not push DCG above the ideal IDCG (keeps nDCG ≤ 1).
    if (id !== undefined && expectedSet.has(id) && !counted.has(id)) {
      counted.add(id);
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealHits = Math.min(expected.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Collapse whitespace + lowercase — matches eval.ts's gold-resolution normalize so a cited passage and
 *  an expected snippet compare the same way. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Citation-attribution precision: of the passages an answer actually CITED ([N] → passages[N-1]), the
 * fraction whose text contains at least one expected answer snippet. Hit-Rate/Precision measure whether
 * RETRIEVAL surfaced the right chunk; this measures whether the GENERATOR cited it — catching answers
 * that retrieve well but attribute the claim to the wrong passage. 0 when nothing was cited or no
 * expected snippet is given; > 0 means at least one citation pointed at a genuinely answer-bearing passage.
 */
export function citationAttributionPrecision(
  citedPassages: string[],
  expectedTextIncludes: string[],
): number {
  if (citedPassages.length === 0 || expectedTextIncludes.length === 0) return 0;
  const needles = expectedTextIncludes.map(normalizeText).filter((n) => n.length > 0);
  if (needles.length === 0) return 0;
  const hits = citedPassages.filter((p) => {
    const hay = normalizeText(p);
    return needles.some((n) => hay.includes(n));
  }).length;
  return hits / citedPassages.length;
}
