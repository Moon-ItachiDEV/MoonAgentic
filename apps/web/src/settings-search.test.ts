import { describe, expect, it } from "vitest";
import { matchSections } from "./settings-search.ts";

const sections = [{ label: "Général" }, { label: "Apparence" }, { label: "Accès distant" }];

describe("matchSections", () => {
  it("keeps every section when nothing is typed", () => {
    expect(matchSections(sections, "  ")).toHaveLength(3);
  });
  it("finds a section whatever the accents and case", () => {
    expect(matchSections(sections, "acces").map((s) => s.label)).toEqual(["Accès distant"]);
    expect(matchSections(sections, "GÉN").map((s) => s.label)).toEqual(["Général"]);
  });
  it("finds nothing when no name holds the words", () => {
    expect(matchSections(sections, "voix")).toEqual([]);
  });
});
