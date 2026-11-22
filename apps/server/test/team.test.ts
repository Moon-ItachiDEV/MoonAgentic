import { describe, expect, it } from "vitest";
import { diffText, readBrief, readPlan, readVerdict } from "../src/team.ts";

describe("readPlan", () => {
  it("reads the last json block of the lead's reply", () => {
    const reply =
      'Un exemple :\n```json\n{"tasks": [{"title": "x", "brief": "y"}]}\n```\nLe plan :\n```json\n{"tasks": [{"title": "A", "brief": "Fais A"}, {"title": "B", "brief": "Fais B"}]}\n```';
    expect(readPlan(reply)).toEqual([
      { title: "A", brief: "Fais A" },
      { title: "B", brief: "Fais B" },
    ]);
  });

  it("takes a plan without its fence, and drops pieces that lack a title or a brief", () => {
    expect(
      readPlan(
        'Voici : {"tasks": [{"title": "A", "brief": "Fais A"}, {"title": "", "brief": "?"}, {"brief": "x"}]}',
      ),
    ).toEqual([{ title: "A", brief: "Fais A" }]);
  });

  it("reads a bare plan laid out on several lines, with text after it, and a ```JSON fence", () => {
    const plan = [{ title: "A", brief: 'Fais "A" {vite}' }];
    expect(
      readPlan(
        `Le plan :\n{\n  "tasks": [\n    {"title": "A", "brief": "Fais \\"A\\" {vite}"}\n  ]\n}\nBon courage !`,
      ),
    ).toEqual(plan);
    expect(readPlan(`{ "tasks" : [{"title": "A", "brief": "Fais \\"A\\" {vite}"}] } fin`)).toEqual(
      plan,
    );
    expect(readPlan('```JSON\n{"tasks": [{"title": "B", "brief": "Fais B"}]}\n```')).toEqual([
      { title: "B", brief: "Fais B" },
    ]);
  });

  it("finds no plan in prose or broken json, and keeps eight pieces at most", () => {
    expect(readPlan("Je préfère ne pas faire de plan.")).toBeUndefined();
    expect(readPlan('```json\n{"tasks": [\n```')).toBeUndefined();
    const many = { tasks: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, brief: "b" })) };
    expect(readPlan("```json\n" + JSON.stringify(many) + "\n```")).toHaveLength(8);
  });
});

describe("readVerdict, readBrief and diffText", () => {
  it("reads the last verdict, however it is written", () => {
    expect(readVerdict("Bien.\n\nVERDICT : OK")).toBe("ok");
    expect(readVerdict("**Verdict: à corriger**")).toBe("fix");
    expect(readVerdict("VERDICT : À CORRIGER\n… puis, revu : VERDICT : OK")).toBe("ok");
    expect(readVerdict("VERDICT : A CORRIGER")).toBe("fix");
    expect(readVerdict("Ça me paraît correct.")).toBeUndefined();
  });

  it("reads the brief the lead rewrote", () => {
    expect(readBrief('```json\n{"brief": "Fais A, pas B."}\n```')).toBe("Fais A, pas B.");
    expect(readBrief('Voici : {\n  "brief": "Fais A"\n} Bon courage.')).toBe("Fais A");
    expect(readBrief('{"brief": "  "}')).toBeUndefined();
  });

  it("shows each file's changes, and cuts what is too long to read at once", () => {
    const file = (path: string, patch: string) =>
      ({ path, status: "modified", added: 1, removed: 1, patch }) as const;
    const text = diffText({
      files: [file("a.ts", "@@ -1 +1 @@\n-a\n+b"), file("big.ts", "x".repeat(70_000))],
      omitted: 2,
    });
    expect(text).toContain("--- a.ts (modified, +1 -1)\n@@ -1 +1 @@\n-a\n+b\n");
    expect(text).toContain("--- big.ts (modified, +1 -1)\n(diff coupé : ouvre le fichier)");
    expect(text).toContain("2 autres fichiers");
    expect(text.length).toBeLessThan(1_000);
  });
});
