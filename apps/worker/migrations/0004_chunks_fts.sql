-- Hybrid retrieval (GAP 1): a lexical BM25 leg to fuse with the dense ANN leg before the reranker.
-- chunks_fts is an FTS5 mirror of chunks.text, kept exactly 1:1 with chunks by triggers. We use a
-- STANDALONE FTS5 table (own text copy + chunk_id UNINDEXED), NOT external-content: chunks.id is a
-- TEXT UUID, so the integer rowid an external-content table keys on does not line up with chunk
-- identity. The triggers below ARE the sync — re-ingest does DELETE FROM chunks WHERE document_id=?
-- (fires AFTER DELETE per row, removing FTS rows) then a bulk INSERT (fires AFTER INSERT per row,
-- adding fresh FTS rows), so chunks_fts stays 1:1 with chunks across re-ingest with NO orphan/dupe
-- rows and ZERO FTS-specific write logic in scripts/ingest.ts. (porter+unicode61 matches the
-- tokenizer the Agents SDK uses on D1 sessions; bm25() ranking is confirmed available on D1 FTS5.)

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Triggers keep chunks_fts in lockstep with chunks. AFTER UPDATE only fires when text changes,
-- since that is the only indexed column.
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (text, chunk_id) VALUES (new.text, new.id);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN
  UPDATE chunks_fts SET text = new.text WHERE chunk_id = old.id;
END;

-- Backfill existing chunks (one statement; fine at the 30-80-chunk corpus scale).
INSERT INTO chunks_fts (text, chunk_id) SELECT text, id FROM chunks;
