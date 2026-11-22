import { describe, expect, it } from "vitest";
import type { Team } from "@moonagentic/protocol";
import {
  diffText,
  readBrief,
  readPlan,
  readVerdict,
  recordTimeline,
  teamStatus,
} from "../src/team.ts";

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
    expect(readVerdict("VERDICT :`OK`")).toBe("ok");
    expect(readVerdict("VERDICT : OKAY, presque")).toBeUndefined();
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

describe("recordTimeline", () => {
  it("writes down each lane's change once, when it happens", () => {
    const team = {
      phase: "planning",
      task: "t",
      coder: { agentId: "demo" },
      coders: 2,
      permissionMode: "full",
      tasks: [],
    } as Team;
    let t = recordTimeline(team, 1);
    t = recordTimeline(t, 2);
    expect(t.timeline).toEqual([{ at: 1, lane: -1, phase: "planning" }]);
    t = recordTimeline(
      { ...t, phase: "coding", tasks: [{ title: "A", brief: "a", status: "running" }] },
      5,
    );
    t = recordTimeline({ ...t, tasks: [{ title: "A", brief: "a", status: "reviewing" }] }, 9);
    t = recordTimeline(
      {
        ...t,
        phase: "merging",
        mergeThreadId: "m",
        tasks: [{ title: "A", brief: "a", status: "done" }],
      },
      12,
    );
    expect(t.timeline).toEqual([
      { at: 1, lane: -1, phase: "planning" },
      { at: 5, lane: -1, phase: "idle" },
      { at: 5, lane: 0, phase: "running" },
      { at: 9, lane: 0, phase: "reviewing" },
      { at: 12, lane: 0, phase: "done" },
      { at: 12, lane: -2, phase: "merging" },
    ]);
  });
});

describe("teamStatus", () => {
  const team: Team = {
    phase: "coding",
    task: "Deux corrections",
    coder: { agentId: "claude" },
    reviewer: { agentId: "agy" },
    coders: 2,
    permissionMode: "supervised",
    timeline: [{ at: 0, lane: -1, phase: "planning" }],
    tasks: [
      { title: "Bouton Cloner", brief: "…", status: "running", threadId: "c1" },
      {
        title: "Chargement à la demande",
        brief: "…",
        status: "reviewing",
        threadId: "c2",
        tries: 1,
        note: "Il manque un test.",
      },
    ],
  };

  it("tells the lead what each piece is at, for how long, and what its coder last said", () => {
    const said: Record<string, string> = { c1: "J'écris les tests.", c2: "" };
    const status = teamStatus(team, 7 * 60_000, (id) => said[id] ?? "");
    expect(status).toContain("Phase : les codeurs travaillent, depuis 7 min.");
    expect(status).toContain("Après le code de chaque part : relecture, fusion.");
    expect(status).toContain("Parts : 0 sur 2 terminées.");
    expect(status).toContain(
      "1. « Bouton Cloner » : le codeur travaille. Dernier message du codeur : J'écris les tests.",
    );
    expect(status).toContain(
      "2. « Chargement à la demande » : en relecture, 1 correction demandée. Remarques : Il manque un test.",
    );
  });

  it("keeps only the end of a long message", () => {
    const status = teamStatus(team, 0, () => "a".repeat(1000) + " fin");
    expect(status).toContain(`Dernier message du codeur : …${"a".repeat(396)} fin`);
    expect(status).toContain("depuis moins d'une minute");
  });
});
