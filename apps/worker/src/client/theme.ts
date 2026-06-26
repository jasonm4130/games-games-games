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

/** Source label for a Citation: the section heading when known, else the page label. */
export function sourceLabel(citation: Citation): string {
  if (citation.headingPath) return `§ ${citation.headingPath}`;
  return pageLabel(citation);
}

/**
 * The parlour palette for a Game's token shape on its "hoard" card. The design uses a fixed set
 * of accents rather than a per-game hue, so each card gets a stable colour from this palette
 * (chosen by hashing the id) — varied on the shelf, deterministic, zero per-game assets.
 */
const TOKEN_PALETTE = ["#ee6a4d", "#c98a3a", "#7d5ea8", "#3f7d8f", "#2f7d4f", "#e8b04b", "#d4512f"];

export function tokenColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return TOKEN_PALETTE[
    ((hash % TOKEN_PALETTE.length) + TOKEN_PALETTE.length) % TOKEN_PALETTE.length
  ];
}
