/**
 * Operator ingestion — onboard a Rulebook PDF (already uploaded to R2) into the index.
 *
 * This is an OPERATOR-SIDE Node script (ADR 0005), NOT a Worker route: a Worker's
 * 128 MB / 30 s ceiling can't parse a large PDF or download tokenizer weights. The pipeline:
 *
 *   R2 PDF  ->  per-page text (pdfjs-dist)  ->  token-budgeted chunks (chunkPages, shared
 *   with the Worker)  ->  [optional contextual blurb via Kimi k2.7]  ->  bge-m3 embeddings
 *   (Workers AI REST)  ->  Vectorize upsert (metadata {game_id, document_id})  +  D1 chunk rows.
 *
 * It is IDEMPOTENT: re-running for the same (game, r2-key) replaces that document's chunks.
 * Vectorize has no delete-by-metadata, so we capture the old chunk ids from D1 (the chunk id
 * IS the vector id — ADR 0004) and delete those before reinserting. Heavy work (extract,
 * chunk, embed) happens BEFORE the delete, so a mid-run failure leaves the prior index intact.
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
 *   pnpm ingest --game "Catan" --document "Base rules" --r2-key catan/base-5th.pdf \
 *     [--edition "5th"] [--kind base|expansion|errata] [--contextual]
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { AutoTokenizer } from "@huggingface/transformers";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { chunkPages } from "../src/server/rag/chunk";
import { EMBEDDING_MODEL } from "../src/server/rag/models";
import type { ChunkInput, DocumentKind, PageText } from "../src/shared/types";

const execFileP = promisify(execFile);

const VECTORIZE_INDEX = "ggg-rules-index";
const R2_BUCKET = "ggg-rulebooks";
const D1_DATABASE = "ggg-db";
const EMBED_BATCH = 100; // Workers AI bge-m3 caps simple-embedding input at 100 strings/call.
// …and at 60000 summed tokens/call. This is a LOCAL-tokenizer budget: the Xenova/bge-m3
// tokenizer we count with undercounts vs Workers AI's server-side count by ~2.5x (53 contextual
// chunks measured ~33k local but 82680 server), so keep the local budget well below 60000/2.5.
const EMBED_MAX_TOKENS = 15000;
const DELETE_BATCH = 1000; // ids per `wrangler vectorize delete-vectors --ids` call (argv-length safety).
const CONTEXTUAL_MODEL = "kimi-k2.7-code";
const CONTEXTUAL_MAX_TOKENS = 1024; // headroom: k2.7 thinks before emitting the 1-2 sentence blurb.
const MOONSHOT_API = "https://api.moonshot.ai/v1";
const CF_API = "https://api.cloudflare.com/client/v4";
const VALID_KINDS: DocumentKind[] = ["base", "expansion", "errata"];

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`missing required env var ${name}`);
  return value;
}

/** SQLite string literal: wrap in single quotes, doubling any embedded quote. */
function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── wrangler shell-outs (R2 + D1 + Vectorize) ────────────────────────────────────────────────
// These run against your `wrangler login` (OAuth) session. CLOUDFLARE_API_TOKEN is stripped from
// the child env so a leftover/narrow token in the shell can't shadow OAuth and fail on a scope.

