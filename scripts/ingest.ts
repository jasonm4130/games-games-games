/**
 * Operator ingestion — onboard a Rulebook PDF (already uploaded to R2) into the index.
 *
 * This is an OPERATOR-SIDE Node script (ADR 0005), NOT a Worker route: a Worker's 128 MB / 30 s
 * ceiling can't download the tokenizer weights or run hundreds of embed calls. The PDF->markdown
 * conversion happens offline first (Docling + heal, ADR 0008); this script ingests that markdown:
 *
 *   healed markdown (--md-path)  ->  heading-bounded chunks (chunkMarkdown, shared with the
 *   Worker)  ->  [optional contextual blurb via Kimi k2.7]  ->  bge-m3 embeddings
 *   (Workers AI REST)  ->  Vectorize upsert (metadata {game_id, document_id})  +  D1 chunk rows.
 *
 * It is IDEMPOTENT: re-running for the same (game, r2-key) replaces that document's chunks.
 * Vectorize has no delete-by-metadata, so we capture the old chunk ids from D1 (the chunk id
 * IS the vector id — ADR 0004) and delete those before reinserting. Heavy work (extract,
 * chunk, embed) happens BEFORE the delete, so a mid-run failure leaves the prior index intact.
 *
 * FTS5 sync is automatic (GAP 1): the lexical-leg mirror `chunks_fts` (migration 0004) is kept
 * 1:1 with `chunks` by triggers, so the DELETE-then-bulk-INSERT below fires AFTER DELETE / AFTER
 * INSERT per row and rebuilds the FTS rows with NO FTS-specific statements here. Do not add any.
 *
 * Auth — everything rides your `wrangler login` session. R2, D1, and Vectorize go through the
 * `wrangler` CLI directly. Embeddings hit the Workers AI REST API (the one thing `wrangler ai`
 * can't run), but its bearer token + account id are pulled from wrangler too — `wrangler auth
 * token` (documented for tooling reuse) + `wrangler whoami` — so NO CLOUDFLARE_AI_TOKEN or
 * CLOUDFLARE_ACCOUNT_ID env var is needed (set the latter only to disambiguate a login with
 * multiple accounts). Every wrangler subprocess has CLOUDFLARE_API_TOKEN stripped so a stale shell
 * token can't shadow the login. `--contextual` additionally needs MOONSHOT_API_KEY (Kimi k2.7).
 *
 * Usage:
 *   pnpm ingest --game "Catan" --document "Base rules" \
 *     --md-path rulebooks/catan/base.healed.md --r2-key catan/base.md \
 *     [--edition "5th"] [--kind base|expansion|errata] [--contextual]
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AutoTokenizer } from "@huggingface/transformers";
import { chunkMarkdown } from "../src/server/rag/chunk";
import { EMBEDDING_MODEL } from "../src/server/rag/models";
import type { ChunkInput, DocumentKind } from "../src/shared/types";
import {
  D1_DATABASE,
  d1Select,
  fail,
  requireEnv,
  resolveCloudflareAuth,
  resolveGameId,
  sqlStr,
  workersAiRun,
  wrangler,
} from "./lib/wrangler";

const VECTORIZE_INDEX = "ggg-rules-index";
const EMBED_BATCH = 100; // Workers AI bge-m3 caps simple-embedding input at 100 strings/call.
// …and at 60000 summed tokens/call. This is a LOCAL-tokenizer budget: the Xenova/bge-m3
// tokenizer we count with undercounts vs Workers AI's server-side count by ~2.5x (53 contextual
// chunks measured ~33k local but 82680 server), so keep the local budget well below 60000/2.5.
const EMBED_MAX_TOKENS = 15000;
const DELETE_BATCH = 100; // Vectorize delete_by_ids caps at 100 ids per request (REST error 40007).
const CONTEXTUAL_MODEL = "kimi-k2.7-code";
const CONTEXTUAL_MAX_TOKENS = 1024; // headroom: k2.7 thinks before emitting the 1-2 sentence blurb.
const MOONSHOT_API = "https://api.moonshot.ai/v1";
const VALID_KINDS: DocumentKind[] = ["base", "expansion", "errata"];

// ── D1 / R2 / Vectorize via wrangler (shared OAuth plumbing lives in ./lib/wrangler) ───────────

/** Run a write statement, ignoring output. */
async function d1Run(sql: string): Promise<void> {
  await wrangler(["d1", "execute", D1_DATABASE, "--remote", "--json", "--command", sql]);
}

