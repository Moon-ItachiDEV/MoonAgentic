import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { createLocalFiles } from "./local-files.ts";
import { advanceMarkdownBlocks, EMPTY_BLOCKS } from "./markdown-blocks.ts";

describe("advanceMarkdownBlocks", () => {
  it("freezes completed paragraphs incrementally and preserves references when the tail changes", () => {
    const s1 = advanceMarkdownBlocks(EMPTY_BLOCKS, "Premier paragraphe.");
    expect(s1.committed).toEqual([]);
    expect(s1.offset).toBe(0);

    // Trailing blank line alone waits until the next block actually starts.
    const s2 = advanceMarkdownBlocks(s1, "Premier paragraphe.\n\n");
    expect(s2).toBe(EMPTY_BLOCKS);

    const s3 = advanceMarkdownBlocks(s2, "Premier paragraphe.\n\nDeuxième paragraphe");
    expect(s3.committed).toEqual(["Premier paragraphe."]);
    expect("Premier paragraphe.\n\nDeuxième paragraphe".slice(s3.offset)).toBe(
      "Deuxième paragraphe",
    );

    // Growing the tail or trimming an unclosed link at the tail keeps the same committed array.
    const t4 = "Premier paragraphe.\n\nDeuxième paragraphe avec suite";
    const s4 = advanceMarkdownBlocks(s3, t4);
    expect(s4).toBe(s3);
    expect(s4.committed).toBe(s3.committed);

    const t5 = "Premier paragraphe.\n\nDeuxième";
    const s5 = advanceMarkdownBlocks(s4, t5);
    expect(s5).toBe(s3);
  });

  it("never splits inside fenced code blocks containing blank lines", () => {
    const openFence = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    const s1 = advanceMarkdownBlocks(EMPTY_BLOCKS, openFence);
    expect(s1.committed).toEqual(["Intro."]);
    expect(openFence.slice(s1.offset)).toBe("```ts\nconst a = 1;\n\nconst b = 2;");

    const closed = `${openFence}\n\`\`\`\n\nConclusion.`;
    const s2 = advanceMarkdownBlocks(s1, closed);
    expect(s2.committed).toEqual(["Intro.", "```ts\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(closed.slice(s2.offset)).toBe("Conclusion.");
  });

  it("handles tilde fences and backticks inside tilde fences", () => {
    const md = "~~~md\n```\ncode\n\nmore\n~~~\n\nAfter.";
    const s = advanceMarkdownBlocks(EMPTY_BLOCKS, md);
    expect(s.committed).toEqual(["~~~md\n```\ncode\n\nmore\n~~~"]);
    expect(md.slice(s.offset)).toBe("After.");
  });

  it("keeps indented continuations, blockquotes and short loose lists together", () => {
    const looseList = "- premier\n\n- deuxième\n\n  suite indentée\n\nParagraphe final.";
    const s = advanceMarkdownBlocks(EMPTY_BLOCKS, looseList);
    expect(s.committed).toEqual(["- premier\n\n- deuxième\n\n  suite indentée"]);
    expect(looseList.slice(s.offset)).toBe("Paragraphe final.");

    const quote = "> ligne 1\n\n> ligne 2\n\nHors citation.";
    const sq = advanceMarkdownBlocks(EMPTY_BLOCKS, quote);
    expect(sq.committed).toEqual(["> ligne 1\n\n> ligne 2"]);
    expect(quote.slice(sq.offset)).toBe("Hors citation.");
  });

  it("does not split inside open block-level HTML tags or comments", () => {
    const details = "<details>\n<summary>Voir</summary>\n\nContenu\n\n</details>\n\nSuite.";
    const s = advanceMarkdownBlocks(EMPTY_BLOCKS, details);
    expect(s.committed).toEqual(["<details>\n<summary>Voir</summary>\n\nContenu\n\n</details>"]);
    expect(details.slice(s.offset)).toBe("Suite.");
  });

  it("waits when the tail ends on an ambiguous single-character list or quote prefix", () => {
    const partial = "- un\n\n-";
    const s = advanceMarkdownBlocks(EMPTY_BLOCKS, partial);
    expect(s.committed).toEqual([]);
  });

  it("resets cleanly if the text prefix no longer matches", () => {
    const s1 = advanceMarkdownBlocks(EMPTY_BLOCKS, "Bloc A\n\nBloc B");
    expect(s1.committed).toEqual(["Bloc A"]);
    const s2 = advanceMarkdownBlocks(s1, "Autre début\n\nSuite");
    expect(s2.committed).toEqual(["Autre début"]);
  });
});

describe("createLocalFiles cross-block image tracking", () => {
  it("suppresses a redundant image link in a later block instead of duplicating the image", () => {
    const shown: string[] = [];
    const parse = (chunk: string) => {
      const found: string[] = [];
      const html = new Marked(
        createLocalFiles({
          earlierImages: () => shown,
          onImage: (ref) => found.push(ref),
        }),
      ).parse(chunk, { async: false, gfm: true, breaks: true });
      shown.push(...found);
      return html;
    };

    const first = parse("Voici le graphique :\n\n![Graphique](C:/a/chart.png)");
    expect(first.match(/<img\b/g)).toHaveLength(1);
    expect(shown).toEqual(["C:/a/chart.png"]);

    const second = parse("Fichier enregistré : [chart.png](chart.png)");
    expect(second).not.toContain("<img");
    expect(second).not.toContain("<a");
    expect(second).not.toContain("Fichier enregistré");
  });
});