async function wrangler(args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const { stdout } = await execFileP("pnpm", ["exec", "wrangler", ...args], {
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Run a wrangler `--json` command and parse the single JSON object it prints (banner-tolerant). */
async function wranglerJson<T>(args: string[]): Promise<T> {
  const stdout = await wrangler(args);
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`wrangler ${args.join(" ")}: no JSON in output`);
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

/**
 * Resolve the account id + a REST bearer for the Workers AI embeddings call from your wrangler
 * session: `wrangler whoami` for the account, `wrangler auth token` for the bearer (a valid
 * Cloudflare REST credential, auto-refreshed) — so no standalone CLOUDFLARE_AI_TOKEN is needed.
 * CLOUDFLARE_ACCOUNT_ID is honoured as an override, and required to disambiguate a multi-account
 * login. CLOUDFLARE_API_TOKEN is stripped from both subprocesses by wrangler() so a stale shell
 * token can't shadow the login (which would make the returned bearer the wrong credential).
 */
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

/** Run a read query and return its rows. `wrangler --json` prints a `[{ results: [...] }]` array. */
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
  // wrangler may print a banner before the JSON; slice between the outer brackets. Safe here
  // because every d1Select query returns only ids (UUIDs), which never contain '[' or ']'.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

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

async function fetchPdf(r2Key: string, dest: string): Promise<void> {
  await wrangler(["r2", "object", "get", `${R2_BUCKET}/${r2Key}`, "--file", dest, "--remote"]);
}

// ── PDF text extraction (pdfjs-dist legacy build; falls back to a main-thread worker in Node) ─

async function extractPages(data: Uint8Array): Promise<PageText[]> {
  // pdfjs runs its worker on the main thread in Node but still imports it from workerSrc, so it
  // needs the real legacy worker module — an empty string is treated as "unspecified" and throws.
  GlobalWorkerOptions.workerSrc = createRequire(import.meta.url).resolve(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
  );
  // Node-safe defaults (no font/cmap urls needed for Latin PDFs).
  const loadingTask = getDocument({ data });
  const doc = await loadingTask.promise;
  const pages: PageText[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const parts: string[] = [];
    // items mixes TextItem (has `str`) and TextMarkedContent (does not). `hasEOL` ends a line.
    for (const item of content.items as unknown as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      parts.push(item.str);
      if (item.hasEOL) parts.push("\n");
    }
    pages.push({ pageNumber, text: parts.join("") });
    page.cleanup();
  }
  await loadingTask.destroy(); // destroys the document + worker; PDFDocumentProxy has no destroy()
  return pages;
}

// ── Workers AI REST embeddings (bge-m3; input field is `text`, max 100/call) ────────────────

async function embedBatch(
  texts: string[],
  accountId: string,
  aiToken: string,
): Promise<number[][]> {
  const response = await fetch(`${CF_API}/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texts }),
  });
  if (!response.ok) throw new Error(`Workers AI ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as {
    result: { data: number[][] };
    success: boolean;
    errors: unknown[];
  };
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
      kind: { type: "string", default: "base" },
      contextual: { type: "boolean", default: false },
    },
  });

  const game = values.game ?? fail("--game is required");
  const documentTitle = values.document ?? fail("--document is required");
  const r2Key = values["r2-key"] ?? fail("--r2-key is required");
  // An empty/whitespace --edition means "no edition" (it collides with NULL via the games
  // identity index), so normalize to null; otherwise store the trimmed value.
  const edition = values.edition?.trim() || null;
  const kind = values.kind as DocumentKind;
  if (!VALID_KINDS.includes(kind)) fail(`--kind must be one of ${VALID_KINDS.join(", ")}`);
  const contextual = values.contextual === true;

  const { accountId, aiToken } = await resolveCloudflareAuth();

  // Resolve the Game. INSERT OR IGNORE keeps an existing row (identity is name+edition); the
  // following SELECT returns the canonical id whether we just inserted it or it pre-existed.
  const newGameId = randomUUID();
  const editionSql = edition === null ? "NULL" : sqlStr(edition);
  await d1Run(
    `INSERT OR IGNORE INTO games (id, name, edition) VALUES (${sqlStr(newGameId)}, ${sqlStr(game)}, ${editionSql})`,
  );
  const gameRows = await d1Select<{ id: string }>(
    `SELECT id FROM games WHERE name = ${sqlStr(game)} AND COALESCE(edition, '') = COALESCE(${editionSql}, '')`,
  );
  const gameId = gameRows[0]?.id ?? fail("could not resolve the Game id");

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
    console.log(`→ fetching ${R2_BUCKET}/${r2Key}`);
    const pdfPath = join(workdir, "rulebook.pdf");
    await fetchPdf(r2Key, pdfPath);
    const pages = await extractPages(new Uint8Array(await readFile(pdfPath)));
    const textPages = pages.filter((page) => page.text.trim().length > 0);
    if (textPages.length === 0) {
      throw new Error("no extractable text — is this a scanned PDF? (OCR is out of scope)");
    }
    console.log(`→ ${pages.length} pages (${textPages.length} with text); tokenizing + chunking`);

    const tokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-m3");
    const countTokens = (text: string): number => tokenizer.encode(text).length;
    const chunks = await chunkPages(pages, { countTokens });
    if (chunks.length === 0) throw new Error("chunking produced no chunks");

    let blurbs: string[] = [];
    if (contextual) {
      console.log(`→ generating ${chunks.length} contextual blurbs (Kimi k2.7)`);
      blurbs = await contextualBlurbs(pages.map((page) => page.text).join("\n\n"), chunks);
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

    const insertSql = chunks
      .map((chunk, i) => {
        const blurbSql = contextual && blurbs[i] ? sqlStr(blurbs[i]) : "NULL";
        return `INSERT INTO chunks (id, document_id, ordinal, text, page_start, page_end, context_blurb) VALUES (${sqlStr(chunkIds[i])}, ${sqlStr(documentId)}, ${i}, ${sqlStr(chunk.text)}, ${chunk.pageStart}, ${chunk.pageEnd}, ${blurbSql});`;
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
