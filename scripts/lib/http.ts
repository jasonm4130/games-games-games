/**
 * fetchWithRetry — exponential backoff with full jitter for the operator scripts' external API calls
 * (Workers AI, Moonshot/Kimi). The contextual-blurb pass fires one Kimi call per chunk and Moonshot
 * returns 429 `engine_overloaded` under load, so a no-retry fetch fails the whole ingest; this rides
 * transient overload out instead.
 *
 * Retries transient failures only — 429 + 5xx + network errors — and honours a `Retry-After` header
 * when the server sends one, else backs off base·2^attempt (capped) randomized with FULL jitter
 * (AWS "Exponential Backoff And Jitter"). A permanent 4xx is returned immediately. The final attempt's
 * Response is always returned (never a synthetic error) so the caller's own `.ok` check still drives
 * the error message it wants.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 6). */
  attempts?: number;
  /** Backoff base in ms (default 600). */
  baseMs?: number;
  /** Per-wait ceiling in ms (default 30_000). */
  capMs?: number;
  /** Label shown in the retry log line (default the URL). */
  label?: string;
  /** Which statuses are transient and worth retrying (default 429 or >= 500). */
  retryStatus?: (status: number) => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Full jitter: a uniform random wait in [0, min(cap, base·2^attempt)].
function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

// A `Retry-After` value is either integer seconds or an HTTP-date; → ms, or null if absent/unparseable.
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 6;
  const baseMs = opts.baseMs ?? 600;
  const capMs = opts.capMs ?? 30_000;
  const label = opts.label ?? url;
  const retryStatus = opts.retryStatus ?? ((status) => status === 429 || status >= 500);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    try {
      const res = await fetch(url, init);
      if (isLast || !retryStatus(res.status)) return res;
      const wait = retryAfterMs(res) ?? backoffMs(attempt, baseMs, capMs);
      console.warn(
        `  ⟳ ${label}: HTTP ${res.status}; retry ${attempt + 1}/${attempts - 1} in ${Math.round(wait)}ms`,
      );
      await res.body?.cancel(); // drain so the connection can be reused
      await sleep(wait);
    } catch (error) {
      lastError = error;
      if (isLast) throw error;
      const wait = backoffMs(attempt, baseMs, capMs);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `  ⟳ ${label}: ${message}; retry ${attempt + 1}/${attempts - 1} in ${Math.round(wait)}ms`,
      );
      await sleep(wait);
    }
  }
  // The loop returns or throws on the last attempt; this only satisfies the type checker.
  throw lastError ?? new Error(`fetchWithRetry: exhausted ${attempts} attempts for ${label}`);
}
