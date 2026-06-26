import { describe, expect, it } from "vitest";
import { buildRulesSystemPrompt } from "./prompt";

describe("buildRulesSystemPrompt", () => {
  it("pins the game name into the identity and the scope rule", () => {
    const out = buildRulesSystemPrompt("Catan", "[1] (Base Game) some rule");
    expect(out).toContain("keeper of the rulebook for Catan");
    expect(out).toContain("Answer only rules questions about Catan");
  });

  it("wraps the grounding in untrusted <passages> delimiters at the end", () => {
    const out = buildRulesSystemPrompt("Euchre", "[1] (Base Game) trump beats led suit");
    expect(out).toMatch(/<passages>\n\[1\] \(Base Game\) trump beats led suit\n<\/passages>$/);
  });

  it("places the SECURITY instructions before the passages data block (instruction/data separation)", () => {
    const out = buildRulesSystemPrompt("Euchre", "GROUNDING_HERE");
    expect(out.indexOf("SECURITY")).toBeGreaterThan(-1);
    // lastIndexOf targets the actual delimiter block at the end, not the prose mentions of
    // "<passages>" inside the GROUNDING/SECURITY sections.
    expect(out.indexOf("SECURITY")).toBeLessThan(out.lastIndexOf("<passages>"));
  });
});
