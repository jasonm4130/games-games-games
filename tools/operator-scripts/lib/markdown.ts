/**
 * Markdown helpers shared by the offline rulebook-prep scripts (heal.ts, validate-md.ts).
 *
 * Distinct from src/server/rag/chunk.ts's `parseMarkdownSections`: this keeps each ATX heading WITH
 * its body as one raw string (and any preamble before the first heading as its own section), so the
 * heal pass and the validation gate operate on identical, 1:1-aligned section lists — validate-md
 * compares them index-by-index and fails on any count drift.
 */
export function splitSections(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length) {
      sections.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length) sections.push(buf.join("\n"));
  return sections;
}
