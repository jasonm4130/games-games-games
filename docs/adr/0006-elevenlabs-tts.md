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

**Decision:** Synthesise speech with the ElevenLabs TTS REST API (`eleven_multilingual_v2`)
from a server-side `POST /api/tts` route, streaming `audio/mpeg` to the client. The
`ELEVENLABS_API_KEY` is a Worker secret (prod) / `.dev.vars` entry (local, sourced from
1Password); it never reaches the browser. A dedicated `TTS_LIMITER` rate limit and a
2000-char cap bound credit spend.

**Rejected:** Workers AI TTS (MeloTTS, Deepgram Aura-2) — neutral human voices, no
character match; client-side pitch shift — degrades quality and still requires a generic
voice source.

**Consequences:**

- A non-Cloudflare paid dependency and a new external failure mode (handled as a 502; the
  ruling text is still on screen).
- The voice is consistent and on-character, tunable via `voice_settings` / model id (one-
  line swap to `eleven_flash_v2_5` halves credits).
- Reversible: swap the route's `synthesizeSpeech` for a Workers AI TTS model without
  touching the client.
