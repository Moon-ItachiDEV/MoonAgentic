import { describe, expect, it } from "vitest";
import type { Team, Thread } from "@moonagentic/protocol";
import {
  diffText,
  LEAD_LANE,
  readBrief,
  readPlan,
  readVerdict,
  recordTimeline,
  type TeamHost,
  Teams,
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

describe("Teams.planned", () => {
  function setupTeam(sendImpl?: (threadId: string, text: string) => void) {
    const threads = new Map<string, Thread>();
    const replies = new Map<string, string>();
    const sent: { threadId: string; text: string }[] = [];
    let seq = 0;
    const host: TeamHost = {
      thread: (id) => threads.get(id),
      threads: () => [...threads.values()],
      createThread: (input) => {
        const id = `t${++seq}`;
        threads.set(id, {
          id,
          projectId: input.projectId,
          title: input.title,
          agentId: input.agentId,
          status: "running",
          permissionMode: input.permissionMode,
          ...(input.model ? { model: input.model } : {}),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          role: input.role,
          ...(input.worksIn ? { worksIn: input.worksIn } : {}),
          ...(input.team ? { team: input.team } : {}),
          createdAt: 1,
          updatedAt: 1,
        });
        return id;
      },
      send: (threadId, text) => {
        sent.push({ threadId, text });
        sendImpl?.(threadId, text);
      },
      cancel: async () => undefined,
      setTeam: (threadId, team) => {
        const existing = threads.get(threadId);
        if (existing) threads.set(threadId, { ...existing, team });
      },
      lastReply: (threadId) => replies.get(threadId) ?? "",
      changes: async () => ({ files: [] }),
      mergeInto: async () => [],
      ship: async () => ({ prOpened: false }),
      unfinishedMerge: async () => undefined,
      contains: async () => false,
    };
    const teams = new Teams(host);
    const leadId = teams.start({
      projectId: "p1",
      task: "Construire la fonctionnalité",
      lead: { agentId: "demo" },
      coder: { agentId: "demo" },
      coders: 1,
      permissionMode: "supervised",
    });
    return { threads, replies, sent, host, teams, leadId };
  }

  it("marks the team as failed with the error when host.send throws on plan retry", () => {
    const { threads, replies, teams, leadId } = setupTeam(() => {
      throw new Error("Ce fil est archivé.");
    });
    replies.set(leadId, "Voici une réponse sans JSON.");

    expect(() => teams.turnEnded(leadId, false)).not.toThrow();

    const team = threads.get(leadId)?.team;
    expect(team?.phase).toBe("failed");
    expect(team?.planTries).toBe(1);
    expect(team?.error).toBe("Ce fil est archivé.");
    expect(teams.isActive(leadId)).toBe(false);
    expect(team?.timeline?.at(-1)).toMatchObject({ lane: LEAD_LANE, phase: "failed" });
  });

  it("marks the team as failed even when host.send throws a non-Error value", () => {
    const { threads, replies, teams, leadId } = setupTeam(() => {
      throw "canal fermé";
    });
    replies.set(leadId, "Toujours aucun plan.");

    teams.turnEnded(leadId, false);

    const team = threads.get(leadId)?.team;
    expect(team?.phase).toBe("failed");
    expect(team?.planTries).toBe(1);
    expect(team?.error).toBe("canal fermé");
    expect(teams.isActive(leadId)).toBe(false);
  });

  it("keeps the team in planning when the plan retry message is sent, then fails past MAX_PLAN_TRIES", () => {
    const { threads, replies, sent, teams, leadId } = setupTeam();
    replies.set(leadId, "Pas de bloc json.");

    teams.turnEnded(leadId, false);
    expect(threads.get(leadId)?.team?.phase).toBe("planning");
    expect(threads.get(leadId)?.team?.planTries).toBe(1);
    expect(sent).toHaveLength(1);
    expect(teams.isActive(leadId)).toBe(true);

    teams.turnEnded(leadId, false);
    expect(threads.get(leadId)?.team?.phase).toBe("planning");
    expect(threads.get(leadId)?.team?.planTries).toBe(2);
    expect(sent).toHaveLength(2);

    teams.turnEnded(leadId, false);
    expect(threads.get(leadId)?.team?.phase).toBe("failed");
    expect(threads.get(leadId)?.team?.planTries).toBe(3);
    expect(threads.get(leadId)?.team?.error).toBe("Le chef n'a pas donné de plan lisible.");
    expect(sent).toHaveLength(2);
    expect(teams.isActive(leadId)).toBe(false);
  });
});

describe("Teams.addMission", () => {
  function setup(busy?: () => boolean) {
    const threads = new Map<string, Thread>();
    const replies = new Map<string, string>();
    const sent: { threadId: string; text: string }[] = [];
    let seq = 0;
    const host = {
      thread: (id: string) => threads.get(id),
      threads: () => [...threads.values()],
      createThread: (input: Parameters<TeamHost["createThread"]>[0]) => {
        const id = `t${++seq}`;
        threads.set(id, {
          id,
          projectId: input.projectId,
          title: input.title,
          agentId: input.agentId,
          status: "running",
          permissionMode: input.permissionMode,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          role: input.role,
          ...(input.team ? { team: input.team } : {}),
          createdAt: 1,
          updatedAt: 1,
        });
        return id;
      },
      send: (threadId: string, text: string) => {
        if (busy?.() && threads.get(threadId)?.role === "lead") throw new Error("occupé");
        sent.push({ threadId, text });
      },
      cancel: async () => undefined,
      setTeam: (threadId: string, team: Team) => {
        const existing = threads.get(threadId);
        if (existing) threads.set(threadId, { ...existing, team });
      },
      lastReply: (threadId: string) => replies.get(threadId) ?? "",
      changes: async () => ({ files: [] }),
      mergeInto: async () => [],
      ship: async () => ({ prOpened: false }),
      unfinishedMerge: async () => undefined,
      contains: async () => false,
    } satisfies TeamHost;
    const teams = new Teams(host);
    const leadId = teams.start({
      projectId: "p1",
      task: "Export CSV",
      lead: { agentId: "demo" },
      coder: { agentId: "demo" },
      coders: 1,
      permissionMode: "full",
    });
    const team = () => threads.get(leadId)!.team!;
    const plan = (...titles: string[]) =>
      "```json\n" +
      JSON.stringify({ tasks: titles.map((title) => ({ title, brief: `Fais ${title}` })) }) +
      "\n```";
    return { threads, replies, sent, teams, leadId, team, plan };
  }

  it("has the lead read a mission added while it plans, then adds its pieces to the plan", () => {
    const { replies, sent, teams, leadId, team, plan } = setup();
    teams.addMission(leadId, "Ajoute aussi un bouton dans les rapports");
    expect(team().missions).toMatchObject([{ status: "waiting" }]);
    expect(sent).toHaveLength(0);

    replies.set(leadId, plan("Export"));
    teams.turnEnded(leadId, false);
    expect(team().phase).toBe("coding");
    expect(team().missions).toMatchObject([{ status: "reading" }]);
    expect(team().leadMission).toBe(0);
    const asked = sent.at(-1)!;
    expect(asked.threadId).toBe(leadId);
    expect(asked.text).toContain("Ajoute aussi un bouton dans les rapports");
    expect(asked.text).toContain("- Export (en cours)");

    replies.set(leadId, plan("Bouton"));
    teams.turnEnded(leadId, false);
    expect(team().missions).toMatchObject([{ status: "planned", added: 1 }]);
    expect(team().leadMission).toBeUndefined();
    expect(team().tasks.map((t) => [t.title, t.status])).toEqual([
      ["Export", "running"],
      ["Bouton", "waiting"],
    ]);

    // The first coder done, the mission's piece takes its place; both done, they merge.
    teams.turnEnded(team().tasks[0]!.threadId!, false);
    expect(team().tasks[1]!.status).toBe("running");
    teams.turnEnded(team().tasks[1]!.threadId!, false);
    expect(team().phase).toBe("merging");
  });

  it("keeps the team at work while a mission waits on a busy lead, and says when it is covered", () => {
    let busy = false;
    const { threads, replies, teams, leadId, team, plan } = setup(() => busy);
    replies.set(leadId, plan("Export"));
    teams.turnEnded(leadId, false);

    busy = true;
    teams.addMission(leadId, "Vérifie les accents");
    expect(team().missions).toMatchObject([{ status: "waiting" }]);
    // Its only piece done, the team still waits for the mission.
    teams.turnEnded(team().tasks[0]!.threadId!, false);
    expect(team().phase).toBe("coding");

    busy = false;
    replies.set(leadId, "Je réponds à l'utilisateur.");
    teams.turnEnded(leadId, false);
    expect(team().missions).toMatchObject([{ status: "reading" }]);

    replies.set(leadId, '```json\n{"tasks": []}\n```');
    teams.turnEnded(leadId, false);
    expect(team().missions).toMatchObject([{ status: "planned", added: 0 }]);
    expect(team().phase).toBe("done");
    expect(() => teams.addMission(leadId, "Encore")).toThrow("ne travaille plus");
    expect(threads.get(leadId)?.team?.missions).toHaveLength(1);
  });

  it("stops the missions left with the team", async () => {
    const { replies, teams, leadId, team, plan } = setup();
    replies.set(leadId, plan("Export"));
    teams.turnEnded(leadId, false);
    teams.addMission(leadId, "Une de plus");
    await teams.stop(leadId);
    expect(team().missions).toMatchObject([{ status: "stopped" }]);
    expect(team().leadMission).toBeUndefined();
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
