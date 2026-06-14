import { afterEach, describe, expect, it, vi } from "vitest";

// agent.ts uses TC39 Stage 3 decorators (@callable()), which the workerd V8 in the
// vitest-pool-workers miniflare environment does not support natively. The @cloudflare/vite-plugin
// compiles decorators at build time, but the test pool does not. We mock the entire agent module
// so we only exercise the Hono route layer (which is all this test suite cares about).
vi.mock("./agent", () => ({ RulesAgent: class {} }));

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
