-- Section-heading anchor for markdown-sourced chunks (ADR 0008). Citations use this instead of
-- page numbers (markdown has no pages). Deliberately NOT added to chunks_fts: short structural
-- labels pollute BM25 IDF and add no lexical value (verified: the migration-0004 FTS triggers
-- touch only text/id and are AFTER UPDATE OF text, so this column is transparent to them).
ALTER TABLE chunks ADD COLUMN heading_path TEXT;
