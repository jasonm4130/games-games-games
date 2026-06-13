# Retrieval Tuning (Stop Over-Refusing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rules Goblin answer loosely-worded questions whose concept is in the rulebook (e.g. "prison" -> "jail") instead of falsely replying "That is not in my rulebook."

**Architecture:** Move the relevance decision from a raw bge-m3 cosine floor (applied *before* the reranker) to the bge-reranker-base cross-encoder's own score (applied *after* it). The cosine floor drops to a permissive noise bound so synonym matches survive to the reranker; a new `RERANK_MIN_SCORE` becomes the real in-scope gate. The system prompt is softened to honour synonyms. Cross-game isolation is unaffected — that's the Vectorize `game_id` filter, not the floor.

**Tech Stack:** Cloudflare Workers, Workers AI (`@cf/baai/bge-reranker-base`), Vitest (Workers pool), TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-14-goblin-voice-and-retrieval-tuning-design.md` (Feature A).

**Calibration evidence (probed against the live index, 2026-06-14):** for the query *"how do I get out of prison"* against Monopoly — the correct Jail passage scored cosine **0.555** while an unrelated rent rule scored cosine **0.583** (cosine mis-ranks!); the reranker scored the Jail passage **0.841** and every other candidate **<= 0.0004**. Workers AI returns the reranker score already sigmoid-normalised to [0,1]. Hence: cosine floor **0.15** (keeps the 0.555 Jail chunk comfortably), rerank gate **0.20** (sits in the 0.84<->0.0004 gap).

---

## File Structure

- `src/server/rag/models.ts` — retrieval constants. Lower `RETRIEVAL_MIN_SCORE`; add `RERANK_MIN_SCORE`; rewrite the calibration comment.
- `src/server/rag/retrieve.ts` — the gate logic: always rerank survivors, keep those at/above `RERANK_MIN_SCORE`.
- `src/server/rag/retrieve.test.ts` — extend the test harness with custom reranker scores; add gate tests.
- `src/server/agent.ts` — soften the refusal instruction in `SYSTEM_PROMPT`.

---

## Task 1: Branch and commit the planning docs

**Files:**
- Commit: `docs/superpowers/specs/2026-06-14-goblin-voice-and-retrieval-tuning-design.md`, `docs/superpowers/plans/2026-06-14-retrieval-tuning.md`

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git checkout -b feat/retrieval-tuning
```

- [ ] **Step 2: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-06-14-goblin-voice-and-retrieval-tuning-design.md \
        docs/superpowers/plans/2026-06-14-retrieval-tuning.md
git commit -m "docs: spec + plan for retrieval tuning"
```

---

## Task 2: Adjust retrieval constants

**Files:**
- Modify: `src/server/rag/models.ts:28-43`

- [ ] **Step 1: Replace the cosine-floor constant + comment and add the rerank gate**

Replace the block at `src/server/rag/models.ts:28-43` (the `RETRIEVAL_MIN_SCORE` doc-comment through `RETRIEVAL_FETCH_N`) with:

```ts
/**
 * Permissive noise bound on the raw bge-m3 cosine score. Drop clear garbage cheaply before the
 * reranker, but DO NOT use cosine as the relevance judge - it ranks badly on this corpus. Probed
 * 2026-06-14 with "how do I get out of prison" against the live Monopoly index: the correct Jail
 * passage scored cosine 0.555 while an UNRELATED rent rule scored 0.583 (higher!). Cosine alone
 * mis-ranks; the cross-encoder (RERANK_MIN_SCORE) is the judge. Cross-game isolation is the
 * Vectorize game_id filter (retrieve.ts), not this floor - lowering it cannot reintroduce leakage.
 */
export const RETRIEVAL_MIN_SCORE = 0.15;

/**
 * In-scope gate on the cross-encoder relevance score (sigmoid-normalised to [0,1] by Workers AI).
 * After reranking, passages below this are dropped; if none clear it, Retrieval returns [] and the
 * agent gives its "not covered" reply. THIS, not the cosine floor, decides whether the rulebook
 * answers the question.
 *
 * Calibrated 2026-06-14 against the live Monopoly index with the synonym query "how do I get out of
 * prison": the Jail passage reranked to 0.841, every other candidate to <= 0.0004 - a clean gap.
 * 0.2 sits deep inside it, keeping strong + secondary matches while rejecting noise. (This query
 * previously hit the canned refusal: the old 0.55 cosine floor sat right on the Jail chunk's 0.555
 * score and the reranker was never used as a gate.)
 */
export const RERANK_MIN_SCORE = 0.2;

export const RETRIEVAL_TOP_K = 5;
/** Over-fetch count: how many Vectorize candidates to pull before the reranker narrows to RETRIEVAL_TOP_K. */
export const RETRIEVAL_FETCH_N = 20;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS (no type or lint errors). `RERANK_MIN_SCORE` is exported but not yet imported anywhere — that is fine (unused *exports* are not errors).

- [ ] **Step 3: Commit**

