import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage, Team, TeamTask, Thread } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Planner, pieceStatus } from "../src/planner.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function planner() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-plan-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const id of ["p", "q"]) store.addProject({ id, name: id, path: `/${id}`, createdAt: 1 });
  const sent: ServerMessage[] = [];
  return { store, sent, plan: new Planner(store, (m) => sent.push(m)) };
}

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p",
  title: id,
  agentId: "demo",
  status: "idle",
  permissionMode: "full",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const piece = (title: string, status: TeamTask["status"], merged = false): TeamTask => ({
  title,
  brief: `Consigne de ${title}`,
  status,
  ...(merged ? { merged } : {}),
});
const team = (phase: Team["phase"], tasks: TeamTask[]): Team => ({
  phase,
  task: "Tâche",
  coder: { agentId: "demo" },
  coders: 2,
  permissionMode: "full",
  tasks,
});

describe("planner", () => {
  it("numbers each project's cards on its own, and never gives a number twice", () => {
    const { plan, sent } = planner();
    const a = plan.add({ projectId: "p", title: "Un" });
    const b = plan.add({ projectId: "p", title: "Deux", status: "doing" });
    expect([a.number, b.number, plan.add({ projectId: "q", title: "Autre" }).number]).toEqual([
      1, 2, 1,
    ]);
    expect(a).toMatchObject({ status: "todo", source: "user" });
    plan.remove(b.id);
    expect(plan.add({ projectId: "p", title: "Trois" }).number).toBe(3);
    expect(sent.map((m) => m.type)).toEqual([
      "planTask",
      "planTask",
      "planTask",
      "planTaskRemoved",
      "planTask",
    ]);
    expect(() => plan.add({ projectId: "nulle-part", title: "x" })).toThrow("Projet introuvable");
  });

  it("changes a card, clears what is set to nothing, and links only a thread of its project", () => {
    const { plan, store } = planner();
    store.addThread(thread("t"));
    store.addThread(thread("ailleurs", { projectId: "q" }));
    const card = plan.add({ projectId: "p", title: "Un", description: "Détail", due: 1000 });
    expect(
      plan.update(card.id, { title: "Une", status: "test", threadId: "t", due: null }),
    ).toMatchObject({ title: "Une", status: "test", threadId: "t", description: "Détail" });
    const cleared = plan.update(card.id, { description: null, threadId: null });
    expect(cleared).not.toHaveProperty("description");
    expect(cleared).not.toHaveProperty("threadId");
    expect(cleared).not.toHaveProperty("due");
    expect(() => plan.update(card.id, { threadId: "ailleurs" })).toThrow("pas dans le projet");
    expect(() => plan.update("inconnue", { title: "x" })).toThrow("n'existe plus");
    expect(store.getPlanTask(card.id)).toEqual(cleared);
  });

  it("places a team's piece where its work really is", () => {
    expect(pieceStatus(piece("a", "waiting"), false)).toBe("todo");
    expect(pieceStatus(piece("a", "running"), false)).toBe("doing");
    expect(pieceStatus(piece("a", "lead"), false)).toBe("doing");
    expect(pieceStatus(piece("a", "reviewing"), false)).toBe("test");
    expect(pieceStatus(piece("a", "blocked"), false)).toBe("report");
    // Done on its branch is not delivered until merged, or until the team is done.
    expect(pieceStatus(piece("a", "done"), false)).toBe("test");
    expect(pieceStatus(piece("a", "done", true), false)).toBe("live");
    expect(pieceStatus(piece("a", "done"), true)).toBe("live");
  });

  it("lays down a card per piece of a team's plan, then moves them with the team only", () => {
    const { plan } = planner();
    const lead = thread("lead", { role: "lead" });
    plan.syncTeam({ ...lead, team: team("planning", []) });
    expect(plan.list()).toEqual([]);

    plan.syncTeam({
      ...lead,
      team: team("coding", [piece("A", "running"), piece("B", "waiting")]),
    });
    expect(plan.list()).toMatchObject([
      { number: 1, title: "A", description: "Consigne de A", status: "doing", source: "lead" },
      { number: 2, title: "B", status: "todo", team: { leadId: "lead", index: 1 } },
    ]);
    const [a] = plan.list();
    expect(() => plan.update(a!.id, { status: "live" })).toThrow("suit le travail de l'équipe");
    expect(() => plan.update(a!.id, { threadId: "t" })).toThrow("déjà liée à une équipe");
    // Its title and due day stay the user's to change.
    expect(plan.update(a!.id, { title: "A, revu", due: 5000 })).toMatchObject({ due: 5000 });

    plan.syncTeam({ ...lead, team: team("done", [piece("A", "done"), piece("B", "done")]) });
    expect(plan.list().map((c) => [c.title, c.status])).toEqual([
      ["A, revu", "live"],
      ["B", "live"],
    ]);
  });

  it("keeps the cards of a deleted thread, no longer linked to it", () => {
    const { plan, store } = planner();
    store.addThread(thread("t"));
    const linked = plan.add({ projectId: "p", title: "Liée" });
    plan.update(linked.id, { threadId: "t" });
    plan.syncTeam(thread("lead", { team: team("coding", [piece("A", "running")]) }));
    plan.threadDeleted("t");
    plan.threadDeleted("lead");
    const cards = plan.list();
    expect(cards.map((c) => [c.title, c.status])).toEqual([
      ["Liée", "todo"],
      ["A", "doing"],
    ]);
    expect(cards.some((c) => c.threadId || c.team)).toBe(false);
    // Free of its team, the card is the user's to move.
    expect(plan.update(cards[1]!.id, { status: "report" }).status).toBe("report");
  });

  it("drops a project's cards with the project", () => {
    const { plan, store } = planner();
    plan.add({ projectId: "p", title: "Un" });
    plan.add({ projectId: "q", title: "Autre" });
    store.deleteProject("p");
    expect(plan.list().map((c) => c.title)).toEqual(["Autre"]);
  });
});
