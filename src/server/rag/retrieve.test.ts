import { describe, expect, it, vi } from "vitest";
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
}

// Rows the mocked Drizzle query resolves to; each test sets `hoisted.rows` via build().
const hoisted = vi.hoisted(() => ({ rows: [] as HydratedRow[] }));

// Mock the db() helper so retrieve() exercises its own orchestration (floor, ordering, rerank
// id-mapping, skip-missing-row) without standing up a real D1 or drizzle's SQL layer. The
// builder is chainable up to .where(), which is the awaited terminal in retrieve().
vi.mock("../db", () => {
  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => Promise.resolve(hoisted.rows),
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
    ...overrides,
  };
}

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
});
