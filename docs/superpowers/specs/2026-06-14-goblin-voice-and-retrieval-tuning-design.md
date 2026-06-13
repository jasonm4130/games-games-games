# Goblin Voice & Retrieval Tuning — Design

- **Date:** 2026-06-14
- **Status:** Accepted
- **Scope:** Two independent features — (A) looser retrieval so the goblin stops over-refusing
  synonym/paraphrase questions, and (B) the goblin speaking its rulings aloud via ElevenLabs TTS.

## Goal

Two user-reported gaps in the shipped Parlour:

1. **The goblin over-refuses.** Ask "how do I get out of **prison**" when the Monopoly rulebook
   says "**jail**" and it answers "That is not in my rulebook." — a synonym it plainly should
   handle. Make it answer loosely-worded questions whose concept *is* in the text, without letting
   it invent rules.
2. **The goblin can't speak.** Add a control that reads a ruling aloud in a chosen ElevenLabs
   voice (`wXvR48IpOq9HACltTmt7`), so the Parlour has voice, not just text.

These ship as **two separate PRs** — they share no code.

## Scope

**In scope:**

- **A.** Re-order the retrieval gate so the cross-encoder reranker — not a raw cosine floor —
  decides relevance; soften the system-prompt refusal so synonyms/paraphrases are honoured.
- **B.** A `POST /api/tts` Worker route calling ElevenLabs; a client "Speak" control + a
  `useGoblinVoice()` hook; the `ELEVENLABS_API_KEY` secret; rate-limit + length guardrails; an ADR
  recording the non-Cloudflare dependency.

**Out of scope (deferred):**

- **C. New games** (Sushi Go, Exploding Kittens + Zombie Kittens). Designed already (existing
  `scripts/ingest.ts` flow, Zombie Kittens as an Exploding Kittens `--kind expansion`), deferred to
  a later pass. Re-validating the reranker gate (A) against multiple games is the natural moment to
  do C.
- No change to the embedding model, the generation model, or the chunking pipeline.
- No client-side pitch shift — the chosen ElevenLabs voice *is* the goblin character.

---

## Feature A — Looser retrieval (stop over-refusing)

### Root cause

`src/server/rag/retrieve.ts:43` applies a **0.55 cosine floor before the reranker runs**:

```ts
const hits = result.matches.filter((match) => match.score >= RETRIEVAL_MIN_SCORE); // 0.55
if (hits.length === 0) return [];                                                  // → NOT_COVERED
```

When the query wording diverges from the rulebook's ("prison" vs "jail"), bge-m3's raw cosine can
put *every* candidate under 0.55, so `retrieve()` returns `[]`, and `agent.ts:136` fires the canned
`NOT_COVERED` reply **without ever calling the LLM**. The cross-encoder reranker
(`@cf/baai/bge-reranker-base`) — which scores the (query, passage) *pair together* and handles
paraphrase far better than independent embeddings — never gets to weigh in, because the floor has
already discarded the chunk.

Two facts make the fix clean and safe:

- **The reranker already returns a per-passage relevance score** (`retrieve.ts:97` →
  `{ id, score }[]`). We currently throw that signal away and keep only its top-k *order*.
- **Cross-game isolation is the Vectorize `game_id` metadata filter** (`retrieve.ts:39`), *not* the
  cosine floor. Lowering the floor cannot reintroduce cross-game leakage. The floor only ever
  decided "is this question about this game's content at all" — a job the reranker does better.

### Design

Make the reranker the relevance gate, not the cosine floor.

1. **Lower the pre-rerank cosine floor.** `RETRIEVAL_MIN_SCORE` 0.55 → **~0.35** in
   `src/server/rag/models.ts`. It becomes a cheap noise bound that lets synonym matches survive to
   the reranker, not the relevance judge.
2. **Add a reranker-score gate.** New constant `RERANK_MIN_SCORE` in `models.ts`. In
   `retrieve.ts`, after reranking, drop any result whose reranker score is below it; if none pass,
   return `[]` (preserving the existing `NOT_COVERED` path). This is the new, better in-scope gate.
3. **Always score the survivors.** The current `survivors.length <= 1` short-circuit
   (`retrieve.ts:87`) skips the reranker — but we now need a reranker score even for a single
   survivor in order to gate on it. Rework so a lone survivor is still scored (return `[]` early
   only when *zero* candidates clear the cosine pre-filter).
