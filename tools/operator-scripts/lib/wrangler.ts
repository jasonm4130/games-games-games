/**
 * Shared operator-script plumbing — imported by scripts/{ingest,eval,gen-gold,injection-eval}.ts so
 * this lives once instead of being copy-pasted into each. It rides your `wrangler login` (OAuth)
 * session: wrangler shell-outs, read-only D1 helpers, and the REST-bearer resolution for Workers AI.
 *
 * Every wrangler subprocess has CLOUDFLARE_API_TOKEN stripped so a stale/narrow shell token can't
 * shadow the OAuth login (which would make the returned bearer the wrong credential). Nothing here
 * writes to D1 / Vectorize — the helpers only read and resolve auth; callers own any mutations.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchWithRetry } from "./http";

const execFileP = promisify(execFile);

export const D1_DATABASE = "ggg-db";
export const CF_API = "https://api.cloudflare.com/client/v4";
// The custom domain sits behind Cloudflare bot-fight, which 403s (error 1010) a default Node/undici
// User-Agent before the request reaches the Worker — so eval HTTP calls send a browser-ish UA.
export const EVAL_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Print an error and exit non-zero. */
export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Read a required env var or fail. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`missing required env var ${name}`);
  return value;
}

/** SQLite string literal: wrap in single quotes, doubling any embedded quote. */
export function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Run a wrangler subcommand against the OAuth login and return stdout. Routed through the `worker`
 *  package (`--filter worker exec`) because wrangler is a devDep of apps/worker, not of this package —
 *  a plain `pnpm exec wrangler` from operator-scripts' cwd can't resolve the binary. The filter also
 *  runs wrangler with apps/worker as cwd, so `wrangler.jsonc` (the ggg-db binding) is in scope. */
export async function wrangler(args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const { stdout } = await execFileP("pnpm", ["--filter", "worker", "exec", "wrangler", ...args], {
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Run a wrangler `--json` command and parse the single JSON object it prints (banner-tolerant). */
export async function wranglerJson<T>(args: string[]): Promise<T> {
  const stdout = await wrangler(args);
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`wrangler ${args.join(" ")}: no JSON in output`);
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

/**
 * Run a read-only D1 query and return its rows. `wrangler --json` prints a `[{ results: [...] }]`
 * array, optionally preceded by a banner; we slice between the outer brackets. Safe for the queries
 * here, which return ids/short text — never values containing '[' or ']' before the JSON.
 */
export async function d1Select<T>(sql: string): Promise<T[]> {
  const stdout = await wrangler([
    "d1",
    "execute",
    D1_DATABASE,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

// Resolve a Game's id by its identity (name + edition) once and memoize it — callers that resolve
// the same Game across many rows (eval, injection-eval) hit D1 only once per Game.
const gameIdCache = new Map<string, string | null>();

/**
 * Resolve a Game's id by its identity (name + edition, NULL↔'' coalesced like the games identity
 * index), or null if it isn't in the Catalogue. Read-only. Shared by every operator script so the
 * identity query lives in exactly one place.
 */
export async function resolveGameId(game: string, edition?: string): Promise<string | null> {
  const key = `${game} ${edition ?? ""}`;
  const cached = gameIdCache.get(key);
  if (cached !== undefined) return cached;
  const editionSql = edition?.trim() ? sqlStr(edition.trim()) : "NULL";
  const rows = await d1Select<{ id: string }>(
    `SELECT id FROM games WHERE name = ${sqlStr(game)} AND COALESCE(edition, '') = COALESCE(${editionSql}, '')`,
  );
  const id = rows[0]?.id ?? null;
  gameIdCache.set(key, id);
  return id;
}

/**
 * POST to the Workers AI REST API (/accounts/:id/ai/run/:model) with the resolved bearer and return
 * the parsed JSON typed as T. Centralizes the URL + auth header + ok-check shared by the embedding
 * and text-generation call sites; each caller narrows T to its model's own result shape.
 */
export async function workersAiRun<T>(
  model: string,
  input: Record<string, unknown>,
  auth: { accountId: string; aiToken: string },
): Promise<T> {
  const res = await fetchWithRetry(
    `${CF_API}/accounts/${auth.accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.aiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    { label: `workers-ai ${model}` },
  );
  if (!res.ok) throw new Error(`Workers AI ${model} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Resolve the account id + a REST bearer (for Workers AI /ai/run) from your wrangler session:
 * `wrangler whoami` for the account, `wrangler auth token` for the bearer (a valid, auto-refreshed
 * Cloudflare REST credential — so no standalone CLOUDFLARE_AI_TOKEN is needed). CLOUDFLARE_ACCOUNT_ID
 * is honoured as an override and required to disambiguate a multi-account login.
 */
export async function resolveCloudflareAuth(): Promise<{ accountId: string; aiToken: string }> {
  const who = await wranglerJson<{ loggedIn?: boolean; accounts?: { id: string; name: string }[] }>(
    ["whoami", "--json"],
  );
  const accounts = who.accounts ?? [];
  if (!who.loggedIn || accounts.length === 0) {
    fail("not logged in to wrangler — run `wrangler login` (and unset CLOUDFLARE_API_TOKEN)");
  }
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    if (accounts.length > 1) {
      fail(
        `wrangler login has ${accounts.length} accounts — set CLOUDFLARE_ACCOUNT_ID to choose one`,
      );
    }
    accountId = accounts[0]?.id;
  }
  if (!accountId) fail("could not resolve a Cloudflare account id from `wrangler whoami`");
  const auth = await wranglerJson<{ token?: string }>(["auth", "token", "--json"]);
  if (!auth.token) fail("`wrangler auth token` returned no token — re-run `wrangler login`");
  return { accountId, aiToken: auth.token };
}
