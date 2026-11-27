import { describe, expect, it } from "vitest";
import { stillToInstall } from "./skill-pick.ts";

describe("skills picked in a repository", () => {
  it("leaves out those the place chosen after picking already holds", () => {
    const found = [
      { name: "pdf", description: "", path: "skills/pdf" },
      { name: "docx", description: "", path: "skills/docx" },
    ];
    const picked = ["skills/pdf", "skills/docx"];
    expect(stillToInstall(picked, found, new Set())).toEqual(picked);
    // Alpha, chosen after, already has pdf.
    expect(stillToInstall(picked, found, new Set(["pdf"]))).toEqual(["skills/docx"]);
    expect(stillToInstall(["skills/gone"], found, new Set())).toEqual([]);
  });
});
