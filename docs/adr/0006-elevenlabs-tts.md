---
status: accepted
---

# ElevenLabs for goblin text-to-speech

Date: 2026-06-14

The Parlour is "Cloudflare-native", but the goblin-voice feature needs a characterful,
consistent voice. Workers AI TTS (MeloTTS, Deepgram Aura-2) only offers neutral human
voices; matching the goblin character meant either client-side pitch tricks or accepting a
generic narrator. We already have an ElevenLabs account and a chosen voice
(`wXvR48IpOq9HACltTmt7`).

**Why this is an ADR:** using an external paid TTS service is surprising in a Cloudflare-
native app, is the result of a real trade-off against Workers AI, and is non-trivial to
reverse once voice content is associated with the product — worth recording.

**Decision:** Synthesise speech with the ElevenLabs TTS REST API (`eleven_multilingual_v2`).
The `ELEVENLABS_API_KEY` is a Worker secret (prod) / `.dev.vars` entry (local, sourced from
1Password); it never reaches the browser. TTS is exposed as the `RulesAgent.speak` RPC over
the authenticated agent WebSocket — NOT a public HTTP route (see the 2026-06-14 update below) —
returning the MP3 to the client as base64. A per-session `TTS_LIMITER` rate limit, a global
daily cap (`tts_daily_usage`), and a 3200-char cap bound credit spend; `speak` only voices a
ruling the session actually produced (resolved by message id server-side), never client free-text.

**Rejected:** Workers AI TTS (MeloTTS, Deepgram Aura-2) — neutral human voices, no
character match; client-side pitch shift — degrades quality and still requires a generic
voice source.

**Consequences:**

- A non-Cloudflare paid dependency and a new external failure mode (on failure `speak`
  returns an in-character reason; the ruling text stays on screen and the client shows a
  small "couldn't read aloud" note).
- The voice is consistent and on-character, tunable via `voice_settings` / model id (one-
  line swap to `eleven_flash_v2_5` halves credits).
- Reversible: swap `synthesizeSpeech` for a Workers AI TTS model without touching the client.

**Update (2026-06-14) — internalised the TTS surface.** Originally TTS was a public
`POST /api/tts` route streaming `audio/mpeg`, with a `TTS_LIMITER` + 2000-char cap. A public
route can't be access-gated the way the eval endpoints are: the browser is the caller, so any
credential shipped to it is readable by anyone. We moved synthesis onto the `RulesAgent.speak`
RPC and deleted the route, so it is reachable only through an authenticated agent session,
scoped per-DO, and can only voice a ruling that session actually produced. The trade-off: audio
returns as one base64 payload over the WebSocket instead of a streamed HTTP body. No UX cost —
the client already buffered the whole blob before playback — and Workers WebSocket messages cap
at 32 MiB (raised from 1 MiB, Oct 2025), ample for a max-length ruling. The char cap was also
raised 2000 → 3200 (a 600-token ruling can exceed 2000 chars and was silently failing).
