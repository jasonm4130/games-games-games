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

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { GENERATION_MODEL } from "worker/rag/models";
import {
  d1Select,
  fail,
  resolveCloudflareAuth,
  resolveGameId,
  sqlStr,
  workersAiRun,
} from "./lib/wrangler";

const DEFAULT_MAX = 8;
const GEN_MAX_TOKENS = 200;

// ── Workers AI REST text generation (one question per chunk) ───────────────────────────────────

async function proposeQuestion(
  chunkText: string,
  accountId: string,
  aiToken: string,
): Promise<string> {
  const json = await workersAiRun<{ result?: { response?: string }; success: boolean }>(
    GENERATION_MODEL,
    {
      max_tokens: GEN_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content:
            "You write evaluation questions for a tabletop-rules assistant. Given ONE rulebook excerpt, reply with a SINGLE natural rules question a player would ask that is answerable ONLY by this excerpt. Output the question and nothing else — no preamble, no answer, no quotes.",
        },
        { role: "user", content: chunkText },
      ],
    },
    { accountId, aiToken },
  );
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

  const gameId =
    (await resolveGameId(game, edition ?? undefined)) ??
    fail(`Game "${game}" not found in the Catalogue`);

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
