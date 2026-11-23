import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage, Team, TeamTask, Thread } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cardText, Planner, pieceStatus, threadStatus } from "../src/planner.ts";
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
    expect(plan.update(card.id, { title: "Une", threadId: "t", due: null })).toMatchObject({
      title: "Une",
      threadId: "t",
      description: "Détail",
    });
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

  it("does not lay down again a team's card the user deleted", () => {
    const { plan } = planner();
    const lead = thread("lead", { role: "lead" });
    const coding = (a: TeamTask["status"]) =>
      team("coding", [piece("A", a), piece("B", "running")]);
    plan.syncTeam({ ...lead, team: coding("running") });
    plan.remove(plan.list()[0]!.id);
    plan.syncTeam({ ...lead, team: coding("reviewing") });
    expect(plan.list().map((c) => [c.number, c.title])).toEqual([[2, "B"]]);
    // A lead deleted and another of the same id, were it to happen, starts afresh.
    plan.threadDeleted("lead");
    plan.syncTeam({ ...lead, team: coding("running") });
    expect(plan.list().map((c) => [c.number, c.title, !!c.team])).toEqual([
      [2, "B", false],
      [3, "A", true],
      [4, "B", true],
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
    // Each stays where its work had brought it.
    expect(cards.map((c) => [c.title, c.status])).toEqual([
      ["Liée", "test"],
      ["A", "doing"],
    ]);
    expect(cards.some((c) => c.threadId || c.team)).toBe(false);
    // Free of its team, the card is the user's to move.
    expect(plan.update(cards[1]!.id, { status: "report" }).status).toBe("report");
  });

  it("places a thread's card where the thread really is", () => {
    expect(threadStatus(thread("t", { status: "running" }))).toBe("doing");
    // Asking the user, or waiting for its turn, is still work under way.
    expect(threadStatus(thread("t", { status: "waiting" }))).toBe("doing");
    expect(threadStatus(thread("t", { held: "Plus tard" }))).toBe("doing");
    expect(threadStatus(thread("t", { status: "error" }))).toBe("report");
    // Its turn over, the work is the user's to check.
    expect(threadStatus(thread("t"))).toBe("test");
    const pr = { number: 1, url: "https://github.com/a/b/pull/1", checks: "none" as const };
    expect(threadStatus(thread("t", { pr: { ...pr, state: "open" } }))).toBe("test");
    expect(threadStatus(thread("t", { pr: { ...pr, state: "merged" } }))).toBe("live");
    expect(threadStatus(thread("t", { status: "error", archived: true }))).toBe("live");
    // A thread that leads a team stands where its team does.
    expect(threadStatus(thread("t", { team: team("coding", []) }))).toBe("doing");
    expect(threadStatus(thread("t", { team: team("blocked", []) }))).toBe("report");
    expect(threadStatus(thread("t", { team: team("failed", []) }))).toBe("report");
    expect(threadStatus(thread("t", { team: team("done", []) }))).toBe("test");
  });

  it("moves a card with the thread it is linked to, and only with it", () => {
    const { plan, store, sent } = planner();
    store.addThread(thread("t", { status: "running" }));
    store.addThread(thread("autre"));
    const card = plan.add({ projectId: "p", title: "Liée" });
    const free = plan.add({ projectId: "p", title: "Libre" });
    // Linked, it stands at once where its thread does.
    expect(plan.update(card.id, { threadId: "t" }).status).toBe("doing");
    expect(() => plan.update(card.id, { status: "live" })).toThrow("suit son fil");
    expect(() => plan.update(free.id, { threadId: "autre", status: "todo" })).not.toThrow();
    // Its title and its days stay the user's.
    expect(plan.update(card.id, { title: "Liée, renommée", due: 9 }).status).toBe("doing");

    sent.length = 0;
    plan.syncThread(thread("t", { status: "running" }));
    plan.syncThread(thread("sans-carte", { status: "error" }));
    expect(sent).toEqual([]);
    plan.syncThread(thread("t", { status: "error" }));
    expect(store.getPlanTask(card.id)).toMatchObject({ status: "report" });
    plan.syncThread(thread("t"));
    plan.syncThread(thread("t", { archived: true }));
    const done = store.getPlanTask(card.id)!;
    expect(done.status).toBe("live");
    expect(done.doneAt).toBeGreaterThan(0);
    expect(sent.map((m) => m.type === "planTask" && m.task.status)).toEqual([
      "report",
      "test",
      "live",
    ]);
    // Unlinked in the same change, it goes where the user says.
    expect(plan.update(card.id, { threadId: null, status: "todo" })).toMatchObject({
      status: "todo",
    });
    plan.syncThread(thread("t", { status: "running" }));
    expect(store.getPlanTask(card.id)!.status).toBe("todo");
  });

  it("brings the cards linked before to where their threads are, at start", () => {
    const { plan, store } = planner();
    store.addThread(thread("t", { archived: true }));
    // As a card linked by hand once was: wherever the user had put it.
    const now = Date.now();
    const old = {
      id: "c",
      projectId: "p",
      number: 1,
      title: "Ancienne",
      status: "todo" as const,
      source: "user" as const,
      threadId: "t",
      createdAt: now,
      updatedAt: now,
    };
    store.putPlanTask(old);
    store.putPlanTask({ ...old, id: "d", number: 2, threadId: "disparu" });
    plan.syncThreads();
    expect(plan.list().map((c) => c.status)).toEqual(["live", "todo"]);
  });

  it("starts a card's work in a new thread, once", () => {
    const { plan, store } = planner();
    const card = plan.add({
      projectId: "p",
      title: "Corriger l'export",
      description: "Sur Safari.",
    });
    expect(cardText(card)).toBe("Corriger l'export\n\nSur Safari.");
    expect(cardText(plan.add({ projectId: "p", title: "Sans détail" }))).toBe("Sans détail");
    const start = (from: { id: string }) => {
      store.addThread(thread(`fil-${from.id}`, { status: "running" }));
      return `fil-${from.id}`;
    };
    expect(plan.run(card.id, start)).toBe(`fil-${card.id}`);
    expect(store.getPlanTask(card.id)).toMatchObject({
      threadId: `fil-${card.id}`,
      status: "doing",
    });
    expect(store.getPlanTask(card.id)!.startedAt).toBeGreaterThan(0);
    expect(() => plan.run(card.id, start)).toThrow("déjà son fil");
    expect(() => plan.run("inconnue", start)).toThrow("n'existe plus");
    plan.syncTeam(thread("lead", { team: team("coding", [piece("A", "waiting")]) }));
    const ofTeam = plan.list().find((c) => c.title === "A")!;
    expect(() => plan.run(ofTeam.id, start)).toThrow("équipe");
    // Its thread deleted, the card can be started again.
    plan.threadDeleted(`fil-${card.id}`);
    store.deleteThread(`fil-${card.id}`);
    expect(plan.run(card.id, start)).toBe(`fil-${card.id}`);
  });

  it("writes down when a card's work really began and ended", () => {
    const { plan } = planner();
    const card = plan.add({ projectId: "p", title: "Un", start: 5, due: 9 });
    expect(card).toMatchObject({ start: 5, due: 9 });
    expect(card.startedAt ?? card.doneAt).toBeUndefined();
    const doing = plan.update(card.id, { status: "doing" });
    expect(doing.startedAt).toBeGreaterThan(0);
    expect(doing.doneAt).toBeUndefined();
    const live = plan.update(card.id, { status: "live" });
    expect(live.startedAt).toBe(doing.startedAt);
    expect(live.doneAt).toBeGreaterThanOrEqual(doing.startedAt!);
    // Taken up again, it is no longer done; back to « À faire », it never began.
    expect(plan.update(card.id, { status: "test" })).toMatchObject({ startedAt: doing.startedAt });
    expect(plan.update(card.id, { status: "test" }).doneAt).toBeUndefined();
    const todo = plan.update(card.id, { status: "todo", start: null });
    expect(todo.startedAt ?? todo.start).toBeUndefined();
    expect(todo.due).toBe(9);
    // A team's card is stamped by its piece's real state.
    plan.syncTeam(thread("lead", { team: team("coding", [piece("A", "running")]) }));
    expect(plan.list().find((c) => c.title === "A")!.startedAt).toBeGreaterThan(0);
  });

  it("drops a project's cards with the project", () => {
    const { plan, store } = planner();
    plan.add({ projectId: "p", title: "Un" });
    plan.add({ projectId: "q", title: "Autre" });
    store.deleteProject("p");
    expect(plan.list().map((c) => c.title)).toEqual(["Autre"]);
  });
});