```bash
git add src/server/rag/models.ts
git commit -m "feat(rag): lower cosine floor to a noise bound, add reranker-score gate constant"
```

---

## Task 3: Gate retrieval on the reranker score (TDD)

**Files:**
- Test: `src/server/rag/retrieve.test.ts`
- Modify: `src/server/rag/retrieve.ts`

- [ ] **Step 1: Extend the test harness and add failing gate tests**

In `src/server/rag/retrieve.test.ts`, update the import on line 2 to include the new constant:

```ts
import { RERANK_MODEL, RERANK_MIN_SCORE, RETRIEVAL_MIN_SCORE } from "./models";
```

Replace the `build(...)` function (lines 48-69) with this version, which lets a test supply custom reranker scores (default stays the identity mock, so existing tests are unchanged):

```ts
function build(opts: {
  matches: Array<{ id: string; score: number }>;
  rows: HydratedRow[];
  rerank?: (contexts: unknown[]) => Array<{ id: number; score: number }>;
}) {
  hoisted.rows = opts.rows;
  // env.AI.run serves two models: bge-m3 embeddings ({ data }) and the reranker ({ response }).
  // Default reranker mock is identity (ids in input order, descending scores near 1) so order is
  // preserved and the gate passes; a test may override via opts.rerank to exercise the gate.
  const aiRun = vi.fn(async (model: string, input: unknown) => {
    if (model === RERANK_MODEL) {
      const { contexts } = input as { contexts: unknown[] };
      const response = opts.rerank
        ? opts.rerank(contexts)
        : contexts.map((_, i) => ({ id: i, score: 1 - i * 0.01 }));
      return { response };
    }
    return { data: [[0.1, 0.2, 0.3]] };
  });
  const query = vi.fn(async (_vector: number[], _options: unknown) => ({
    matches: opts.matches,
    count: opts.matches.length,
  }));
  const env = {
    AI: { run: aiRun },
    RULES_IDX: { query },
  } as unknown as Env;
  return { env, aiRun, query };
}
```

Append these four tests inside the `describe("retrieve", …)` block (before its closing `});`):

```ts
  it("scores a lone survivor through the reranker (no single-survivor skip)", async () => {
    const { env, aiRun } = build({ matches: [{ id: "c1", score: 0.9 }], rows: [row("c1")] });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
    expect(aiRun).toHaveBeenCalledWith(RERANK_MODEL, expect.objectContaining({ query: "q" }));
  });

  it("drops a reranked passage that scores below the rerank gate", async () => {
    const { env } = build({
      matches: [
        { id: "c1", score: 0.9 },
        { id: "c2", score: 0.9 },
      ],
      rows: [row("c1"), row("c2")],
      rerank: () => [
        { id: 0, score: RERANK_MIN_SCORE + 0.1 },
        { id: 1, score: RERANK_MIN_SCORE - 0.1 },
      ],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
  });

  it("returns [] when every reranked passage is below the gate", async () => {
    const { env } = build({
      matches: [{ id: "c1", score: 0.9 }],
      rows: [row("c1")],
      rerank: () => [{ id: 0, score: RERANK_MIN_SCORE - 0.01 }],
    });
    expect(await retrieve(env, "q", { gameId: "g1" })).toEqual([]);
  });

  it("lets a weak-cosine synonym match reach the reranker, which rescues it", async () => {
    // 0.40 is below the old 0.55 floor but above the new noise bound — proving the reranker,
    // not the cosine floor, is now the judge.
    const { env } = build({
      matches: [{ id: "c1", score: 0.4 }],
      rows: [row("c1")],
      rerank: () => [{ id: 0, score: RERANK_MIN_SCORE + 0.2 }],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm test retrieve`
Expected: FAIL. The "lone survivor" test fails because current `retrieve.ts:87` returns early without calling the reranker; the gate tests fail because current code never filters by reranker score.

- [ ] **Step 3: Implement the gate in `retrieve.ts`**

Add `RERANK_MIN_SCORE` to the import on `src/server/rag/retrieve.ts:6`:

```ts
import { RERANK_MIN_SCORE, RERANK_MODEL, RETRIEVAL_FETCH_N, RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K } from "./models";
```

Replace the comment on line 42 (`// Grounding floor: weak matches…`) with:

```ts
  // Noise bound: drop obviously-unrelated candidates cheaply before the reranker. This is a
  // permissive floor, NOT the relevance judge — the cross-encoder below decides what grounds a
  // Ruling. (Cross-game isolation is the game_id filter above, not this floor.)
```

Replace everything from line 86 to the end of the function (the `// Rerank survivors…` comment, the `survivors.length <= 1` early return, the `env.AI.run` call, and the final `return reranked.response.flatMap(...)`) with:

```ts
  if (survivors.length === 0) return [];

  // Rerank with a cross-encoder and gate on its relevance score. The reranker judges the
  // (query, passage) pair together, so it handles synonyms/paraphrase the embedding floor can't.
  // It returns results best-first; keep those at/above RERANK_MIN_SCORE.
  //
  // The generated type for bge-reranker-base omits `query` and marks output fields optional;
  // cast through unknown so tsc accepts the correct runtime shape.
  const reranked = (await (
    env.AI.run as (m: string, i: Record<string, unknown>) => Promise<unknown>
  )(RERANK_MODEL, {
    query,
    contexts: survivors.map((c) => ({ text: c.chunk.text })),
    top_k: Math.min(RETRIEVAL_TOP_K, survivors.length),
  })) as { response: { id: number; score: number }[] };

  return reranked.response
    .filter(({ score }) => score >= RERANK_MIN_SCORE)
    .flatMap(({ id }) => {
      const chunk = survivors[id];
      return chunk ? [chunk] : [];
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test retrieve`
Expected: PASS — all existing cases plus the four new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/rag/retrieve.ts src/server/rag/retrieve.test.ts
git commit -m "feat(rag): gate retrieval on reranker score so synonyms reach the cross-encoder"
```

---

## Task 4: Soften the system prompt

**Files:**
- Modify: `src/server/agent.ts:35`

- [ ] **Step 1: Replace the refusal instruction**

In `src/server/agent.ts`, replace the second "Hard rules" bullet (line 35), currently:

```ts
- Never invent a rule. If the passages do not cover the question, say so decisively and in character — "That is not in my rulebook." — then stop. Do not guess, extrapolate, or suggest house rules.
```

with:

```ts
- Never invent a rule. Read the player's wording loosely: if a passage covers the same concept under a different name (e.g. "prison" for "jail", "turn order" for "who goes first"), answer from it. Only when no passage addresses the question at all, say so decisively and in character — "That is not in my rulebook." — then stop. Never guess, extrapolate, or suggest house rules.
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/agent.ts
git commit -m "feat(agent): allow the goblin to answer synonym/paraphrase questions"
```

---

## Task 5: Live behavioural smoke check (best-effort, non-blocking)

Thresholds were already calibrated against the live index *before* implementation (see "Calibration evidence" above and the comment in `models.ts`), so this is a confirmation, not a from-scratch calibration. It needs the live index (Workers AI + Vectorize hit the network), so it is an integration check, not a unit test — it does **not** block the PR.

- [ ] **Step 1: Run the app**

Run: `pnpm dev`

- [ ] **Step 2: Confirm the synonym now answers**

Select **Monopoly**, ask `how do I get out of prison`.
Expected: a real ruling citing the Jail rule — NOT "That is not in my rulebook."

- [ ] **Step 3: Confirm genuine misses still refuse**

Ask `what is the best pizza topping`.
Expected: "That is not in my rulebook."

- [ ] **Step 4: Adjust only if needed**

If Step 2 still refuses, lower `RERANK_MIN_SCORE` (or `RETRIEVAL_MIN_SCORE`) toward the observed values and re-run; if Step 3 answers, raise `RERANK_MIN_SCORE`. Given the measured 0.841 vs 0.0004 gap, the committed 0.2/0.15 should already pass both.

---

## Task 6: Full verification and PR

- [ ] **Step 1: Run the full checks**

Run: `pnpm check && pnpm test && pnpm build`
Expected: all three pass. Quote the passing test summary line and the build success line.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/retrieval-tuning
gh pr create --title "Stop the goblin over-refusing synonym questions" --body "$(cat <<'EOF'
## Summary
- Lower the bge-m3 cosine floor to a permissive noise bound (it was discarding / mis-ranking synonym matches before the reranker could judge them).
- Gate retrieval on the bge-reranker-base cross-encoder score (new RERANK_MIN_SCORE) — the cross-encoder handles "prison" vs "jail".
- Always rerank survivors (removed the single-survivor skip) so even one candidate is scored against the gate.
- Soften the system prompt to honour synonyms/paraphrase while keeping the no-invented-rules guarantee.

## Calibration (probed against the live Monopoly index)
For "how do I get out of prison": the Jail passage scored cosine 0.555 (an unrelated rent rule scored 0.583 — higher), but reranked to 0.841 vs <= 0.0004 for everything else. Floor 0.15, gate 0.20.

## Testing
- `pnpm check`, `pnpm test`, `pnpm build` green.
- Manual: "how do I get out of prison" now answers with a Jail citation; an off-topic question still returns "That is not in my rulebook."

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage (Feature A):** lower cosine floor → Task 2; reranker-score gate → Task 2 (constant) + Task 3 (logic); always-score survivors → Task 3; soften prompt → Task 4; calibration → done via probe, recorded in Task 2 comment + confirmed in Task 5; tests → Task 3; success criteria (`pnpm check`/`test`/`build`, prison answers, off-topic refuses) → Tasks 5–6. No gaps.
- **Placeholders:** none — every code step shows the exact code; the constants are final calibrated values, not provisional.
- **Type consistency:** `RERANK_MIN_SCORE` is defined in Task 2 and imported identically in `retrieve.ts` (Task 3) and `retrieve.test.ts` (Task 3). The reranker response shape `{ id: number; score: number }[]` matches the existing cast and the test mock.
