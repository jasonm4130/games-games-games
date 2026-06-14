# Goblin Voice (ElevenLabs TTS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player hear a goblin ruling read aloud — a Speak control on each goblin turn that streams ElevenLabs TTS (voice `wXvR48IpOq9HACltTmt7`) and plays it.

**Architecture:** A Hono `POST /api/tts` route on the Worker calls ElevenLabs server-side (key stays secret) and streams `audio/mpeg` back. The client `useGoblinVoice()` hook fetches that, plays it via an `Audio` element, and tracks play/stop. Guardrails: a dedicated `TTS_LIMITER` rate limit + a text-length cap. No client pitch shift — the chosen voice is the character.

**Tech Stack:** Cloudflare Workers, Hono, ElevenLabs TTS REST API, React 19, Vitest (Workers pool), TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-14-goblin-voice-and-retrieval-tuning-design.md` (Feature B).

**Prerequisites (already done, verified 2026-06-14):** `ELEVENLABS_API_KEY` is set as a prod `wrangler secret` and in local `.dev.vars` (rendered from `op://Private/games-goblin-elevenlabs/credential`). `wrangler types` already emits `ELEVENLABS_API_KEY: string` from `.dev.vars`.

**ElevenLabs API (verified against docs):** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, headers `xi-api-key` + `content-type: application/json`, body `{ text, model_id, voice_settings }`, returns binary MP3. Default model `eleven_multilingual_v2`.

---

## File Structure

- `src/server/tts.ts` — NEW. TTS constants + `synthesizeSpeech(env, text)` → streamed `audio/mpeg` `Response`.
- `src/server/index.ts` — add `POST /api/tts` (rate limit + validation + call `synthesizeSpeech`).
- `src/server/tts.test.ts` — NEW. Route tests (mocked `fetch` + `TTS_LIMITER`).
- `wrangler.jsonc` — add `TTS_LIMITER` ratelimit; `pnpm types` regenerates `env.d.ts`.
- `src/client/useGoblinVoice.ts` — NEW. Audio playback hook.
- `src/client/Chat.tsx` — Speak button in the goblin bubble + new props.
- `src/client/App.tsx` — instantiate the hook; stop on send / new conversation / back.
- `src/client/styles.css` — `.turn__speak` button style.
- `docs/adr/0006-elevenlabs-tts.md` — NEW. Records the external-TTS decision.
- `.gitignore` — un-ignore `.dev.vars.tpl` so the secret reference is documented; commit the template.

---

## Task 1: Branch and commit the plan

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/goblin-voice
```

- [ ] **Step 2: Commit the plan doc**

```bash
git add docs/superpowers/plans/2026-06-14-goblin-voice.md
git commit -m "docs: plan for the goblin voice (ElevenLabs TTS)"
```

---

## Task 2: Add the TTS rate limit and regenerate types

**Files:** Modify `wrangler.jsonc:61-64`; regenerate `env.d.ts`.

- [ ] **Step 1: Add `TTS_LIMITER` to the ratelimits array**

In `wrangler.jsonc`, replace the `ratelimits` block (lines 56-64) with (adds the third limiter + a comment line):

```jsonc
  // Abuse/cost guardrails (public, no-login). Rate limits are enforced PER-COLO, not globally,
  // and `period` must be 10 or 60 — they cap bursts, not the daily total (that's the D1
  // daily_usage breaker in the agent). namespace_id is an arbitrary integer we own.
  //   IP_LIMITER  — connection attempts per client IP on /agents/* (index.ts).
  //   MSG_LIMITER — chat messages per session (keyed by the agent instance name, agent.ts).
  //   TTS_LIMITER — /api/tts calls per client IP (index.ts); tighter, since each spends real
  //                 ElevenLabs credits.
  "ratelimits": [
    { "name": "IP_LIMITER", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
    { "name": "MSG_LIMITER", "namespace_id": "1002", "simple": { "limit": 15, "period": 60 } },
    { "name": "TTS_LIMITER", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }
  ]
```

- [ ] **Step 2: Regenerate types**

Run: `pnpm types`
Expected: `env.d.ts` now contains `TTS_LIMITER: RateLimit;` (and already has `ELEVENLABS_API_KEY: string;` from `.dev.vars`).

- [ ] **Step 3: Verify + commit**

Run: `pnpm check`
Expected: PASS.
```bash
git add wrangler.jsonc env.d.ts
git commit -m "feat(tts): add TTS_LIMITER rate limit binding"
```

---

## Task 3: Server TTS module + route (TDD)

**Files:** Create `src/server/tts.ts`, `src/server/tts.test.ts`; modify `src/server/index.ts`.

- [ ] **Step 1: Write the failing route tests**

Create `src/server/tts.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ELEVENLABS_API_KEY: "test-key",
    TTS_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as unknown as Env;
}

