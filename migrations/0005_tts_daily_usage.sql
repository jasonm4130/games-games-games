-- Global daily cap on TTS (ElevenLabs) credit spend. The TTS_LIMITER rate-limit binding is
-- per-IP and per-colo, so it can't bound a daily total: an attacker rotating IPs across colos
-- could still run up real credits. This one row per UTC day is incremented on each synthesised
-- ruling; once the count exceeds the budget the /api/tts route returns 429 with no upstream call
-- for the rest of the UTC day. Mirrors daily_usage (the agent's LLM budget). See src/server/index.ts.
CREATE TABLE IF NOT EXISTS tts_daily_usage (
  day TEXT PRIMARY KEY,        -- UTC date, date('now')
  count INTEGER NOT NULL DEFAULT 0
);