4. **Soften the system prompt.** `src/server/agent.ts:35` currently reads:
   > "If the passages do not cover the question, say so decisively and in character — 'That is not
   > in my rulebook.' — then stop."

   Add an explicit synonym/paraphrase allowance, e.g.:
   > "Read the player's wording loosely: if a passage covers the same concept under a different name
   > (e.g. 'prison' for 'jail', 'turn order' for 'who goes first'), answer from it. Only refuse when
   > no passage addresses the question at all."

   Keep the "never invent a rule / no house rules" guarantee intact.

### Calibration

`RETRIEVAL_MIN_SCORE` (cosine, permissive) and `RERANK_MIN_SCORE` (the real gate) must be set from
observed values — the existing 0.55 was a one-rulebook guess (Monopoly), and bge-reranker-base's
score range is not assumed. Method: during a `pnpm dev` session against the live index, log cosine
*and* reranker scores for (a) the prison/jail synonym query and a few paraphrases, and (b) clearly
off-topic queries. Set the cosine floor below the lowest in-concept cosine seen, and
`RERANK_MIN_SCORE` between the in-concept reranker scores and the off-topic ones. Record the chosen
values and the evidence as a comment block in `models.ts` (replacing the current 0.55 calibration
note).

### Files touched

- `src/server/rag/models.ts` — lower `RETRIEVAL_MIN_SCORE`; add `RERANK_MIN_SCORE`; update the
  calibration comment.
- `src/server/rag/retrieve.ts` — always rerank; apply the reranker-score gate; rework the
  single-survivor path.
- `src/server/agent.ts` — soften the refusal instruction in `SYSTEM_PROMPT`.
- `src/server/rag/retrieve.test.ts` — update for the new gating logic.

### Success criteria

- **The bug is fixed (acceptance):** against the live Monopoly index, "how do I get out of prison"
  retrieves the Jail chunk and returns a real ruling — not `NOT_COVERED`. (Manual verification:
  Workers AI always hits the network, so this is an integration check during `pnpm dev`, not a unit
  test.)
- **Refusal still works:** a genuinely off-topic question (e.g. "what's the weather") still returns
  `NOT_COVERED`.
- **Unit tests** (`retrieve.test.ts`, reranker mocked with explicit scores): a passage above
  `RERANK_MIN_SCORE` is returned; all-below → `[]`; a synonym match that clears the lowered cosine
  floor reaches the reranker.
- `pnpm check` and `pnpm test` green.

---

## Feature B — The goblin speaks (ElevenLabs TTS)

### Server

A new `src/server/tts.ts` owns the ElevenLabs call:

```
POST https://api.elevenlabs.io/v1/text-to-speech/wXvR48IpOq9HACltTmt7?output_format=mp3_44100_128
  headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }
  body:    { text, model_id: TTS_MODEL_ID, voice_settings: { stability, similarity_boost, style, use_speaker_boost } }
  → 200 binary MP3 (streamed straight back to the client as audio/mpeg)
```

Constants in `tts.ts`: `TTS_VOICE_ID = "wXvR48IpOq9HACltTmt7"`, `TTS_MODEL_ID` (default
`eleven_multilingual_v2` for expressiveness; one-line switch to `eleven_flash_v2_5` for ~half the
credits and lower latency), `TTS_OUTPUT_FORMAT = "mp3_44100_128"`, and the voice settings.

Route in `src/server/index.ts` — `app.post("/api/tts", …)`:

- **Rate limit:** a dedicated `TTS_LIMITER` ratelimit binding (stricter than `IP_LIMITER`, keyed by
  `cf-connecting-ip`) — added to `wrangler.jsonc`. `/api/*` is currently unprotected; this call
  spends *real ElevenLabs credits*, so it gets its own tighter budget. → 429 on exceed.
- **Validation:** require non-empty `text`; reject over a length cap (~2000 chars; rulings are
  capped at 600 output tokens anyway) → 400.
- On ElevenLabs error, surface a 502 and a short message; the client falls back to showing nothing
  spoken (the text is already on screen).

### Secret

