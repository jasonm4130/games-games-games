-- Metadata for the RAG-over-rulebooks app. Embeddings live in Vectorize; chunk
-- text is kept here so Rulings can render Citations. See CONTEXT.md and the ADRs.

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  edition     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Game identity is (name, edition); a re-onboard of the same Game must not create a
-- second row (it would double Vectorize storage and rank duplicate chunks). edition is
-- nullable, so COALESCE to '' makes NULL editions collide like any other value (ADR 0004).
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_identity ON games (name, COALESCE(edition, ''));

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  title         TEXT NOT NULL,
  -- A Game may have several Rulebooks; kind drives precedence (errata overrides base).
  -- The override ranking is feature-phase; the column reserves the ability to express it.
  kind          TEXT NOT NULL DEFAULT 'base' CHECK (kind IN ('base', 'expansion', 'errata')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ingesting', 'ready', 'failed')),
  -- Set by Ingestion when it reaches 'ready'; null while pending/ingesting/failed.
  chunks_count  INTEGER,
  ingested_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_game ON documents (game_id);

CREATE TABLE IF NOT EXISTS chunks (
  -- id IS the Vectorize vector id (a UUID minted at ingest). Retrieval hydrates a
  -- Vectorize match back to its text by joining match.id = chunks.id (ADR 0004) — there
  -- is no separate vector_id column to drift out of sync.
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  -- Source page span for page-level Citations. Nullable for non-paginated sources.
  page_start    INTEGER,
  page_end      INTEGER,
  -- Anthropic-style contextual-retrieval blurb, stored separately from `text` so it can be
  -- regenerated without re-extracting the PDF. Prepended to `text` only at embed time.
  context_blurb TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id);
