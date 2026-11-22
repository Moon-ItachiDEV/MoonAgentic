import type { Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  checksLabel,
  groupThreads,
  shortAgo,
  threadLine,
  waitingCount,
} from "./project-threads.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p",
  title: id,
  agentId: "demo",
  status: "idle",
  permissionMode: "supervised",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const team = (patch: Partial<Team>): Team => ({
  phase: "coding",
  task: "t",
  coder: { agentId: "demo" },
  coders: 2,
  permissionMode: "full",
  tasks: [
    { title: "API", brief: "", status: "done" },
    { title: "Écran", brief: "", status: "running" },
  ],
  ...patch,
});
const pr = (patch: Partial<NonNullable<Thread["pr"]>> = {}): NonNullable<Thread["pr"]> => ({
  url: "https://github.com/moon/demo/pull/7",
  number: 7,
  state: "open",
  checks: "passed",
  ...patch,
});

describe("a project's threads by group", () => {
  const threads = [
    thread("idle", { updatedAt: 5 }),
    thread("asks", { status: "waiting" }),
    thread("failed", { status: "error", error: "quota atteint" }),
    thread("works", { status: "running", updatedAt: 3 }),
    thread("works-later", { status: "running", updatedAt: 9 }),
    thread("green", { pr: pr() }),
    thread("checking", { pr: pr({ checks: "pending" }) }),
    thread("red", { pr: pr({ checks: "failed" }) }),
    thread("conflict", { pr: pr({ conflicts: true }) }),
    thread("held", { pr: pr({ blocked: true }) }),
    thread("draft", { pr: pr({ state: "draft" }) }),
    thread("done", { archived: true, pr: pr({ state: "merged" }) }),
    thread("lead", { role: "lead", team: team({}) }),
    thread("lead-blocked", { role: "lead", team: team({ phase: "blocked" }) }),
    thread("coder", { parentId: "lead", role: "coder", status: "waiting" }),
    thread("elsewhere", { projectId: "other", status: "waiting" }),
  ];
  const ids = (group: string) =>
    groupThreads(threads, "p")
      .find((g) => g.group === group)!
      .threads.map((t) => t.id);

  it("puts first what waits on the user, whatever the reason", () => {
    expect(groupThreads(threads, "p").map((g) => g.group)).toEqual([
      "waiting",
      "running",
      "idle",
      "resolved",
    ]);
    expect(ids("waiting").sort()).toEqual(
      ["asks", "conflict", "failed", "green", "lead-blocked", "red"].sort(),
    );
    expect(waitingCount(threads, "p")).toBe(6);
  });

  it("counts a team once, as its lead, and lists the latest first", () => {
    expect(ids("running")).toEqual(["works-later", "works", "lead"]);
    expect(ids("idle").sort()).toEqual(["checking", "draft", "held", "idle"].sort());
    expect(ids("resolved")).toEqual(["done"]);
  });

  it("keeps a running thread at work even when its pull request is ready", () => {
    expect(
      groupThreads([thread("a", { status: "running", pr: pr() })], "p")[1]!.threads,
    ).toHaveLength(1);
  });
});

describe("the line under a thread's title", () => {
  it("says why the thread waits on the user", () => {
    expect(threadLine(thread("a", { status: "waiting", summary: "x" }))).toBe("Attend ta réponse.");
    expect(threadLine(thread("a", { status: "error", error: "quota atteint" }))).toBe(
      "Erreur : quota atteint",
    );
    expect(threadLine(thread("a", { pr: pr() }))).toBe("PR #7 prête : il ne manque que ton merge.");
    expect(threadLine(thread("a", { pr: pr({ checks: "failed" }) }))).toContain("échoué");
    expect(threadLine(thread("a", { pr: pr({ conflicts: true }) }))).toContain("conflit");
    expect(
      threadLine(
        thread("a", {
          team: team({
            phase: "blocked",
            tasks: [{ title: "Écran", brief: "", status: "blocked" }],
          }),
        }),
      ),
    ).toBe("Équipe bloquée sur « Écran » : à toi de décider.");
  });

  it("says where a team is, from its real pieces", () => {
    expect(threadLine(thread("a", { team: team({}) }))).toBe(
      "Équipe au travail : 1/2 morceaux terminé.",
    );
    expect(
      threadLine(thread("a", { summary: "Voici le plan.", team: team({ phase: "done" }) })),
    ).toBe("Équipe terminée : 2 morceaux fusionnés.");
    expect(threadLine(thread("a", { team: team({ phase: "planning", tasks: [] }) }))).toBe(
      "Le chef découpe la tâche.",
    );
  });

  it("falls back on what the agent last said, and on nothing when nothing is known", () => {
    expect(threadLine(thread("a", { summary: "J'ai corrigé l'export." }))).toBe(
      "J'ai corrigé l'export.",
    );
    expect(threadLine(thread("a", { pr: pr({ checks: "pending" }), summary: "Poussé." }))).toBe(
      "Poussé.",
    );
    expect(threadLine(thread("a"))).toBe("");
    expect(threadLine(thread("a", { archived: true, pr: pr({ state: "merged" }) }))).toBe(
      "PR #7 mergée.",
    );
  });
});

describe("small labels", () => {
  it("names the checks only while the pull request is open", () => {
    expect(checksLabel(pr())).toBe("vérifications réussies");
    expect(checksLabel(pr({ checks: "pending" }))).toBe("vérifications en cours");
    expect(checksLabel(pr({ checks: "none" }))).toBe("");
    expect(checksLabel(pr({ state: "merged" }))).toBe("");
  });

  it("tells how long ago in few letters", () => {
    expect(shortAgo(0, 30_000)).toBe("maintenant");
    expect(shortAgo(0, 5 * 60_000)).toBe("5 min");
    expect(shortAgo(0, 3 * 3_600_000)).toBe("3 h");
    expect(shortAgo(0, 50 * 3_600_000)).toBe("2 j");
  });
});
