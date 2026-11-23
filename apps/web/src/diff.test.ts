import { describe, expect, it } from "vitest";
import { findRow, type LineComment, parsePatch, placeComments, reviewMessage } from "./diff.ts";

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
        {
          id: "1",
          path: "a.ts",
          line: 3,
          removed: false,
          code: "  let x = 1",
          text: "Utilise const",
        },
        { id: "2", path: "b.ts", line: 9, removed: true, code: "", text: "Garde ce test\nil sert" },
      ]),
    ).toBe(
      "Relecture de tes modifications. Corrige ces points :\n\n" +
        "- a.ts, ligne 3 :\n  `let x = 1`\n  Utilise const\n" +
        "- b.ts, ligne 9 (supprimée) :\n  Garde ce test\n  il sert",
    );
  });
});

describe("remarks anchored to their line", () => {
  const before = "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n";
  // The agent added two lines on top: every row below moved down.
  const after = "@@ -1,3 +1,5 @@\n+x\n+y\n a\n-b\n+c\n d\n";
  const onC: LineComment = {
    id: "c",
    path: "f.ts",
    line: 2,
    removed: false,
    code: "c",
    text: "Renomme",
  };
  const onB: LineComment = {
    id: "b",
    path: "f.ts",
    line: 2,
    removed: true,
    code: "b",
    text: "Garde",
  };

  it("finds a line at its place, or where it moved", () => {
    expect(findRow(parsePatch(before), onC)).toBe(3);
    expect(findRow(parsePatch(after), onC)).toBe(5);
    expect(findRow(parsePatch(after), onB)).toBe(4);
  });

  it("follows its line, not its row, when the diff changes", () => {
    const placed = placeComments([{ path: "f.ts", patch: after }], [onC, onB]);
    expect(placed.rows.get("f.ts")?.get(5)?.id).toBe("c");
    expect(placed.rows.get("f.ts")?.get(4)?.id).toBe("b");
    expect(placed.all.map((c) => [c.id, c.line, c.lost])).toEqual([
      ["c", 4, false],
      ["b", 2, false],
    ]);
  });

  it("flags a remark whose line or file is gone", () => {
    const changed = "@@ -1,3 +1,3 @@\n a\n-b\n+z\n d\n";
    const placed = placeComments(
      [{ path: "f.ts", patch: changed }],
      [onC, { ...onB, path: "g.ts" }],
    );
    expect(placed.all.map((c) => c.lost)).toEqual([true, true]);
    expect(placed.rows.get("f.ts")).toBeUndefined();
    expect(reviewMessage([placed.all[0]!])).toContain("f.ts, ligne 2, qui a changé depuis :");
  });

  it("does not guess between two same lines that both moved", () => {
    const twice = "@@ -1,1 +1,3 @@\n+c\n+c\n a\n";
    expect(findRow(parsePatch(twice), { line: 9, removed: false, code: "c" })).toBe(-1);
  });

  it("keeps every remark while the review is still loading", () => {
    const placed = placeComments(undefined, [onC]);
    expect(placed.all).toEqual([onC]);
  });
});
