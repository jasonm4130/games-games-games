import type { UIMessage } from "ai";
import type { RetrievedChunk } from "../../shared/types";

/** Each user message's text (its text parts joined + trimmed), oldest→newest, skipping empties. */
export function userTexts(messages: UIMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) texts.push(text);
  }
  return texts;
}

/** A passage's source-document label: the base game by title alone, an expansion tagged as such. */
function documentLabel(passage: RetrievedChunk): string {
  return passage.documentKind === "base"
    ? passage.documentTitle
    : `${passage.documentTitle} — ${passage.documentKind}`;
}

/**
 * Number and label each retrieved passage for the model's grounding block. The `[N]` markers key
 * the inline citations; the document label lets the goblin tell a base-game rule from an
 * expansion's and scope its ruling accordingly.
 */
export function formatGrounding(passages: RetrievedChunk[]): string {
  return passages
    .map((passage, i) => `[${i + 1}] (${documentLabel(passage)}) ${passage.chunk.text}`)
    .join("\n\n");
}
