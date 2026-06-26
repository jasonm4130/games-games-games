-- Contextual BM25 (#1): index the situating blurb + section heading ALONGSIDE the chunk text in the
-- lexical leg, completing Anthropic-style Contextual Retrieval. The dense leg already embeds the
-- `context_blurb` (ingest --contextual) and the heading path; the BM25 mirror `chunks_fts` indexed
-- `chunks.text` ALONE (migration 0004), so the lexical leg was blind to the very context that fixes
-- lexical retrieval. This supersedes 0004's text-only design AND 0006's "heading deliberately excluded"
-- note: both columns now feed the FTS content via COALESCE (NULL-safe — a few legacy chunks lack a blurb).
--
-- chunks_fts stays a STANDALONE FTS5 table (own copy, chunk_id UNINDEXED, porter unicode61) — only the
-- indexed CONTENT and the sync triggers change. Refreshed in place from existing rows: NO re-embed, NO
-- re-ingest, NO Vectorize change (the blurbs are already persisted in chunks.context_blurb).

DROP TRIGGER IF EXISTS chunks_fts_ai;
DROP TRIGGER IF EXISTS chunks_fts_ad;
DROP TRIGGER IF EXISTS chunks_fts_au;

-- AFTER INSERT: ingest writes one chunk row (id, …, context_blurb, heading_path, text) — all three
-- indexed source columns are in scope here, so a fresh ingest gets contextual FTS with no script change.
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (text, chunk_id)
  VALUES (
    trim(coalesce(new.context_blurb, '') || ' ' || coalesce(new.heading_path, '') || ' ' || new.text),
    new.id
  );
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

-- Re-fire when ANY indexed source column changes (was AFTER UPDATE OF text only in 0004).
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text, context_blurb, heading_path ON chunks BEGIN
  UPDATE chunks_fts
  SET text = trim(coalesce(new.context_blurb, '') || ' ' || coalesce(new.heading_path, '') || ' ' || new.text)
  WHERE chunk_id = old.id;
END;

-- Refresh existing rows IN PLACE. An UPDATE never leaves the index empty even if interrupted — a
-- DELETE-then-re-INSERT would (and a half-applied migration is still marked applied by filename, so a
-- crash mid-backfill would silently degrade the lexical leg to empty until a manual re-run). chunks_fts
-- is 1:1 with chunks via the triggers, so the correlated lookup always resolves; the WHERE guards any
-- orphan FTS row from being NULLed.
UPDATE chunks_fts
SET text = (
  SELECT trim(coalesce(c.context_blurb, '') || ' ' || coalesce(c.heading_path, '') || ' ' || c.text)
  FROM chunks c
  WHERE c.id = chunks_fts.chunk_id
)
WHERE chunk_id IN (SELECT id FROM chunks);
