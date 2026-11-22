import { describe, expect, it } from "vitest";
import { parsePatch, reviewMessage } from "./diff.ts";

describe("parsePatch", () => {
  it("numbers lines in the old and the new file", () => {
    const lines = parsePatch(
      "@@ -10,3 +10,4 @@ function f() {\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n",
    );
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@ function f() {" },
      { kind: "same", text: "a", old: 10, new: 10 },
      { kind: "del", text: "b", old: 11 },
      { kind: "add", text: "c", new: 11 },
      { kind: "add", text: "d", new: 12 },
      { kind: "same", text: "e", old: 12, new: 13 },
      { kind: "note", text: "No newline at end of file" },
    ]);
  });

  it("reads a new file's single-line hunk header", () => {
    expect(parsePatch("@@ -0,0 +1 @@\n+x")).toEqual([
      { kind: "hunk", text: "@@ -0,0 +1 @@" },
      { kind: "add", text: "x", new: 1 },
    ]);
  });
});

describe("reviewMessage", () => {
  it("lists each remark with its place and code", () => {
    expect(
      reviewMessage([
        { path: "a.ts", line: 3, removed: false, code: "  let x = 1", text: "Utilise const" },
        { path: "b.ts", line: 9, removed: true, code: "", text: "Garde ce test\nil sert" },
      ]),
    ).toBe(
      "Relecture de tes modifications. Corrige ces points :\n\n" +
        "- a.ts, ligne 3 :\n  `let x = 1`\n  Utilise const\n" +
        "- b.ts, ligne 9 (supprimée) :\n  Garde ce test\n  il sert",
    );
  });
});
