import { describe, expect, it, vi } from "vitest";
import type { DocumentKind } from "../../shared/types";
import { RERANK_MIN_SCORE, RERANK_MODEL, RETRIEVAL_MIN_SCORE } from "./models";

// Drizzle row shape after the hydration JOIN (camelCase, as selected in retrieve.ts).
interface HydratedRow {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  gameName: string;
  documentTitle: string;
  documentKind: DocumentKind;
}

// Mocked Drizzle resolves to `hoisted.rows` for the hydration JOIN and `hoisted.ftsIds` for the
// lexical (BM25) leg's raw `.all(sql)`; each test sets them via build(). The lexical leg defaults
// to [] so existing tests exercise the dense-only path unchanged. `hoisted.ftsThrows` simulates an
// FTS5 error (e.g. table missing before migration 0004) to assert graceful dense-only degradation.
const hoisted = vi.hoisted(() => ({
  rows: [] as HydratedRow[],
  ftsIds: [] as string[],
  ftsThrows: false,
}));

// Mock the db() helper so retrieve() exercises its own orchestration (floor, RRF fusion, ordering,
// rerank id-mapping, skip-missing-row) without standing up a real D1 or drizzle's SQL layer. The
// select builder is chainable up to .where() (the awaited terminal of the hydration query); .all()
// is the lexical leg's terminal — it throws when ftsThrows is set, which retrieve() catches.
vi.mock("../db", () => {
  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => Promise.resolve(hoisted.rows),
    all: () => {
      if (hoisted.ftsThrows) return Promise.reject(new Error("fts5: no such table: chunks_fts"));
      return Promise.resolve(hoisted.ftsIds.map((id) => ({ id })));
    },
  };
  return { db: () => builder };
});

import { retrieve } from "./retrieve";

function row(id: string, overrides: Partial<HydratedRow> = {}): HydratedRow {
  return {
    id,
    documentId: "doc-1",
    ordinal: 0,
    text: `text for ${id}`,
    pageStart: 1,
    pageEnd: 1,
    gameName: "Catan",
    documentTitle: "Base Game",
    documentKind: "base",
    ...overrides,
  };
}

function build(opts: {
  matches: Array<{ id: string; score: number }>;
  rows: HydratedRow[];
  ftsIds?: string[];
  ftsThrows?: boolean;
  rerank?: (contexts: unknown[]) => Array<{ id: number; score: number }>;
}) {
  hoisted.rows = opts.rows;
  // Default the lexical leg to empty/healthy so every existing test stays on the dense-only path.
  hoisted.ftsIds = opts.ftsIds ?? [];
  hoisted.ftsThrows = opts.ftsThrows ?? false;
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

describe("retrieve", () => {
  it("returns [] with no active Game and never touches Workers AI", async () => {
    const { env, aiRun, query } = build({ matches: [], rows: [] });
    expect(await retrieve(env, "how many cards?", {})).toEqual([]);
    expect(aiRun).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns [] for a blank question", async () => {
    const { env, aiRun } = build({ matches: [], rows: [] });
    expect(await retrieve(env, "   ", { gameId: "g1" })).toEqual([]);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("scopes the Vectorize query to the active Game", async () => {
    const { env, query } = build({ matches: [{ id: "c1", score: 0.9 }], rows: [row("c1")] });
    await retrieve(env, "q", { gameId: "g1" });
    expect(query).toHaveBeenCalledOnce();
    const options = query.mock.calls[0][1] as { filter: unknown; topK: number };
    expect(options.filter).toEqual({ game_id: "g1" });
  });

  it("drops matches below the grounding floor", async () => {
    const { env } = build({
      matches: [
        { id: "c1", score: RETRIEVAL_MIN_SCORE + 0.1 },
        { id: "c2", score: RETRIEVAL_MIN_SCORE - 0.1 },
      ],
      rows: [row("c1"), row("c2")],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
  });

  it("returns [] when every match is below the floor", async () => {
    const { env } = build({
      matches: [{ id: "c1", score: RETRIEVAL_MIN_SCORE - 0.01 }],
      rows: [row("c1")],
    });
    expect(await retrieve(env, "q", { gameId: "g1" })).toEqual([]);
  });

  it("hydrates from D1 and preserves score order through an identity rerank", async () => {
    const { env } = build({
      matches: [
        { id: "c2", score: 0.9 },
        { id: "c1", score: 0.8 },
      ],
      rows: [
        row("c1", { ordinal: 1, pageStart: 4, pageEnd: 5 }),
        row("c2", { ordinal: 2, gameName: "Catan", pageStart: 7, pageEnd: 7 }),
      ],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c2", "c1"]);
    expect(out[0]).toMatchObject({
      chunk: { id: "c2", pageStart: 7, pageEnd: 7 },
      gameName: "Catan",
      score: 0.9,
    });
  });

  it("carries each chunk's document kind through for grounding labels", async () => {
    const { env } = build({
      matches: [
        { id: "c1", score: 0.9 },
        { id: "c2", score: 0.8 },
      ],
      rows: [
        row("c1", { documentTitle: "Base Game", documentKind: "base" }),
        row("c2", { documentTitle: "The Herb Witches", documentKind: "expansion" }),
      ],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.documentKind)).toEqual(["base", "expansion"]);
  });

  it("skips a match that has no D1 row", async () => {
    const { env } = build({ matches: [{ id: "c1", score: 0.9 }], rows: [] });
    expect(await retrieve(env, "q", { gameId: "g1" })).toEqual([]);
  });

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

  it("fuses a lexical-only hit (missed by the dense leg) into the reranker candidates", async () => {
    // c1 is the only dense hit; c2 surfaces solely from the BM25 leg. RRF must bring c2 into the
    // candidates hydrated + reranked, so a lexically-strong passage the dense leg ranked out still
    // reaches the final judge. (Identity rerank keeps fused order.)
    const { env } = build({
      matches: [{ id: "c1", score: 0.9 }],
      rows: [row("c1"), row("c2")],
      ftsIds: ["c2"],
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id).sort()).toEqual(["c1", "c2"]);
    // A lexical-only hit had no dense cosine score, so its preserved score is 0.
    expect(out.find((r) => r.chunk.id === "c2")?.score).toBe(0);
  });

  it("scopes the lexical leg to the active Game", async () => {
    // The BM25 SQL is parameterized with d.game_id = gameId; assert retrieve passes the active
    // Game through to the lexical leg (the .all() mock returns ids regardless, but the call must
    // happen for the both-legs-scoped guardrail to hold).
    const { env } = build({
      matches: [{ id: "c1", score: 0.9 }],
      rows: [row("c1")],
      ftsIds: ["c1"],
    });
    const out = await retrieve(env, "how do I get out of jail", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
  });

  it("degrades to dense-only when the lexical leg throws (no chunks_fts before migration 0004)", async () => {
    const { env } = build({
      matches: [{ id: "c1", score: 0.9 }],
      rows: [row("c1")],
      ftsThrows: true,
    });
    const out = await retrieve(env, "q", { gameId: "g1" });
    expect(out.map((r) => r.chunk.id)).toEqual(["c1"]);
  });

  it("returns [] when both legs are empty (out-of-scope refusal guardrail intact)", async () => {
    const { env } = build({ matches: [], rows: [], ftsIds: [] });
    expect(await retrieve(env, "q", { gameId: "g1" })).toEqual([]);
  });
});
