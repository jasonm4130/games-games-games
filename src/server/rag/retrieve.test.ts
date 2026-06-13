import { describe, expect, it, vi } from "vitest";
import { RETRIEVAL_MIN_SCORE } from "./models";
import { retrieve } from "./retrieve";

interface FakeRow {
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  page_start: number | null;
  page_end: number | null;
  game_name: string;
}

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    document_id: "doc-1",
    ordinal: 0,
    text: `text for ${id}`,
    page_start: 1,
    page_end: 1,
    game_name: "Catan",
    ...overrides,
  };
}

function build(opts: { matches: Array<{ id: string; score: number }>; rows: FakeRow[] }) {
  const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] }));
  const query = vi.fn(async (_vector: number[], _options: unknown) => ({
    matches: opts.matches,
    count: opts.matches.length,
  }));
  const env = {
    AI: { run: aiRun },
    RULES_IDX: { query },
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: opts.rows }) }),
      }),
    },
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

  it("hydrates from D1 and preserves Vectorize score order", async () => {
    const { env } = build({
      matches: [
        { id: "c2", score: 0.9 },
        { id: "c1", score: 0.8 },
      ],
      rows: [
        row("c1", { ordinal: 1, page_start: 4, page_end: 5 }),
        row("c2", { ordinal: 2, game_name: "Catan", page_start: 7, page_end: 7 }),
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
});
