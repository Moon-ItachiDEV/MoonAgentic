import { describe, expect, it } from "vitest";
import { computeEyePose, type FrostMoonState, restLife } from "./FrostMoon.tsx";

const RESTING: FrostMoonState[] = ["repos", "termine", "erreur"];
const WORKING: FrostMoonState[] = [
  "pense",
  "cherche",
  "lit",
  "ecrit",
  "tests",
  "travaille",
  "file",
];

describe("une lune au repos", () => {
  it("garde des signes de vie, espacés : rien ne tourne entre deux", () => {
    for (const state of RESTING) {
      const life = restLife(state)!;
      // Un mouvement de temps en temps, jamais plus d'un toutes les trois secondes.
      expect(life.move[0]).toBeGreaterThanOrEqual(3000);
      expect(life.move[1]).toBeGreaterThan(life.move[0]);
      // Un élan court : la boucle se rendort bien avant le mouvement suivant.
      expect(life.burst * 1000).toBeLessThan(life.move[0] / 2);
      if (life.blink) expect(life.blink[0]).toBeGreaterThanOrEqual(2000);
    }
  });

  it("cligne et regarde ailleurs au repos, sans élan à jouer", () => {
    expect(restLife("repos")).toMatchObject({ blink: [2400, 5500], burst: 0 });
  });

  it("ne cligne pas quand ses yeux rient, mais se balance un instant", () => {
    const life = restLife("termine")!;
    expect(life.blink).toBeNull();
    expect(life.burst).toBeGreaterThan(0);
  });

  it("cligne et frémit un instant en erreur", () => {
    const life = restLife("erreur")!;
    expect(life.blink).not.toBeNull();
    expect(life.burst).toBeGreaterThan(0);
  });

  it("commence chaque élan depuis sa pose posée, sans saut", () => {
    for (const state of ["termine", "erreur"] as const) {
      const still = computeEyePose(state, 0);
      expect(still.gx).toBe(0);
      expect(still.tilt).toBe(0);
      expect(still.jitterX).toBe(0);
    }
  });

  it("finit le frémissement de colère presque éteint", () => {
    const end = computeEyePose("erreur", restLife("erreur")!.burst);
    // Moins d'une unité sur un dessin de 240 : le retour à la pose posée ne se voit pas.
    expect(Math.abs(end.jitterX)).toBeLessThan(1);
  });

  it("laisse un état au travail s'animer sans arrêt", () => {
    for (const state of WORKING) expect(restLife(state)).toBeNull();
  });
});