/**
 * Apply a multi-statement SQL file (the bulk chunk insert). D1 runs the whole file atomically and
 * rolls back on any failure, so no explicit transaction is needed — and BEGIN/COMMIT is in fact
 * rejected by D1 ("use the storage transaction API instead"), so we must not add one.
 */
async function d1File(path: string): Promise<void> {
  await wrangler(["d1", "execute", D1_DATABASE, "--remote", "--file", path]);
}

async function readMarkdown(path: string): Promise<string> {
  const md = await readFile(path, "utf-8");
  if (!md.trim()) throw new Error(`empty markdown: ${path}`);
  return md;
}

// ── Workers AI REST embeddings (bge-m3; input field is `text`, max 100/call) ────────────────

async function embedBatch(
  texts: string[],
  accountId: string,
  aiToken: string,
): Promise<number[][]> {
  const json = await workersAiRun<{
    result: { data: number[][] };
    success: boolean;
    errors: unknown[];
  }>(EMBEDDING_MODEL, { text: texts }, { accountId, aiToken });
  if (!json.success) throw new Error(`Workers AI: ${JSON.stringify(json.errors)}`);
  return json.result.data;
}

// bge-m3 caps a simple-embedding request at both 100 strings AND 60000 summed tokens. A
// contextual blurb + heading prefix can push chunks near the 1024-token cap, so a fixed
// 100-string batch can exceed the token ceiling (53 contextual chunks summed to ~82k). Pack
// each call up to whichever limit hits first, counting tokens with the same bge-m3 tokenizer
// used for chunking. A single chunk is always well under EMBED_MAX_TOKENS, so it never strands.
async function embedAll(
  texts: string[],
  countTokens: (text: string) => number,
  accountId: string,
  aiToken: string,
): Promise<number[][]> {
  const vectors: number[][] = [];
  let batch: string[] = [];
  let batchTokens = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    vectors.push(...(await embedBatch(batch, accountId, aiToken)));
    batch = [];
    batchTokens = 0;
  };
  for (const text of texts) {
    const tokens = countTokens(text);
    if (
      batch.length >= EMBED_BATCH ||
      (batch.length > 0 && batchTokens + tokens > EMBED_MAX_TOKENS)
    ) {
      await flush();
    }
    batch.push(text);
    batchTokens += tokens;
  }
  await flush();
  return vectors;
}

// ── Vectorize via wrangler (upsert from an NDJSON file; delete-vectors by id) ────────────────
// No delete-by-metadata exists, so re-ingest deletes by the old chunk ids captured from D1.

interface VectorRecord {
  id: string;
  values: number[];
  metadata: Record<string, string>;
}

async function vectorizeUpsert(records: VectorRecord[], ndjsonPath: string): Promise<void> {
  await writeFile(ndjsonPath, records.map((record) => JSON.stringify(record)).join("\n"));
  // wrangler batches the file at --batch-size (default 1000) and returns once enqueued.
  await wrangler(["vectorize", "upsert", VECTORIZE_INDEX, "--file", ndjsonPath]);
}

async function vectorizeDeleteByIds(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    await wrangler([
      "vectorize",
      "delete-vectors",
      VECTORIZE_INDEX,
      "--ids",
      ...ids.slice(i, i + DELETE_BATCH),
    ]);
  }
}

