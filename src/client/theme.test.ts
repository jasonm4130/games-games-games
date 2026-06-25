import { describe, expect, it } from "vitest";
import type { Citation } from "../shared/types";
import { sourceLabel, tokenColorFor } from "./theme";

const base: Citation = {
  chunkId: "c",
  documentId: "d",
  gameName: "g",
  documentTitle: "t",
  ordinal: 0,
  pageStart: null,
  pageEnd: null,
  headingPath: null,
  text: "x",
  score: 1,
};

describe("sourceLabel", () => {
  it("prefers the section heading when present", () => {
    expect(sourceLabel({ ...base, headingPath: "Setup > Money" })).toBe("§ Setup > Money");
  });
  it("falls back to the page label for PDF-era rows", () => {
    expect(sourceLabel({ ...base, pageStart: 4, pageEnd: 5 })).toBe("p.4–5");
  });
  it("returns empty when neither is known", () => {
    expect(sourceLabel(base)).toBe("");
  });
});

describe("tokenColorFor", () => {
  it("is deterministic for a given id", () => {
    expect(tokenColorFor("catan")).toBe(tokenColorFor("catan"));
  });
  it("returns a colour from the parlour palette", () => {
    expect(tokenColorFor("gloomhaven")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
