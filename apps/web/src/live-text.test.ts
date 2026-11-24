import { describe, expect, it } from "vitest";
import { withoutOpenLink } from "./live-text.ts";

describe("a text being written", () => {
  it("does not show the link or image still open at its end", () => {
    const said = "Naruto savoure un bol de ramen.\n\n";
    for (const open of [
      "[Ouvrir",
      "[Ouvrir l'image]",
      "[Ouvrir l'image](",
      "[Ouvrir l'image](<C:/Users/BreezyHomeCinéma/.codex/generated_imag",
      "![Naruto](C:\\Users\\a\\.codex\\ig_",
    ]) {
      expect(withoutOpenLink(said + open), open).toBe(said);
    }
    // Closed, or no link at all: as written.
    for (const whole of [
      said + "[Ouvrir l'image](<C:/Users/a b/ig_1.png>)",
      said + "[a](b.png) puis la suite",
      "tableau[0] vaut 1",
      said,
    ]) {
      expect(withoutOpenLink(whole), whole).toBe(whole);
    }
  });
});
