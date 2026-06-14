/**
 * gen-gold — PROPOSE candidate gold Q&A for the eval harness (GAP 2, ADR 0007). Operator-side.
 *
 * Reads a Game's chunks read-only from D1, then asks a Workers AI text model to write, for a sample
 * of chunks, ONE rules question answerable ONLY by that chunk. It emits a JSON array of
 *   { game, edition?, query, expectedChunkIds: [chunkId], _needsReview: true }
 * marked _seed:false / _needsReview so the operator MUST curate it before feeding it to `pnpm eval`.
 * Model-written questions can be leading, vague, or answerable by other chunks — REVIEW THEM.
 *
 * Auth + REST: identical to scripts/ingest.ts — `wrangler whoami` for the account, `wrangler auth
 * token` for the bearer, Workers AI /ai/run REST for the generation. CLOUDFLARE_API_TOKEN is
 * stripped from every wrangler subprocess so a stale shell token can't shadow the login. NOTHING is
 * written to D1 / Vectorize / the index — this only reads chunks and writes a local JSON file.
 *
 * Usage:
 *   pnpm gen-gold --game "Monopoly" [--edition "…"] --out eval/gold/monopoly.generated.json [--max 8]
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { GENERATION_MODEL } from "../src/server/rag/models";

const execFileP = promisify(execFile);

const D1_DATABASE = "ggg-db";
const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_MAX = 8;
const GEN_MAX_TOKENS = 200;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── wrangler shell-outs (read-only D1 + auth), same OAuth path as scripts/ingest.ts ────────────

async function wrangler(args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const { stdout } = await execFileP("pnpm", ["exec", "wrangler", ...args], {
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function wranglerJson<T>(args: string[]): Promise<T> {
  const stdout = await wrangler(args);
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`wrangler ${args.join(" ")}: no JSON in output`);
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

async function resolveCloudflareAuth(): Promise<{ accountId: string; aiToken: string }> {
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

async function d1Select<T>(sql: string): Promise<T[]> {
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

// ── Workers AI REST text generation (one question per chunk) ───────────────────────────────────

async function proposeQuestion(
  chunkText: string,
  accountId: string,
  aiToken: string,
): Promise<string> {
  const response = await fetch(`${CF_API}/accounts/${accountId}/ai/run/${GENERATION_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: GEN_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content:
            "You write evaluation questions for a tabletop-rules assistant. Given ONE rulebook excerpt, reply with a SINGLE natural rules question a player would ask that is answerable ONLY by this excerpt. Output the question and nothing else — no preamble, no answer, no quotes.",
        },
        { role: "user", content: chunkText },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Workers AI ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { result?: { response?: string }; success: boolean };
  if (!json.success) throw new Error("Workers AI generation failed");
  return (json.result?.response ?? "").trim().replace(/^["']|["']$/g, "");
}

// ── orchestration ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string" },
      edition: { type: "string" },
      out: { type: "string" },
      max: { type: "string", default: String(DEFAULT_MAX) },
    },
  });

  const game = values.game ?? fail("--game is required");
  const out = values.out ?? fail("--out <path> is required");
  const edition = values.edition?.trim() || null;
  const max = Number(values.max) || DEFAULT_MAX;

  const { accountId, aiToken } = await resolveCloudflareAuth();

  const editionSql = edition ? sqlStr(edition) : "NULL";
  const gameRows = await d1Select<{ id: string }>(
    `SELECT id FROM games WHERE name = ${sqlStr(game)} AND COALESCE(edition, '') = COALESCE(${editionSql}, '')`,
  );
  const gameId = gameRows[0]?.id ?? fail(`Game "${game}" not found in the Catalogue`);

  // Read-only: a sample of the Game's chunks, longest first (longer chunks carry richer rules).
  const chunks = await d1Select<{ id: string; text: string }>(
    `SELECT c.id AS id, c.text AS text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.game_id = ${sqlStr(gameId)} ORDER BY length(c.text) DESC LIMIT ${max}`,
  );
  if (chunks.length === 0) fail(`no chunks found for "${game}" — has it been ingested?`);

  console.log(`→ proposing ${chunks.length} questions for "${game}" (${GENERATION_MODEL})`);
  const proposed: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const query = await proposeQuestion(chunk.text, accountId, aiToken);
    if (!query) continue;
    proposed.push({
      game,
      ...(edition ? { edition } : {}),
      query,
      expectedChunkIds: [chunk.id],
      _needsReview: true,
    });
    console.log(`  • ${query}`);
  }

  await writeFile(out, `${JSON.stringify(proposed, null, 2)}\n`);
  console.log(
    `\n✓ wrote ${proposed.length} PROPOSED gold rows to ${out}.\n` +
      "⚠ PROPOSED — REVIEW BEFORE USE. These are model-written and may be leading, vague, or\n" +
      "  answerable by other chunks. Curate (and drop the _needsReview flag) before `pnpm eval`.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
