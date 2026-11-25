import { describe, expect, it } from "vitest";
import { labelStart, plainLabel } from "../src/labels.ts";

/** A text from its code points: the characters these tests are about cannot be read here. */
const u = (...points: number[]) => String.fromCodePoint(...points);

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

  it("takes out what no font draws, whatever its kind", () => {
    const undrawn = [
      // Fillers of Korean, the joiner of accents, two Khmer vowels that are never written.
      [0x115f, 0x1160, 0x3164, 0xffa0, 0x34f, 0x17b4, 0x17b5],
      // Code points kept for later, which a font is told to ignore.
      [0x2065, 0xfff0, 0xe0000, 0xe0080, 0xe0fff],
      // Format characters of hieroglyphs, of shorthand and of music.
      [0x13430, 0x1bca0, 0x1d173],
    ].flat();
    for (const point of undrawn) {
      expect(plainLabel(`a${u(point)}b`), point.toString(16)).toBe("ab");
    }
    // A label of them alone is no label, the blank of braille included.
    expect(plainLabel(u(0x3164, 0x115f, 0x1160, 0xffa0, 0x2800))).toBe("");
    expect(plainLabel(u(0x200c, 0x200d, 0xfe0f, 0xe0100))).toBe("");
    // The number signs of Arabic are format characters too, and are drawn: they stay.
    expect(plainLabel(u(0x600, 0x661, 0x662))).toBe(u(0x600, 0x661, 0x662));
  });

  it("keeps a variation selector or a joiner where it does something, and no run of them", () => {
    const heart = u(0x2764, 0xfe0f);
    const keycap = u(0x31, 0xfe0f, 0x20e3);
    const ideograph = u(0x845b, 0xe0100);
    expect(plainLabel(`${heart} ${keycap} ${ideograph}`)).toBe(`${heart} ${keycap} ${ideograph}`);
    // Thirty selectors after a letter: a text of thirty bytes that takes no room.
    const run = Array.from({ length: 30 }, (_, i) => u(0xe0100 + i)).join("");
    expect(plainLabel(`Lire a${run}`)).toBe("Lire a");
    expect(plainLabel(`a${u(0xfe00, 0xfe01, 0xfe02)}`)).toBe(`a${u(0xfe00)}`);
    expect(plainLabel(`${u(0xfe0f)}a ${u(0xfe0f)}b`)).toBe("a b");
    // Nor can what is taken out between them hide a run.
    expect(plainLabel(`a${u(0x200b, 0xfe00, 0x200b, 0xfe01)}`)).toBe(`a${u(0xfe00)}`);
    expect(plainLabel(`a${u(0x200d, 0x200d, 0x200c)}b`)).toBe(`a${u(0x200d)}b`);
    expect(plainLabel(`a ${u(0x200d)} b`)).toBe("a b");
  });

  it("keeps the three flags written with tags, and no other text written with them", () => {
    const flag = (region: string) =>
      u(0x1f3f4, ...[...region].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f);
    for (const region of ["gbeng", "gbsct", "gbwls"]) {
      expect(plainLabel(`Match ${flag(region)}`)).toBe(`Match ${flag(region)}`);
    }
    expect(plainLabel(flag("ignore tout"))).toBe(u(0x1f3f4));
  });

  it("keeps words apart where a line or a field ended", () => {
    expect(plainLabel(`un${u(0x85)}deux${u(0x1c)}trois${u(0x1f)}quatre`)).toBe(
      "un deux trois quatre",
    );
    expect(plainLabel(`un${u(0x2800)}deux`)).toBe("un deux");
  });

  it("shows half a character as the sign it is drawn as", () => {
    const half = String.fromCharCode(0xd83d);
    expect(plainLabel(`a${half}b`)).toBe(`a${u(0xfffd)}b`);
    expect(plainLabel("a😀b")).toBe("a😀b");
  });
});

describe("labelStart", () => {
  it("cuts between two characters as a reader counts them", () => {
    expect(labelStart("abc", 3)).toBe("abc");
    expect(labelStart("abcdef", 3)).toBe("abc");
    const family = u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const cases = [
      // An emoji is two units long, a flag four, a family eight, an accent may be its own.
      "😀",
      u(0x1f1eb, 0x1f1f7),
      family,
      u(0x65, 0x301),
      u(0x31, 0xfe0f, 0x20e3),
    ];
    for (const one of cases) {
      expect(labelStart(`ab${one}cd`, 3), one).toBe("ab");
      expect(labelStart(`ab${one}cd`, 2 + one.length), one).toBe(`ab${one}`);
    }
  });

  it("still cuts a single character longer than the whole label, and not in a code point", () => {
    const pile = `e${u(0x301).repeat(40)}`;
    expect(labelStart(pile, 10)).toBe(pile.slice(0, 10));
    expect(labelStart(`😀${u(0x301).repeat(40)}`, 1)).toBe("");
  });
});
