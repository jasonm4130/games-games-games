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