// ── Contextual Retrieval blurbs (Kimi k2.7 via Moonshot's OpenAI-compatible API) ─────────────
// The document goes in a byte-identical `system` message reused across every chunk call, so
// Moonshot's implicit prefix cache discounts it after the first request (no cache_control needed).

async function contextualBlurbs(documentText: string, chunks: ChunkInput[]): Promise<string[]> {
  const apiKey = requireEnv("MOONSHOT_API_KEY");
  const system = `You situate excerpts within a tabletop rulebook to improve retrieval. Given the document below and one chunk from it, reply with ONLY a 1-2 sentence blurb naming the rule/section the chunk belongs to. Do not restate the chunk.\n\n<document>\n${documentText}\n</document>`;
  const blurbs: string[] = [];
  for (const chunk of chunks) {
    const response = await fetch(`${MOONSHOT_API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONTEXTUAL_MODEL,
        max_completion_tokens: CONTEXTUAL_MAX_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `<chunk>\n${chunk.text}\n</chunk>` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Moonshot ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    blurbs.push(json.choices[0]?.message?.content?.trim() ?? "");
  }
  return blurbs;
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string" },
      edition: { type: "string" },
      document: { type: "string" },
      "r2-key": { type: "string" },
      "md-path": { type: "string" },
      kind: { type: "string", default: "base" },
      contextual: { type: "boolean", default: false },
    },
  });

  const game = values.game ?? fail("--game is required");
  const documentTitle = values.document ?? fail("--document is required");
  const r2Key = values["r2-key"] ?? fail("--r2-key is required");
  const mdPath = values["md-path"] ?? fail("--md-path is required (the healed .md to ingest)");
  // An empty/whitespace --edition means "no edition" (it collides with NULL via the games
  // identity index), so normalize to null; otherwise store the trimmed value.
  const edition = values.edition?.trim() || null;
  const kind = values.kind as DocumentKind;
  if (!VALID_KINDS.includes(kind)) fail(`--kind must be one of ${VALID_KINDS.join(", ")}`);
  const contextual = values.contextual === true;

  const { accountId, aiToken } = await resolveCloudflareAuth();

  // Resolve the Game. INSERT OR IGNORE keeps an existing row (identity is name+edition); resolveGameId
  // then returns the canonical id whether we just inserted it or it pre-existed.
  const newGameId = randomUUID();
  const editionSql = edition === null ? "NULL" : sqlStr(edition);
  await d1Run(
    `INSERT OR IGNORE INTO games (id, name, edition) VALUES (${sqlStr(newGameId)}, ${sqlStr(game)}, ${editionSql})`,
  );
  const gameId =
    (await resolveGameId(game, edition ?? undefined)) ?? fail("could not resolve the Game id");

  // Resolve the Document by its identity (game_id, r2_key) — the source file. INSERT OR IGNORE
  // against the unique index (migration 0002) is safe from duplicate rows even under a concurrent
  // re-run; the UPDATE then refreshes title/kind and marks it ingesting, new row or pre-existing.
  const newDocumentId = randomUUID();
  await d1Run(
    `INSERT OR IGNORE INTO documents (id, game_id, r2_key, title, kind, status) VALUES (${sqlStr(newDocumentId)}, ${sqlStr(gameId)}, ${sqlStr(r2Key)}, ${sqlStr(documentTitle)}, ${sqlStr(kind)}, 'pending')`,
  );
  const documentRows = await d1Select<{ id: string }>(
    `SELECT id FROM documents WHERE game_id = ${sqlStr(gameId)} AND r2_key = ${sqlStr(r2Key)}`,
  );
  const documentId = documentRows[0]?.id ?? fail("could not resolve the Document id");
  await d1Run(
    `UPDATE documents SET title = ${sqlStr(documentTitle)}, kind = ${sqlStr(kind)}, status = 'ingesting' WHERE id = ${sqlStr(documentId)}`,
  );

  const workdir = await mkdtemp(join(tmpdir(), "ggg-ingest-"));
  try {
    // Heavy work first — extract, chunk, (contextualise), embed — so a failure here never
    // destroys the document's existing index (the delete happens only once vectors are ready).
    console.log(`-> reading ${mdPath}`);
    const markdown = await readMarkdown(mdPath);
    const tokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-m3");
    const countTokens = (text: string): number => tokenizer.encode(text).length;
    const chunks = await chunkMarkdown(markdown, { countTokens });
    if (chunks.length === 0) throw new Error("chunking produced no chunks");

    let blurbs: string[] = [];
    if (contextual) {
      console.log(`-> generating ${chunks.length} contextual blurbs (Kimi k2.7)`);
      blurbs = await contextualBlurbs(markdown, chunks);
    }

    // The blurb (when present) joins the heading-prefixed embed text — embedding only, never the
    // stored chunk text shown in Citations.
    const embedTexts = chunks.map((chunk, i) =>
      contextual && blurbs[i] ? `${blurbs[i]}\n${chunk.embedText}` : chunk.embedText,
    );
    console.log(`→ embedding ${embedTexts.length} chunks (bge-m3)`);
    const vectors = await embedAll(embedTexts, countTokens, accountId, aiToken);

    const chunkIds = chunks.map(() => randomUUID());

    // Swap: drop the document's previous chunks (D1 + Vectorize) only now that the new ones are
    // computed, then insert D1 rows BEFORE upserting vectors so every vector id is tracked in D1.
    const oldIds = (
      await d1Select<{ id: string }>(
        `SELECT id FROM chunks WHERE document_id = ${sqlStr(documentId)}`,
      )
    ).map((row) => row.id);
    if (oldIds.length > 0) {
      console.log(`→ replacing ${oldIds.length} existing chunks`);
      await vectorizeDeleteByIds(oldIds);
      await d1Run(`DELETE FROM chunks WHERE document_id = ${sqlStr(documentId)}`);
    }

    const numOrNull = (n: number | null) => (n === null ? "NULL" : String(n));
    const insertSql = chunks
      .map((chunk, i) => {
        const blurbSql = contextual && blurbs[i] ? sqlStr(blurbs[i]) : "NULL";
        const headingSql = chunk.headingPath ? sqlStr(chunk.headingPath) : "NULL";
        return `INSERT INTO chunks (id, document_id, ordinal, text, page_start, page_end, context_blurb, heading_path) VALUES (${sqlStr(chunkIds[i])}, ${sqlStr(documentId)}, ${i}, ${sqlStr(chunk.text)}, ${numOrNull(chunk.pageStart)}, ${numOrNull(chunk.pageEnd)}, ${blurbSql}, ${headingSql});`;
      })
      .join("\n");
    const insertPath = join(workdir, "chunks.sql");
    await writeFile(insertPath, insertSql);
    console.log(`→ writing ${chunks.length} chunk rows to D1`);
    await d1File(insertPath);

    console.log(`→ upserting ${vectors.length} vectors to Vectorize`);
    await vectorizeUpsert(
      chunks.map((_, i) => ({
        id: chunkIds[i],
        values: vectors[i],
        metadata: { game_id: gameId, document_id: documentId },
      })),
      join(workdir, "vectors.ndjson"),
    );

    await d1Run(
      `UPDATE documents SET status = 'ready', chunks_count = ${chunks.length}, ingested_at = datetime('now') WHERE id = ${sqlStr(documentId)}`,
    );
    console.log(
      `✓ ingested ${chunks.length} chunks for "${game}"${edition ? ` (${edition})` : ""} / "${documentTitle}". Vectors index asynchronously — allow a few seconds before querying.`,
    );
  } catch (error) {
    await d1Run(`UPDATE documents SET status = 'failed' WHERE id = ${sqlStr(documentId)}`).catch(
      () => {},
    );
    throw error;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