function ttsRequest(body: unknown, env: Env) {
  return app.request(
    "/api/tts",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/tts", () => {
  it("streams audio/mpeg for valid text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const res = await ttsRequest({ text: "Each player starts with $1500." }, fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("sends the query + voice id to ElevenLabs", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await ttsRequest({ text: "hello" }, fakeEnv());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("wXvR48IpOq9HACltTmt7");
    expect((init as RequestInit).headers).toMatchObject({ "xi-api-key": "test-key" });
  });

  it("rejects missing text with 400", async () => {
    const res = await ttsRequest({}, fakeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects over-long text with 400", async () => {
    const res = await ttsRequest({ text: "x".repeat(2001) }, fakeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    const env = fakeEnv({ TTS_LIMITER: { limit: vi.fn(async () => ({ success: false })) } } as Partial<Env>);
    const res = await ttsRequest({ text: "hello" }, env);
    expect(res.status).toBe(429);
  });

  it("returns 502 when ElevenLabs fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const res = await ttsRequest({ text: "hello" }, fakeEnv());
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tts`
Expected: FAIL (no `/api/tts` route yet — requests 404, assertions fail).

- [ ] **Step 3: Create `src/server/tts.ts`**

```ts
// ElevenLabs text-to-speech for the goblin voice. The API key is a Worker secret
// (ELEVENLABS_API_KEY) so it never reaches the browser; the route in index.ts streams the
// returned MP3 straight to the client. See docs/adr/0006.

export const TTS_VOICE_ID = "wXvR48IpOq9HACltTmt7";
export const TTS_MODEL_ID = "eleven_multilingual_v2"; // most expressive; swap to eleven_flash_v2_5 for ~half credits
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const TTS_MAX_CHARS = 2000; // rulings are capped at 600 output tokens; this bounds credit spend

/** Synthesise speech for `text` and return it as a streamed audio/mpeg Response. Throws on API error. */
export async function synthesizeSpeech(env: Env, text: string): Promise<Response> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE_ID}?output_format=${TTS_OUTPUT_FORMAT}`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${upstream.status}: ${detail.slice(0, 200)}`);
  }

  return new Response(upstream.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
```

- [ ] **Step 4: Add the route to `src/server/index.ts`**

Add the import after the existing imports (top of file):

```ts
import { synthesizeSpeech, TTS_MAX_CHARS } from "./tts";
```

Insert this route immediately after the `app.get("/api/health", …)` line (around line 21), before the `agentsMiddleware` comment block:

```ts
// Read a goblin ruling aloud via ElevenLabs (key is a server secret). Rate-limited per IP since
// each call spends real credits, and length-capped. Returns audio/mpeg; 502 on upstream failure.
app.post("/api/tts", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.TTS_LIMITER.limit({ key: ip })).success) {
    return c.text("Too Many Requests", 429, { "Retry-After": "60" });
  }
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  const text = body?.text?.trim();
  if (!text) return c.text("Missing text", 400);
  if (text.length > TTS_MAX_CHARS) return c.text("Text too long", 400);
  try {
    return await synthesizeSpeech(c.env, text);
  } catch (err) {
    console.error("[tts]", err);
    return c.text("TTS unavailable", 502);
  }
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tts`
Expected: PASS (all 6).

- [ ] **Step 6: Commit**

```bash
git add src/server/tts.ts src/server/tts.test.ts src/server/index.ts
git commit -m "feat(tts): add POST /api/tts route streaming ElevenLabs audio"
```

---

## Task 4: Client playback hook

**Files:** Create `src/client/useGoblinVoice.ts`.

- [ ] **Step 1: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export interface GoblinVoice {
  /** id of the message currently playing, or null */
  speakingId: string | null;
  /** id of the message whose audio is being fetched, or null */
  loadingId: string | null;
  /** Start reading a message aloud, or stop it if it is already the active one. */
  toggle: (id: string, text: string) => void;
  /** Stop any playback immediately. */
  stop: () => void;
}

/** Owns a single <audio> element and plays a goblin ruling via /api/tts. One thing speaks at a time. */
export function useGoblinVoice(): GoblinVoice {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const teardown = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    teardown();
    setSpeakingId(null);
    setLoadingId(null);
  }, [teardown]);

  const toggle = useCallback(
    (id: string, text: string) => {
      if (speakingId === id || loadingId === id) {
        stop();
        return;
      }
      stop();
      const clean = text.replace(/\[\d+\]/g, "").trim(); // drop inline [1][2] citation markers
      if (!clean) return;
      setLoadingId(id);
      fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`tts ${res.status}`);
          const url = URL.createObjectURL(await res.blob());
          urlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = stop;
          audio.onerror = stop;
          await audio.play();
          setLoadingId(null);
          setSpeakingId(id);
        })
        .catch(stop);
    },
    [speakingId, loadingId, stop],
  );

  useEffect(() => teardown, [teardown]); // stop on unmount

  return { speakingId, loadingId, toggle, stop };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm check`
Expected: PASS.
```bash
git add src/client/useGoblinVoice.ts
git commit -m "feat(tts): add useGoblinVoice playback hook"
```

---

## Task 5: Wire the Speak button into the chat

**Files:** Modify `src/client/Chat.tsx`, `src/client/App.tsx`, `src/client/styles.css`.

- [ ] **Step 1: Extend the `Chat` props (`src/client/Chat.tsx`)**

In the `Props` interface (after `onOpenCitation`), add:

```ts
  onToggleSpeak: (id: string, text: string) => void;
  speakingId: string | null;
  loadingId: string | null;
```

Add the three to the destructured params in `export function Chat({ … })`:

```ts
  onOpenCitation,
  onToggleSpeak,
  speakingId,
  loadingId,
```

- [ ] **Step 2: Render the Speak button in the goblin bubble**

In `Chat.tsx`, the goblin bubble currently opens with the stamp (line 88):

```tsx
                  {isGoblin ? <span className="turn__stamp">Ruling</span> : null}
```

Replace that single line with the stamp plus a Speak toggle:

```tsx
                  {isGoblin ? <span className="turn__stamp">Ruling</span> : null}
                  {isGoblin ? (
                    <button
                      type="button"
                      className="turn__speak"
                      onClick={() => onToggleSpeak(message.id, textOf(message))}
                      disabled={isStreaming}
                      aria-label={speakingId === message.id ? "Stop reading" : "Read this ruling aloud"}
                    >
                      {speakingId === message.id ? "⏹" : loadingId === message.id ? "…" : "🔊"}
                    </button>
                  ) : null}
```

- [ ] **Step 3: Wire the hook in `src/client/App.tsx`**

Add the import after the existing component imports:

```ts
import { useGoblinVoice } from "./useGoblinVoice";
```

Inside `App()`, after the `useAgentChat` destructure (line 45-48), add:

```ts
  const voice = useGoblinVoice();
```

Update the `<Chat … />` props so playback stops on a new question, new conversation, and leaving the chat — and pass the speak props. Replace the existing `onSend` / `onNewConversation` / `onBack` / `onOpenCitation` props with:

```tsx
          onSend={(text) => {
            voice.stop();
            sendMessage({ role: "user", parts: [{ type: "text", text }] });
          }}
          onStop={() => stop()}
          onNewConversation={() => {
            voice.stop();
            clearHistory();
          }}
          onBack={() => {
            voice.stop();
            setView("catalogue");
          }}
          onOpenCitation={(citation, n) => setActiveCite({ citation, n })}
          onToggleSpeak={voice.toggle}
          speakingId={voice.speakingId}
          loadingId={voice.loadingId}
```

- [ ] **Step 4: Add the `.turn__speak` style (`src/client/styles.css`)**

Insert after the `.turn__stamp { … }` rule (ends at line 425):

```css
.turn__speak {
  position: absolute;
  top: -11px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 22px;
  font-size: 12px;
  line-height: 1;
  color: var(--paper);
  background: var(--felt, #15301f);
  border: 2px solid var(--game-accent);
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.14s ease,
    color 0.14s ease;
}

.turn__speak:hover,
.turn__speak:focus-visible {
  background: var(--game-accent);
  color: var(--ink);
  outline: none;
}

.turn__speak:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm check`
Expected: PASS.
```bash
git add src/client/Chat.tsx src/client/App.tsx src/client/styles.css
git commit -m "feat(tts): add a Speak control to goblin rulings"
```

---

## Task 6: ADR + commit the secret-reference template

**Files:** Create `docs/adr/0006-elevenlabs-tts.md`; modify `.gitignore`; commit `.dev.vars.tpl`.

- [ ] **Step 1: Write ADR 0006**

First read an existing ADR (e.g. `docs/adr/0005-operator-script-ingestion.md`) and match its exact heading/format. Then create `docs/adr/0006-elevenlabs-tts.md` with this content (adapt headings to match the existing ADR style):

```markdown
# 6. ElevenLabs for goblin text-to-speech

Date: 2026-06-14

## Status

Accepted

## Context

The Parlour is "Cloudflare-native", but the goblin-voice feature needs a characterful, consistent voice. Workers AI TTS (MeloTTS, Deepgram Aura-2) only offers neutral human voices; matching the goblin character meant either client-side pitch tricks or accepting a generic narrator. We already have an ElevenLabs account and a chosen voice (`wXvR48IpOq9HACltTmt7`).

## Decision

Synthesise speech with the ElevenLabs TTS REST API (`eleven_multilingual_v2`) from a server-side `POST /api/tts` route, streaming `audio/mpeg` to the client. The `ELEVENLABS_API_KEY` is a Worker secret (prod) / `.dev.vars` entry (local, sourced from 1Password); it never reaches the browser. A dedicated `TTS_LIMITER` rate limit and a 2000-char cap bound credit spend.

## Consequences

- A non-Cloudflare paid dependency and a new external failure mode (handled as a 502; the ruling text is still on screen).
- The voice is consistent and on-character, tunable via `voice_settings` / model id (one-line swap to `eleven_flash_v2_5` halves credits).
- Reversible: swap the route's `synthesizeSpeech` for a Workers AI TTS model without touching the client.
```

- [ ] **Step 2: Un-ignore the secret-reference template and commit it**

In `.gitignore`, add a negation line immediately after the `.dev.vars.*` line so the (secret-free) template is tracked:

```
!.dev.vars.tpl
```

Confirm git no longer ignores it:
Run: `git check-ignore .dev.vars.tpl` → expected: **no output** (exit 1), meaning it is now tracked-eligible. (`.dev.vars` itself must still be ignored — verify `git check-ignore .dev.vars` still prints `.dev.vars`.)

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0006-elevenlabs-tts.md .gitignore .dev.vars.tpl
git commit -m "docs(adr): record ElevenLabs TTS decision; track .dev.vars.tpl reference"
```

---

## Task 7: Full verification and PR

- [ ] **Step 1: Run the full checks**

Run: `pnpm check && pnpm test && pnpm build`
Expected: all pass. Quote the Vitest totals line and the Vite build success line.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/goblin-voice
gh pr create --title "Give the goblin a voice (ElevenLabs TTS)" --body "$(cat <<'EOF'
## Summary
- New Hono POST /api/tts route calls ElevenLabs server-side (key stays a Worker secret) and streams audio/mpeg.
- Client useGoblinVoice() hook + a Speak control on every goblin ruling; strips [N] markers, plays the MP3, one thing speaks at a time, stops on new question / new conversation / leaving the chat.
- Dedicated TTS_LIMITER rate limit + 2000-char cap bound ElevenLabs credit spend.
- ADR 0006 records the (reversible) non-Cloudflare dependency; .dev.vars.tpl now documents the secret reference (op://Private/games-goblin-elevenlabs/credential).

## Testing
- `pnpm check`, `pnpm test`, `pnpm build` green.
- 6 route tests (mocked fetch + rate limiter): audio passthrough, correct voice/headers sent, 400 on missing/over-long text, 429 when rate-limited, 502 on upstream failure.
- Live: POST /api/tts under `pnpm dev` returns playable MP3 audio in the goblin voice.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage (Feature B):** `/api/tts` route + ElevenLabs → Task 3; `tts.ts` constants/voice/model → Task 3; secret usage (server-only) → Task 3 (+ prereqs done); `TTS_LIMITER` + length cap → Task 2 + Task 3; client Speak control + `useGoblinVoice` → Tasks 4–5; stop-on-new-question/auto-stop, disabled-while-streaming → Task 5; ADR 0006 → Task 6; no pitch shift (voice is the character) → hook uses default playbackRate. No gaps.
- **Placeholders:** none — every code step has literal code; the ADR body is provided in full.
- **Type consistency:** `synthesizeSpeech`/`TTS_MAX_CHARS` defined in Task 3 `tts.ts` and imported with those names in `index.ts` (Task 3) and exercised in `tts.test.ts` (Task 3). `useGoblinVoice` returns `{ speakingId, loadingId, toggle, stop }`; `Chat` consumes `onToggleSpeak`/`speakingId`/`loadingId` and `App` passes `voice.toggle`/`voice.speakingId`/`voice.loadingId` — names line up.
