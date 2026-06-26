-- Global daily generation budget (cost circuit-breaker). The Workers rate-limit binding is
-- per-colo and only does 10s/60s windows, so it can't cap a daily total. This one row per UTC
-- day is incremented on each in-scope (LLM-answered) query; when the count exceeds the budget the
-- agent serves a canned "closed for the day" reply with no model call. See src/server/agent.ts.
CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT PRIMARY KEY,        -- UTC date, date('now')
  count INTEGER NOT NULL DEFAULT 0
);
