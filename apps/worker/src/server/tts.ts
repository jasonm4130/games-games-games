// ElevenLabs text-to-speech for the goblin voice. The API key is a Worker secret
// (ELEVENLABS_API_KEY) so it never reaches the browser. TTS is NOT a public HTTP route: it is
// invoked only through the RulesAgent's `speak` @callable over the authenticated agent WebSocket
// (see src/server/agent.ts), which returns the audio as base64 to the client. See docs/adr/0006.

export const TTS_VOICE_ID = "wXvR48IpOq9HACltTmt7";
export const TTS_MODEL_ID = "eleven_multilingual_v2"; // most expressive; swap to eleven_flash_v2_5 for ~half credits
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const TTS_MAX_CHARS = 3200; // 600 output tokens ≈ up to ~3000 chars; headroom so a full ruling isn't truncated. Bounds per-call credit spend.

/**
 * Base64-encode an ArrayBuffer in chunks. Avoids `String.fromCharCode(...wholeArray)` (which
 * overflows the call stack on a multi-MB MP3) and `node:buffer` (keeps this portable across the
 * Worker runtime and the vitest-pool-workers test env). `btoa` is a Workers global.
 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Synthesise speech for `text` and return the MP3 as a base64 string. Throws on API error. */
export async function synthesizeSpeech(env: Env, text: string): Promise<string> {
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

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${upstream.status}: ${detail.slice(0, 200)}`);
  }

  return toBase64(await upstream.arrayBuffer());
}
