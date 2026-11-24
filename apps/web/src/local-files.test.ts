import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { isLocalRef, localFiles, markedRef, refName, writtenRef } from "./local-files.ts";

describe("local files in answers", () => {
  it("tells a file of the computer from an address of the web", () => {
    for (const local of [
      "C:\\Users\\a\\.gemini\\antigravity\\brain\\x\\pingouin_1795.jpg",
      "C:/Users/a/pingouin.jpg",
      "file:///C:/Users/a/pingouin.jpg",
      "/home/a/pingouin.jpg",
      "pingouin_mange.jpg",
      "./images/plan.png",
    ]) {
      expect(isLocalRef(local), local).toBe(true);
    }
    for (const web of [
      "https://example.com/a.png",
      "mailto:a@b.c",
      "data:image/png;base64,AA",
      "#titre",
      "//example.com/a.png",
      "\\\\serveur\\partage\\a.png",
      "",
    ]) {
      expect(isLocalRef(web), web).toBe(false);
    }
  });

  it("keeps the backslashes of a Windows path, which Markdown takes as escapes", () => {
    const raw = "![Pingouin](C:\\Users\\alexa\\.gemini\\brain\\p_1.jpg)";
    expect(writtenRef({ raw, href: "C:\\Users\\alexa.gemini\\brain\\p_1.jpg" })).toBe(
      "C:\\Users\\alexa\\.gemini\\brain\\p_1.jpg",
    );
    expect(writtenRef({ raw: '[a](<C:\\a b\\c.png> "titre")', href: "x" })).toBe("C:\\a b\\c.png");
    // Accents and spaces as written, not as Markdown encodes them.
    expect(
      writtenRef({ raw: "![a](<C:/mon dossier/é.png>)", href: "C:/mon%20dossier/%C3%A9.png" }),
    ).toBe("C:/mon dossier/é.png");
    // A link around an image: each has its own address, the last of its text.
    expect(writtenRef({ raw: "[![alt](C:\\a\\b.png)](C:\\a\\c.png)", href: "x" })).toBe(
      "C:\\a\\c.png",
    );
    // A reference link has none in its text: Markdown's reading is kept.
    expect(writtenRef({ raw: "[a][1]", href: "images/a.png" })).toBe("images/a.png");
  });

  it("marks the images and links that name local files, and those only", () => {
    const html = new Marked(localFiles).parse(
      [
        "![Pingouin](C:\\Users\\alexa\\.gemini\\antigravity\\brain\\c1\\pingouin_mange_1795.jpg)",
        "[pingouin_mange.jpg](file:///C:/Users/alexa/Mon%20Projet/pingouin_mange.jpg)",
        "[le site](https://example.com) ![logo](https://example.com/logo.png)",
        "[![Agrandir](C:\\a\\b.png)](C:\\a\\b.png)",
      ].join("\n\n"),
      { async: false },
    );
    const refs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    expect(refs.map((r) => markedRef(r.replaceAll("&amp;", "&")))).toEqual([
      "C:\\Users\\alexa\\.gemini\\antigravity\\brain\\c1\\pingouin_mange_1795.jpg",
      "file:///C:/Users/alexa/Mon%20Projet/pingouin_mange.jpg",
      undefined,
      undefined,
      "C:\\a\\b.png",
      "C:\\a\\b.png",
    ]);
  });

  it("names a file by the last part of its path", () => {
    expect(refName("C:\\Users\\a\\pingouin.jpg")).toBe("pingouin.jpg");
    expect(refName("file:///C:/a/b.png?x=1")).toBe("b.png");
  });
});
