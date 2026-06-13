// Drizzle schema — a typed mirror of migrations/0001-0003. The wrangler SQL migrations remain
// the source of truth for the database (applied to remote D1, owned alongside central infra,
// ADR 0003); this file exists only to give the Worker-side queries types and a query builder.
// Keep it in sync by hand when a migration changes a column. See src/server/db/index.ts.

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  edition: text("edition"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  title: text("title").notNull(),
  kind: text("kind", { enum: ["base", "expansion", "errata"] })
    .notNull()
    .default("base"),
  status: text("status", { enum: ["pending", "ingesting", "ready", "failed"] })
    .notNull()
    .default("pending"),
  chunksCount: integer("chunks_count"),
  ingestedAt: text("ingested_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  text: text("text").notNull(),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  contextBlurb: text("context_blurb"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const dailyUsage = sqliteTable("daily_usage", {
  day: text("day").primaryKey(),
  count: integer("count").notNull().default(0),
});
