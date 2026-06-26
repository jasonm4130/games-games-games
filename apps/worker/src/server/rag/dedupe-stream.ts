import type { LanguageModelMiddleware } from "ai";

/**
 * Workaround for a workers-ai-provider streaming bug (≤3.2.0).
 *
 * Workers AI's OpenAI-compatible streaming returns each token in BOTH the native `response` field
 * AND the OpenAI `choices[].delta.content` field. `getMappedStream` in workers-ai-provider emits a
 * `text-delta` for each, in two non-mutually-exclusive `if` blocks, so every token is duplicated —
 * the rendered ruling reads "MyMy precious precious …". The duplication lands in `result.text` too,
 * upstream of our UI stream, so the only clean fix is at the model-stream layer.
 *
 * The two emissions are always byte-identical and back-to-back (same SSE event), so we collapse each
 * immediately-repeated identical text-delta to one. Any non-text-delta part resets the pairing, so a
 * lone (non-doubled) delta can never be swallowed by drift. A genuinely repeated token still streams
 * twice, because the bug doubles it too (a,a,a,a → a,a). Remove this once the provider dedupes the
 * two fields upstream.
 */

// Only the fields the deduper reads; every LanguageModelV3StreamPart variant is assignable to this.
type DeltaPart = { type: string; id?: string; delta?: string };

/**
 * A stateful predicate: feed stream parts in order; returns false for the second of each identical
 * consecutive text-delta pair (drop it), true otherwise (keep it).
 */
export function makeDeltaDeduper(): (part: DeltaPart) => boolean {
  let prev: { id?: string; delta?: string } | null = null;
  return (part) => {
    if (part.type === "text-delta") {
      if (prev !== null && prev.id === part.id && prev.delta === part.delta) {
        prev = null; // drop this dup; reset so a 3rd identical token isn't over-collapsed
        return false;
      }
      prev = { id: part.id, delta: part.delta };
      return true;
    }
    prev = null; // any non-text part breaks the consecutive pairing
    return true;
  };
}

/** Array form of the deduper — used by the unit test and as the reference for the stream transform. */
export function dedupeStreamParts<T extends DeltaPart>(parts: T[]): T[] {
  return parts.filter(makeDeltaDeduper());
}

/**
 * AI SDK middleware that pipes the model stream through the deduper. Wrap the Workers AI model with
 * `wrapLanguageModel({ model, middleware: dedupeDoubledTextMiddleware })`. Only affects streaming;
 * `generateText`/`doGenerate` read the single `response` field and never double, so they pass through.
 */
export const dedupeDoubledTextMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  async wrapStream({ doStream }) {
    const { stream, ...rest } = await doStream();
    const keep = makeDeltaDeduper();
    const deduped = stream.pipeThrough(
      new TransformStream<DeltaPart, DeltaPart>({
        transform(part, controller) {
          if (keep(part)) controller.enqueue(part);
        },
      }),
    );
    return { stream: deduped as typeof stream, ...rest };
  },
};
