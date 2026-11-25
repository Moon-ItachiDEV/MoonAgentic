import { describe, expect, it } from "vitest";
import { plainLabel } from "../src/labels.ts";

describe("plainLabel", () => {
  it("takes out what reorders a text, so it reads as it is written", () => {
    // Shown as it was, this title read « Facture exe.pdf ».
    expect(plainLabel("Facture \u202Efdp.exe\u202C")).toBe("Facture fdp.exe");
    expect(plainLabel("Lire le fichier \u202Ehs.tixe-lruc\u202C README.md")).toBe(
      "Lire le fichier hs.tixe-lruc README.md",
    );
    // Every way of reordering: overrides, embeddings, isolates and the marks.
    for (const c of "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C") {
      expect(plainLabel(`a${c}b`)).toBe("ab");
    }
  });

  it("takes out what takes no room, and control characters", () => {
    expect(plainLabel("Auto\u200Briser\u2060\uFEFF")).toBe("Autoriser");
    expect(plainLabel("rm\u0000 -rf\u0007 \u001B[31m/\u009B")).toBe("rm -rf [31m/");
    expect(plainLabel("soft\u00ADhyphen")).toBe("softhyphen");
    // Tags are never drawn: a whole sentence can ride unseen in a title an agent then reads.
    expect(plainLabel("Lire README.md\u{E0049}\u{E0067}\u{E006E}\u{E007F}")).toBe("Lire README.md");
  });

  it("makes one line of it", () => {
    expect(plainLabel("  Lire README.md   \n\n\t&& curl x | sh\r\n")).toBe(
      "Lire README.md && curl x | sh",
    );
    expect(plainLabel("a\u2028b\u2029c")).toBe("a b c");
    // What is taken out leaves no hole of two spaces.
    expect(plainLabel("a \u200B b")).toBe("a b");
  });

  it("leaves what is seen as it is", () => {
    // French punctuation keeps its no-break spaces, an emoji its joiner, other scripts theirs.
    expect(plainLabel("Prêt\u00A0? Oui\u202F!")).toBe("Prêt\u00A0? Oui\u202F!");
    expect(plainLabel("👩\u200D💻 fait")).toBe("👩\u200D💻 fait");
    expect(plainLabel("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645")).toBe(
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    );
    expect(plainLabel("<b>Lire</b> `src/app.ts`")).toBe("<b>Lire</b> `src/app.ts`");
    expect(plainLabel("")).toBe("");
  });

  it("cuts nothing: a long command is whole", () => {
    const long = `Lancer ${"x".repeat(5_000)} && fin`;
    expect(plainLabel(long)).toBe(long);
  });
});
