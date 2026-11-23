import { describe, expect, it } from "vitest";
import { changesUnder, fileLines, fileSize, fileTree, filterFiles } from "./file-tree.ts";

describe("the folder's tree", () => {
  it("puts folders first then files, each by name, at every level", () => {
    const tree = fileTree(["src/b.ts", "README.md", "src/a/z.ts", "src/A.ts", ".env", "docs/x.md"]);
    expect(tree.dirs.map((d) => d.path)).toEqual(["docs", "src"]);
    expect(tree.files).toEqual([".env", "README.md"]);
    const src = tree.dirs[1]!;
    expect(src.dirs.map((d) => d.path)).toEqual(["src/a"]);
    expect(src.files).toEqual(["src/A.ts", "src/b.ts"]);
    expect(src.dirs[0]!.files).toEqual(["src/a/z.ts"]);
  });

  it("finds files by a piece of their path, their own name first", () => {
    const paths = ["src/app/button.ts", "app.ts", "docs/apply.md", "lib/x.ts"];
    expect(filterFiles(paths, "APP")).toEqual(["app.ts", "docs/apply.md", "src/app/button.ts"]);
    expect(filterFiles(paths, "  ")).toEqual([]);
    expect(filterFiles(paths, "s", 2)).toHaveLength(2);
  });

  it("counts the changes under a folder, and not under one that only starts the same", () => {
    const changed = ["src/a.ts", "src/app/b.ts", "srcx/c.ts", "d.ts"];
    expect(changesUnder("src", changed)).toBe(2);
    expect(changesUnder("", changed)).toBe(4);
  });
});

describe("a file to read", () => {
  it("splits lines whatever their endings, and keeps empty lines at the end but the last", () => {
    expect(fileLines("a\r\nb\n")).toEqual(["a", "b"]);
    const text = "a\n\n\n";
    // The same text read twice gives the same lines: nothing is taken from a kept list.
    expect(fileLines(text)).toEqual(["a", "", ""]);
    expect(fileLines(text)).toEqual(["a", "", ""]);
    expect(fileLines("")).toEqual([]);
    expect(fileLines("sans fin")).toEqual(["sans fin"]);
  });

  it("says a small size in bytes, a larger one in Ko", () => {
    expect(fileSize(7)).toBe("7 o");
    expect(fileSize(1023)).toBe("1023 o");
    expect(fileSize(600 * 1024)).toBe("600 Ko");
  });
});
