import { describe, expect, it } from "vitest";
import { goalContext, goalMessage, goalVerdict } from "../src/goal.ts";

describe("a goal over several turns", () => {
  it("tells the agent the goal, its turn, and how to say where it stands", () => {
    const context = goalContext({ text: "Les tests passent", turns: 2, maxTurns: 10 });
    expect(context).toContain("tour 2 sur 10");
    expect(context).toContain("Les tests passent");
    expect(context).toContain("« OBJECTIF ATTEINT »");
    expect(context).toContain("« OBJECTIF BLOQUÉ : <la raison> »");
    expect(goalMessage({ turns: 3, maxTurns: 10 })).toBe(
      "Continue vers l'objectif (tour 3 sur 10).",
    );
  });

  it("reads the agent's last lines: reached, blocked with its reason, or still going", () => {
    expect(goalVerdict("Tout passe.\n\nOBJECTIF ATTEINT")).toEqual({ reached: true });
    expect(goalVerdict("Fait.\n**Objectif atteint.**\n")).toEqual({ reached: true });
    expect(goalVerdict("Il me faut la clé.\nOBJECTIF BLOQUÉ : il manque la clé d'API")).toEqual({
      blocked: "il manque la clé d'API",
    });
    expect(goalVerdict("OBJECTIF BLOQUE")).toEqual({
      blocked: "L'agent ne peut pas avancer sans toi.",
    });
    expect(goalVerdict("J'avance, il reste deux tests.")).toBeUndefined();
    // Quoted in the middle of a sentence, or far above the end: not a verdict.
    expect(goalVerdict("Je dirai « OBJECTIF ATTEINT » quand ce sera fini.")).toBeUndefined();
    expect(goalVerdict("OBJECTIF ATTEINT\na\nb\nc\nd")).toBeUndefined();
  });
});