`ELEVENLABS_API_KEY` — pulled from 1Password via the `op` CLI (located with `op item list` during
setup; the value is piped, never echoed) into:

- `.dev.vars` (git-ignored) for `pnpm dev` / workerd local runs, and
- `wrangler secret put ELEVENLABS_API_KEY` for production.

Add it to the `Env` type so `env.ELEVENLABS_API_KEY` typechecks.

### Client

- **`src/client/useGoblinVoice.ts`** — a hook owning one `Audio` element and `{ speakingId,
  loading }` state. `speak(messageId, text)`: stop any current playback, strip inline `[N]` markers
  (`text.replace(/\[\d+\]/g, "")`), `POST /api/tts`, play the returned MP3 (object URL, revoked on
  end/stop). `stop()`: pause + clear. `playbackRate = 1` (no pitch shift).
- **`src/client/Chat.tsx`** — a "🔊 Speak / ⏹ Stop" toggle inside the goblin bubble, by the
  `turn__stamp` "Ruling" label (`Chat.tsx:88`). New props `onSpeak(id, text)`, `speakingId`,
  reusing the existing `isStreaming` to disable the button mid-stream. Reads `textOf(message)`.
- **`src/client/App.tsx`** — instantiate `useGoblinVoice()`; pass `onSpeak` + `speakingId` to
  `Chat`; call `voice.stop()` from `onSend` and `onNewConversation` (auto-stop on a new question).
- **`src/client/styles.css`** — a `.turn__speak` button style consistent with `.cite-chip`.

### ADR

`docs/adr/0006-elevenlabs-tts.md` — records the decision to use an **external paid TTS provider**
in an otherwise Cloudflare-native app: the trade-off (a specific, characterful voice + quality vs.
the Workers AI Aura-2 option that stayed on-platform and on the CF billing model), and the
consequence (a new secret, a new external failure mode, credit spend gated by `TTS_LIMITER`).

### Files touched

- New: `src/server/tts.ts`, `src/client/useGoblinVoice.ts`, `docs/adr/0006-elevenlabs-tts.md`.
- Edit: `src/server/index.ts` (route + limiter), `wrangler.jsonc` (`TTS_LIMITER`), `env.d.ts` /
  `Env` type (`ELEVENLABS_API_KEY`, `TTS_LIMITER`), `src/client/Chat.tsx`, `src/client/App.tsx`,
  `src/client/styles.css`, `.dev.vars` (local, untracked), `.gitignore` (ensure `.dev.vars`).

### Success criteria

- **Smoke test first:** a one-off call to ElevenLabs with the voice ID + key returns audio (confirms
  the voice/key before any UI wiring).
- **Manual (local):** clicking Speak on a goblin ruling plays the voice; clicking again stops it;
  sending a new question stops playback; the button is disabled while streaming.
- **Guardrails:** `/api/tts` returns 400 on missing/over-long text and 429 when `TTS_LIMITER` is
  exceeded.
- **Unit test** (`/api/tts`, ElevenLabs `fetch` mocked): valid body → audio passthrough; missing
  text / over-length → 400.
- `pnpm check`, `pnpm test`, `pnpm build` green.

---

## Sequencing & risks

- **Order:** ship **A** first (server-only, low blast radius), then **B**. Independent PRs.
- **Risk (A):** thresholds are data-driven; if the live index is Monopoly-only, calibration is
  against one rulebook — acceptable now, revisit when C lands. The reranker adds one model call even
  for a single survivor (negligible; same `env.AI` binding).
- **Risk (B):** ElevenLabs is an external paid dependency and a new failure mode; mitigated by the
  length cap, `TTS_LIMITER`, and graceful 502 handling. The voice ID is unverified until the smoke
  test.

## Implementation checklist

1. **A:** lower cosine floor + add `RERANK_MIN_SCORE` (`models.ts`); rework `retrieve.ts` gate;
   soften `SYSTEM_PROMPT`; calibrate against the live index; update `retrieve.test.ts`; verify.
2. **B:** `op` → `.dev.vars` + `wrangler secret`; `tts.ts`; `/api/tts` + `TTS_LIMITER`; `Env` type;
   smoke-test the voice; `useGoblinVoice.ts`; wire `Chat.tsx` + `App.tsx` + styles; ADR 0006;
   tests; verify.
