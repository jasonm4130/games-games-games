/**
 * validate-md.ts — gate a healed rulebook markdown against its raw conversion. Read-only w.r.t.
 * D1/Vectorize. Writes a committed report (the reviewable artifact, since copyrighted markdown is
 * not committed). Layers: deterministic number/char preservation (hard fail), bge-m3 similarity
 * (warn), sampled Kimi faithfulness (warn). Exit non-zero on any hard fail.
 *
 * Usage: pnpm tsx scripts/validate-md.ts --raw rulebooks/catan/tb.md --healed rulebooks/catan/tb.healed.md \
 *   --report docs/research/validation/catan-tb.json [--min-similarity 0.92] [--min-preservation 0.85]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { EMBEDDING_MODEL } from "../src/server/rag/models";
import { charPreservationRatio, missingNumbers } from "./lib/preserve";
import { CF_API, fail, requireEnv, resolveCloudflareAuth } from "./lib/wrangler";

function splitSections(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length) {
      out.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

async function cosineToRaw(
  raw: string,
  healed: string,
  accountId: string,
  aiToken: string,
): Promise<number> {
  const res = await fetch(`${CF_API}/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [raw, healed] }),
  });
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${await res.text()}`);
  const { result } = (await res.json()) as { result: { data: number[][] } };
  const [a, b] = result.data;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Layer 3: a sampled Kimi faithfulness judge — does the healed section add any rule/number absent
// from the raw? Returns the verdict string ("FAITHFUL" or "FABRICATED: <added text>").
const JUDGE_MODEL = "kimi-k2.7-code";
async function judgeFaithful(raw: string, healed: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      // kimi-k2.7-code rejects any temperature but 1 ("only 1 is allowed for this model"); the judge
      // rubric below is explicit enough that the small added variance is acceptable.
      temperature: 1,
      messages: [
        {
          role: "system",
          content:
            "Compare a healed rulebook section to its raw source. Reply 'FAITHFUL' if the healed adds NO rule, number, or claim absent from the raw (spacing/casing/spelling corrections are fine). Otherwise reply 'FABRICATED: <quote the added text>'. Reply with nothing else.",
        },
        { role: "user", content: `<raw>\n${raw}\n</raw>\n<healed>\n${healed}\n</healed>` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Moonshot ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return (json.choices[0]?.message?.content ?? "").trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      raw: { type: "string" },
      healed: { type: "string" },
      report: { type: "string" },
      "min-similarity": { type: "string", default: "0.92" },
      "min-preservation": { type: "string", default: "0.85" },
      "judge-sample": { type: "string", default: "8" },
    },
  });
  const rawPath = values.raw ?? fail("--raw is required");
  const healedPath = values.healed ?? fail("--healed is required");
  const reportPath = values.report ?? fail("--report is required");
  const minSim = Number(values["min-similarity"]);
  const minPres = Number(values["min-preservation"]);

  const rawSecs = splitSections(await readFile(rawPath, "utf-8"));
  const healedSecs = splitSections(await readFile(healedPath, "utf-8"));
  if (rawSecs.length !== healedSecs.length) {
    fail(`section count drift: raw ${rawSecs.length} vs healed ${healedSecs.length}`);
  }
  const { accountId, aiToken } = await resolveCloudflareAuth();

  const sections = [];
  let hardFails = 0;
  for (let i = 0; i < rawSecs.length; i++) {
    const missing = missingNumbers(rawSecs[i], healedSecs[i]);
    const preservation = charPreservationRatio(rawSecs[i], healedSecs[i]);
    const similarity = await cosineToRaw(rawSecs[i], healedSecs[i], accountId, aiToken);
    const hardFail = missing.length > 0 || preservation < minPres;
    if (hardFail) hardFails++;
    sections.push({
      index: i,
      missing,
      preservation,
      similarity,
      similarityWarn: similarity < minSim,
      hardFail,
      judge: "",
    });
  }

  // Layer 3: judge an evenly-spaced sample of sections (always runs; cost-bounded by --judge-sample).
  const judgeApiKey = requireEnv("MOONSHOT_API_KEY");
  const sampleN = Math.min(Number(values["judge-sample"]) || 0, sections.length);
  const step =
    sampleN > 0 ? Math.max(1, Math.floor(sections.length / sampleN)) : sections.length + 1;
  for (let i = 0; i < sections.length; i += step) {
    const verdict = await judgeFaithful(rawSecs[i], healedSecs[i], judgeApiKey);
    sections[i].judge = verdict;
    if (!verdict.startsWith("FAITHFUL")) {
      sections[i].hardFail = true;
      hardFails++;
    }
  }

  const report = {
    rawPath,
    healedPath,
    thresholds: { minSim, minPres, judgeSample: sampleN },
    hardFails,
    sections,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `-> report ${reportPath}: ${hardFails} hard fail(s) across ${sections.length} sections`,
  );
  if (hardFails > 0) {
    console.error(
      "VALIDATION FAILED — fix the source/heal or escalate the converter before ingest.",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
