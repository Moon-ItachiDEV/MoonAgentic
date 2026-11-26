import { describe, expect, it } from "vitest";
import { splitVerdict } from "./review-verdict.ts";

describe("a review an agent ends its answer with", () => {
  it("is taken out of the text and read as a card", () => {
    const { text, verdict } = splitVerdict(
      'La PR 155 n\'est pas prête.\n\n```moon-revue\n{"verdict":"a-corriger","bloquants":[{"texte":"Les cookies passent","ou":"redact.ts:43"}],"importants":[],"remarques":["Nom flou"],"verifs":[{"texte":"Pas de conflit","ok":true}]}\n```',
    );
    expect(text).toBe("La PR 155 n'est pas prête.");
    expect(verdict).toEqual({
      ready: false,
      blocking: [{ text: "Les cookies passent", where: "redact.ts:43" }],
      important: [],
      notes: [{ text: "Nom flou" }],
      checks: [{ text: "Pas de conflit", ok: true }],
    });
  });

  it("is never ready with a blocking point, and hides a block still being written", () => {
    expect(
      splitVerdict('```moon-revue\n{"verdict":"prete","bloquants":["x"]}\n```').verdict?.ready,
    ).toBe(false);
    expect(splitVerdict('Prête.\n```moon-revue\n{"verdict":"pre')).toEqual({ text: "Prête." });
    expect(splitVerdict("Rien à voir.")).toEqual({ text: "Rien à voir." });
  });
});
