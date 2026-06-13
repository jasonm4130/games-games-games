import type { UIMessage } from "ai";
import type { Citation, RulesUIMessage } from "../shared/types";

/** Concatenate the text parts of a message. */
export function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The authoritative Citation list a message carries (its `data-citations` part), or []. */
export function citationsOf(message: RulesUIMessage): Citation[] {
  for (const part of message.parts) {
    if (part.type === "data-citations") return part.data;
  }
  return [];
}

/** Human page label for a Citation, e.g. "p.4–5" or "p.7"; "" when the source is unpaginated. */
export function pageLabel(citation: Citation): string {
  if (citation.pageStart == null) return "";
  if (citation.pageEnd != null && citation.pageEnd !== citation.pageStart) {
    return `p.${citation.pageStart}–${citation.pageEnd}`;
  }
  return `p.${citation.pageStart}`;
}

/**
 * A stable accent colour for a Game, derived from its id. Every Game reads as its own hue
 * (consumed as the `--game-accent` CSS var) with zero per-game assets — so the chat and its
 * catalogue tile share a colour, and a new Game is distinct the moment it is onboarded.
 * Hues are kept off the muddy yellow-green band (90–150°) so accents pop against the felt.
 */
export function accentFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const raw = ((hash % 360) + 360) % 360;
  const hue = raw >= 90 && raw < 150 ? (raw + 120) % 360 : raw;
  return `hsl(${hue} 72% 56%)`;
}
