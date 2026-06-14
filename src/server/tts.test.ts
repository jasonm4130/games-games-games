import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// agent.ts uses TC39 Stage 3 decorators (@callable()), which the workerd V8 in the
// vitest-pool-workers miniflare environment does not support natively. The @cloudflare/vite-plugin
// compiles decorators at build time, but the test pool does not. We mock the entire agent module
// so we only exercise the Hono route layer (which is all this test suite cares about).
vi.mock("./agent", () => ({ RulesAgent: class {} }));

// The eval routes import retrieve() directly (it pulls in Vectorize + AI bindings, remote-only in
// the workers pool), so mock the module — these tests assert only the route guard + plumbing.
const retrieveMock = vi.hoisted(() => vi.fn());
const retrieveCandidatesMock = vi.hoisted(() => vi.fn());
vi.mock("./rag/retrieve", () => ({
  retrieve: retrieveMock,
  retrieveCandidates: retrieveCandidatesMock,
}));

import app from "./index";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ELEVENLABS_API_KEY: "test-key",
    TTS_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as unknown as Env;
}

function ttsRequest(body: unknown, env: Env) {
  return app.request(
    "/api/tts",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/tts", () => {
  it("streams audio/mpeg for valid text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const res = await ttsRequest({ text: "Each player starts with $1500." }, fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("sends the query + voice id to ElevenLabs", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await ttsRequest({ text: "hello" }, fakeEnv());
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("wXvR48IpOq9HACltTmt7");
    expect(call[1].headers).toMatchObject({ "xi-api-key": "test-key" });
    expect(JSON.parse(call[1].body as string)).toMatchObject({ text: "hello" });
  });

  it("rejects missing text with 400", async () => {
    const res = await ttsRequest({}, fakeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects over-long text with 400", async () => {
    const res = await ttsRequest({ text: "x".repeat(2001) }, fakeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    const env = fakeEnv({
      TTS_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
    } as Partial<Env>);
    const res = await ttsRequest({ text: "hello" }, env);
    expect(res.status).toBe(429);
  });

  it("returns 502 when ElevenLabs fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const res = await ttsRequest({ text: "hello" }, fakeEnv());
    expect(res.status).toBe(502);
  });
});

function evalRequest(body: unknown, env: Env, secretHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretHeader !== undefined) headers["x-eval-secret"] = secretHeader;
  return app.request(
    "/api/eval/retrieve",
    { method: "POST", headers, body: JSON.stringify(body) },
    env,
  );
}

describe("POST /api/eval/retrieve (secret-gated)", () => {
  beforeEach(() => {
    retrieveMock.mockReset();
    retrieveCandidatesMock.mockReset();
    retrieveMock.mockResolvedValue([{ chunk: { id: "c1" }, score: 0.8 }]);
    retrieveCandidatesMock.mockResolvedValue({ ids: ["c1", "c2"], cosineById: new Map() });
  });

  it("404s when EVAL_SECRET is unset (endpoint invisible)", async () => {
    const env = fakeEnv({ EVAL_SECRET: undefined } as Partial<Env>);
    const res = await evalRequest({ gameId: "g1", query: "q" }, env, "anything");
    expect(res.status).toBe(404);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("404s on a header mismatch", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest({ gameId: "g1", query: "q" }, env, "wrong");
    expect(res.status).toBe(404);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("404s when the header is absent", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest({ gameId: "g1", query: "q" }, env);
    expect(res.status).toBe(404);
  });

  it("returns final ids, scores, and the candidate window on the right secret", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest({ gameId: "g1", query: "q" }, env, "right");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ final: ["c1"], scores: [0.8], candidates: ["c1", "c2"] });
  });

  it("passes mode 'dense' through to retrieve for the dense baseline", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    await evalRequest({ gameId: "g1", query: "q", mode: "dense" }, env, "right");
    expect(retrieveMock).toHaveBeenCalledWith(env, "q", { gameId: "g1", mode: "dense" });
  });

  it("400s on a missing gameId even with the right secret", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest({ query: "q" }, env, "right");
    expect(res.status).toBe(400);
  });
});
