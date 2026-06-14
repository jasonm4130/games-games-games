/**
 * heal.ts — one bounded Kimi pass per markdown section to remove residual conversion artifacts.
 *
 * Each "## ..." (or top preamble) section is healed independently at temperature 0 with a strict
 * "only fix, never add" prompt, then gated by the character-alignment guardrail (scripts/lib/align):
 * a section whose heal inserts content beyond tolerance is DISCARDED and its raw text kept. Never
 * fabricates rules. Reads/writes local markdown; no D1/Vectorize/R2 writes.
 *
 * Usage: MOONSHOT_API_KEY=... pnpm tsx scripts/heal.ts --in rulebooks/catan/tb.md --out rulebooks/catan/tb.healed.md
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { acceptHeal } from "./lib/align";
import { fail, requireEnv } from "./lib/wrangler";

const MOONSHOT_API = "https://api.moonshot.ai/v1";
const HEAL_MODEL = "kimi-k2.7-code";
const HEAL_SYSTEM =
  "You repair OCR/conversion artifacts in a single tabletop-rulebook markdown section. " +
  "Fix ONLY: broken words, letter-spacing, mojibake, stray hyphenation, and obvious spacing. " +
  "NEVER add, remove, summarize, reorder, or rephrase rules. NEVER invent numbers. " +
  "Preserve every number and markdown heading verbatim. Output ONLY the corrected section text.";

// Split on ATX headings, keeping each heading with its body. Mirrors parseMarkdownSections intent.
function splitSections(md: string): string[] {
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

async function healSection(raw: string, apiKey: string): Promise<string> {
  if (!raw.trim()) return raw;
  const response = await fetch(`${MOONSHOT_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HEAL_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: HEAL_SYSTEM },
        { role: "user", content: raw },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Moonshot ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { choices: { message: { content: string } }[] };
  const healed = json.choices[0]?.message?.content ?? raw;
  const verdict = acceptHeal(raw, healed);
  if (!verdict.accepted) {
    console.warn(`  ! kept raw section (${verdict.reason})`);
    return raw;
  }
  return healed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { in: { type: "string" }, out: { type: "string" } } });
  const inPath = values.in ?? fail("--in is required");
  const outPath = values.out ?? fail("--out is required");
  const apiKey = requireEnv("MOONSHOT_API_KEY");

  const sections = splitSections(await readFile(inPath, "utf-8"));
  console.log(`-> healing ${sections.length} sections from ${inPath}`);
  const healed: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    console.log(`  section ${i + 1}/${sections.length}`);
    healed.push(await healSection(sections[i], apiKey));
  }
  await writeFile(outPath, healed.join("\n"));
  console.log(`-> wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
