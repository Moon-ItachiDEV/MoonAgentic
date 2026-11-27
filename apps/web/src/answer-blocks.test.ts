import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { answerBlocks } from "./answer-blocks.ts";
import { localFiles } from "./local-files.ts";

/** An answer's HTML as it was written before it was cut: in one piece. */
const marked = new Marked(localFiles);
const inOnePiece = (text: string) =>
  marked.parse(text.replace(/\]\(fil:/g, "](#fil:"), { async: false, gfm: true, breaks: true });

/** All that Markdown has, without what an answer says of itself as a whole. */
const WRITTEN = [
  "# Titre",
  "",
  "Un paragraphe avec du **gras**, du `code`, un [lien](https://example.com) et un [fil](fil:abc-123).",
  "Une seconde ligne du même paragraphe.",
  "",
  "Titre souligné",
  "---",
  "",
  "- un point",
  "- un autre, avec `du code`",
  "  - un point dedans",
  "",
  "- un point après une ligne vide",
  "",
  "1. premier",
  "2. second",
  "",
  "> une citation",
  "> sur deux lignes",
  "",
  "| Fichier | Rôle |",
  "| --- | --- |",
  "| `app.ts` | le point d'entrée |",
  "",
  "```ts",
  "export const noms: Array<string> = [];",
  "",
  "## pas un titre",
  "```",
  "",
  "    du code en retrait",
  "",
  "---",
  "",
  "- [ ] à faire",
  "- [x] fait",
  "",
  "Fin, avec `<b>` qui n'est que du code.",
].join("\n");

/** What an answer says of itself as a whole: a link defined further down, images, files. */
const AS_A_WHOLE = [
  "Voir [la doc][doc] et [pingouin.png](C:\\Users\\a\\pingouin.png).",
  "",
  "Fichier enregistré : [pingouin.png](C:\\Users\\a\\pingouin.png)",
  "",
  "![Pingouin](C:\\Users\\a\\pingouin.png)",
  "",
  "[doc]: https://example.com/doc",
  "",
  "Fin.",
].join("\n");

/** HTML of the answer's own, opened in a block and closed in another. */
const WITH_HTML = [
  "Avant.",
  "",
  "<details>",
  "<summary>Voir</summary>",
  "",
  "Dedans, avec du **gras**.",
  "",
  "</details>",
  "",
  "Après.",
].join("\n");

describe("an answer cut into blocks", () => {
  it("is the HTML it was in one piece, at every length it has while it is written", () => {
    for (const text of [WRITTEN, AS_A_WHOLE, WITH_HTML, `${WRITTEN}\n\n${AS_A_WHOLE}`]) {
      for (let length = 0; length <= text.length; length += 1) {
        const written = text.slice(0, length);
        expect(answerBlocks(written).join(""), JSON.stringify(written)).toBe(inOnePiece(written));
      }
    }
  });

  it("has a block for each title, paragraph, list, table and block of code", () => {
    const blocks = answerBlocks(WRITTEN);
    expect(blocks.map((block) => /^<(\w+)/.exec(block)?.[1])).toEqual([
      "h1",
      "p",
      "h2",
      "ul",
      "ol",
      "blockquote",
      "table",
      "pre",
      "pre",
      "hr",
      "ul",
      "p",
    ]);
    // A line that looks like a title inside a block of code is code.
    expect(blocks[7]).toContain("## pas un titre");
  });

  it("changes by its last block only while it is written", () => {
    let before = answerBlocks("");
    for (let length = 1; length <= WRITTEN.length; length += 1) {
      const now = answerBlocks(WRITTEN.slice(0, length));
      // All that was there but the last block is there still, as it was.
      const settled = Math.max(0, before.length - 1);
      expect(now.slice(0, settled), JSON.stringify(WRITTEN.slice(0, length))).toEqual(
        before.slice(0, settled),
      );
      before = now;
    }
    expect(before.length).toBe(12);
  });

  it("keeps HTML of the answer's own in one piece with all that follows it", () => {
    const blocks = answerBlocks(WITH_HTML);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toBe("<p>Avant.</p>\n");
    expect(blocks[1]).toMatch(/^<details>[\s\S]*<strong>gras<\/strong>[\s\S]*<\/details>/);
    expect(blocks[1]).toContain("<p>Après.</p>");
    // A tag left open in a line reaches the blocks after it.
    expect(answerBlocks("Début.\n\nUn <b>gras jamais fermé.\n\nSuite.\n\nFin.").length).toBe(2);
    // In a table too.
    expect(answerBlocks("| a |\n| --- |\n| <b>x |\n\nSuite.").length).toBe(1);
    // Shown as code, a tag is text: each block stands alone.
    expect(answerBlocks("```html\n<b>\n```\n\nPuis `<b>`.\n\nFin.").length).toBe(3);
    // A frameset is read by what the whole page held before it: all of the answer is one piece.
    expect(answerBlocks("Début.\n\n- un point\n\n<FrameSet rows='*'>\n\nSuite.").length).toBe(1);
  });

  it("is read as a whole before it is cut", () => {
    // A link defined further down.
    expect(answerBlocks("Voir [la doc][doc].\n\nSuite.")[0]).toBe("<p>Voir [la doc][doc].</p>\n");
    expect(answerBlocks("Voir [la doc][doc].\n\nSuite.\n\n[doc]: https://example.com/doc")).toEqual(
      ['<p>Voir <a href="https://example.com/doc">la doc</a>.</p>\n', "<p>Suite.</p>\n"],
    );
    // A link to an image is shown as the image, until the answer shows one itself.
    const linked = "[pingouin.png](pingouin.png)\n\nSuite.";
    expect(answerBlocks(linked)[0]).toContain("<img");
    const shown = answerBlocks(`${linked}\n\n![Autre](autre.png)`);
    expect(shown[0]).not.toContain("<img");
    expect(shown[0]).toContain("<a ");
    expect(shown[2]).toContain("<img");
  });
});
