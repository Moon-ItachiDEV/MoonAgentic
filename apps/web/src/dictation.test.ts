import { describe, expect, it } from "vitest";
import { joinDictation, readResults } from "./dictation.ts";

const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });

describe("readResults", () => {
  it("keeps settled sentences apart from the words still heard", () => {
    expect(readResults([result("Ajoute un test", true), result(" pour le bouton", false)])).toEqual(
      { final: "Ajoute un test", interim: "pour le bouton" },
    );
  });
  it("puts a space between segments that come without one", () => {
    expect(readResults([result("Ajoute un test", true), result("pour le bouton", true)])).toEqual({
      final: "Ajoute un test pour le bouton",
      interim: "",
    });
  });
});

describe("joinDictation", () => {
  it("fills an empty composer with what was said", () => {
    expect(joinDictation("", { final: "Bonjour", interim: "à tous" })).toBe("Bonjour à tous");
  });
  it("adds the words after what was typed, with one space", () => {
    expect(joinDictation("Corrige", { final: "le bug", interim: "" })).toBe("Corrige le bug");
    expect(joinDictation("Corrige ", { final: "le bug", interim: "" })).toBe("Corrige le bug");
  });
  it("leaves the text alone when nothing was heard", () => {
    expect(joinDictation("Corrige", { final: "", interim: " " })).toBe("Corrige");
  });
});
