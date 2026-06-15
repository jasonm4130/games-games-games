import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./http";

// Tiny backoff so the real setTimeout waits are negligible (no fake timers needed).
const fast = { attempts: 4, baseMs: 1, capMs: 2 };
const resp = (status: number) => new Response("x", { status });

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithRetry", () => {
  it("retries a 429 and returns the first success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", {}, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the final response (not an error) after exhausting retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(503));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", {}, fast);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(fast.attempts);
  });

  it("retries a network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", {}, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a permanent 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(400));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", {}, fast);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
