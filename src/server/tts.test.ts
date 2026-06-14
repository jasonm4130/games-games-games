import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATION_MODEL } from "./rag/models";
import { synthesizeSpeech } from "./tts";

// agent.ts uses TC39 Stage 3 decorators (@callable()), which the workerd V8 in the
// vitest-pool-workers miniflare environment does not support natively. The @cloudflare/vite-plugin
// compiles decorators at build time, but the test pool does not. We mock the entire agent module
// so we only exercise the Hono route layer (which is all this test suite cares about).
vi.mock("./agent", () => ({ RulesAgent: class {} }));

// The eval routes import retrieve()/retrieveDetailed() directly (they pull in Vectorize + AI
// bindings, remote-only in the workers pool), so mock the module — these tests assert only the
// route guard + plumbing. generateText is mocked so /api/eval/answer never hits Workers AI.
const retrieveMock = vi.hoisted(() => vi.fn());
const retrieveDetailedMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("./rag/retrieve", () => ({
  retrieve: retrieveMock,
  retrieveDetailed: retrieveDetailedMock,
}));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => (model: string) => ({ model }) }));

import app from "./index";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ELEVENLABS_API_KEY: "test-key",
    TTS_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

// ── TTS synthesis (now invoked only by the agent `speak` RPC, not an HTTP route) ─────────────────

describe("synthesizeSpeech", () => {
  it("returns the MP3 as base64 for valid text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const b64 = await synthesizeSpeech(fakeEnv(), "Each player starts with $1500.");
    expect(b64).toBe(btoa(String.fromCharCode(1, 2, 3)));
  });

  it("sends the text + voice id + api key to ElevenLabs", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeSpeech(fakeEnv(), "hello");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("wXvR48IpOq9HACltTmt7");
    expect(call[1].headers).toMatchObject({ "xi-api-key": "test-key" });
    expect(JSON.parse(call[1].body as string)).toMatchObject({ text: "hello" });
  });

  it("throws when ElevenLabs returns an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(synthesizeSpeech(fakeEnv(), "hello")).rejects.toThrow(/401/);
  });
});

// ── Eval harness routes (operator-only, secret-gated) ────────────────────────────────────────────

function evalRequest(path: string, body: unknown, env: Env, secretHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretHeader !== undefined) headers["x-eval-secret"] = secretHeader;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

describe("POST /api/eval/retrieve (secret-gated)", () => {
  beforeEach(() => {
    retrieveDetailedMock.mockReset();
    retrieveDetailedMock.mockResolvedValue({
      passages: [{ chunk: { id: "c1" }, score: 0.8 }],
      candidateIds: ["c1", "c2"],
    });
  });

  it("404s when EVAL_SECRET is unset (endpoint invisible)", async () => {
    const env = fakeEnv({ EVAL_SECRET: undefined } as Partial<Env>);
    const res = await evalRequest(
      "/api/eval/retrieve",
      { gameId: "g1", query: "q" },
      env,
      "anything",
    );
    expect(res.status).toBe(404);
    expect(retrieveDetailedMock).not.toHaveBeenCalled();
  });

  it("404s on a header mismatch", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/retrieve", { gameId: "g1", query: "q" }, env, "wrong");
    expect(res.status).toBe(404);
    expect(retrieveDetailedMock).not.toHaveBeenCalled();
  });

  it("404s when the header is absent", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/retrieve", { gameId: "g1", query: "q" }, env);
    expect(res.status).toBe(404);
  });

  it("returns final ids, scores, and the candidate window on the right secret", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/retrieve", { gameId: "g1", query: "q" }, env, "right");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ final: ["c1"], scores: [0.8], candidates: ["c1", "c2"] });
  });

  it("passes mode 'dense' through to retrieveDetailed for the dense baseline", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    await evalRequest(
      "/api/eval/retrieve",
      { gameId: "g1", query: "q", mode: "dense" },
      env,
      "right",
    );
    expect(retrieveDetailedMock).toHaveBeenCalledWith(env, "q", { gameId: "g1", mode: "dense" });
  });

  it("400s on a missing gameId even with the right secret", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/retrieve", { query: "q" }, env, "right");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/eval/answer (secret-gated)", () => {
  beforeEach(() => {
    retrieveMock.mockReset();
    generateTextMock.mockReset();
    retrieveMock.mockResolvedValue([
      {
        chunk: { id: "c1", text: "Each player starts with $1500." },
        gameName: "Monopoly",
        documentTitle: "Base Game",
        documentKind: "base",
        score: 0.8,
      },
    ]);
    generateTextMock.mockResolvedValue({ text: "Each player starts with $1500 [1]." });
  });

  it("404s when EVAL_SECRET is unset (endpoint invisible)", async () => {
    const env = fakeEnv({ EVAL_SECRET: undefined } as Partial<Env>);
    const res = await evalRequest(
      "/api/eval/answer",
      { gameId: "g1", query: "q" },
      env,
      "anything",
    );
    expect(res.status).toBe(404);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("400s on a missing query even with the right secret", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/answer", { gameId: "g1" }, env, "right");
    expect(res.status).toBe(400);
  });

  it("400s on a model outside the eval allowlist (no model can be driven through)", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest(
      "/api/eval/answer",
      { gameId: "g1", query: "q", model: "@cf/expensive/model" },
      env,
      "right",
    );
    expect(res.status).toBe(400);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns an empty answer when nothing grounds (no model call)", async () => {
    retrieveMock.mockResolvedValue([]);
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/answer", { gameId: "g1", query: "q" }, env, "right");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: GENERATION_MODEL, answer: "", passages: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("answers with the default model and returns the grounding passages", async () => {
    const env = fakeEnv({ EVAL_SECRET: "right" } as Partial<Env>);
    const res = await evalRequest("/api/eval/answer", { gameId: "g1", query: "q" }, env, "right");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: GENERATION_MODEL,
      answer: "Each player starts with $1500 [1].",
      passages: ["Each player starts with $1500."],
    });
    expect(generateTextMock).toHaveBeenCalledOnce();
  });
});
