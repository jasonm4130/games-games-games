-- A Document's identity within a Game is its source file (r2_key): re-onboarding the same file
-- must reuse the row, not create a second one (which would orphan its chunks + vectors). This
-- mirrors the games (name, edition) identity index and lets ingestion resolve a Document with
-- INSERT OR IGNORE + SELECT safely, even under a concurrent re-run. See ADR 0004, scripts/ingest.ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_identity ON documents (game_id, r2_key);
