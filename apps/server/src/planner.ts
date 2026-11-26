import { randomUUID } from "node:crypto";
import type { PlanStatus, PlanTask, ServerMessage, TeamTask, Thread } from "@moonagentic/protocol";
import type { Store } from "./store.ts";

const LAID = "planLaid";
const FOLLOWS_TEAM = "Cette carte suit le travail de l'équipe : son état change avec lui.";
const FOLLOWS_THREAD =
  "Cette carte suit son fil : son état change avec lui. Délie le fil pour la déplacer à la main.";

/** Where a team's piece stands on the board, from what its agents are really doing. */
export function pieceStatus(task: TeamTask, teamDone: boolean): PlanStatus {
  switch (task.status) {
    case "waiting":
      return "todo";
    case "running":
    case "lead":
      return "doing";
    case "reviewing":
    case "judging":
    case "testing":
      return "test";
    case "blocked":
    case "failed":
    case "stopped":
      return "report";
    case "done":
      // Done on its branch is not delivered: it is once merged, or once the team is done.
      return task.merged || teamDone ? "live" : "test";
  }
}

/**
 * Where the card of a thread stands on the board, from what the thread is really doing:
 * at work or asking the user, it is being done; stopped on an error, it is held back; its
 * turn over, it is the user's to check; resolved or its pull request merged, it is delivered.
 */
export function threadStatus(thread: Thread): PlanStatus {
  if (thread.archived || thread.pr?.state === "merged") return "live";
  const team = thread.team?.phase;
  if (thread.status === "error" || team === "failed" || team === "blocked") return "report";
  if (
    thread.status === "running" ||
    thread.status === "waiting" ||
    !!thread.held ||
    team === "planning" ||
    team === "coding" ||
    team === "merging"
  )
    return "doing";
  return "test";
}

/** What a thread started from a card is first told: the card's title, then its description. */
export const cardText = (card: PlanTask): string =>
  card.description ? `${card.title}\n\n${card.description}` : card.title;

/**
 * Writes down when the card's work really began and ended, from where it now stands: it
 * began when it first left « À faire », and ended when it was delivered.
 */
export function stamped(task: PlanTask, now: number): PlanTask {
  const { startedAt, doneAt, ...rest } = task;
  if (task.status === "todo") return rest;
  const started = startedAt ?? now;
  return task.status === "live"
    ? { ...rest, startedAt: started, doneAt: doneAt ?? now }
    : { ...rest, startedAt: started };
}

export interface PlanAdd {
  projectId: string;
  title: string;
  description?: string | undefined;
  status?: PlanStatus | undefined;
  start?: number | undefined;
  due?: number | undefined;
}

export interface PlanPatch {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: PlanStatus | undefined;
  start?: number | null | undefined;
  due?: number | null | undefined;
  threadId?: string | null | undefined;
}

/**
 * Each project's planner: cards the user writes, and the cards a team's lead lays down with
 * its plan. A team's card moves only as its piece really does.
 */
export class Planner {
  private readonly store: Store;
  private readonly broadcast: (message: ServerMessage) => void;
  /** The threads some card follows, so that any other thread's change costs nothing here. */
  private followed: Set<string> | undefined;

  constructor(store: Store, broadcast: (message: ServerMessage) => void) {
    this.store = store;
    this.broadcast = broadcast;
  }

  list(): PlanTask[] {
    return this.store.listPlanTasks();
  }

  add(input: PlanAdd, extra: Pick<PlanTask, "source" | "team"> = { source: "user" }): PlanTask {
    const now = Date.now();
    const task: PlanTask = {
      id: randomUUID(),
      projectId: input.projectId,
      number: this.store.nextPlanNumber(input.projectId),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      status: input.status ?? "todo",
      source: extra.source,
      ...(extra.team ? { team: extra.team } : {}),
      ...(input.start ? { start: input.start } : {}),
      ...(input.due ? { due: input.due } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.put(task);
  }

  update(id: string, patch: PlanPatch): PlanTask {
    const task = this.store.getPlanTask(id);
    if (!task) throw new Error("Cette carte n'existe plus.");
    const next: PlanTask = { ...task };
    // A card whose thread is gone is free again, whatever it still names.
    const linked = patch.threadId !== undefined ? patch.threadId : this.threadOf(task)?.id;
    if (patch.status !== undefined && patch.status !== task.status) {
      if (task.team) throw new Error(FOLLOWS_TEAM);
      if (linked) throw new Error(FOLLOWS_THREAD);
      next.status = patch.status;
    }
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) {
      if (patch.description) next.description = patch.description;
      else delete next.description;
    }
    if (patch.start !== undefined) {
      if (patch.start) next.start = patch.start;
      else delete next.start;
    }
    if (patch.due !== undefined) {
      if (patch.due) next.due = patch.due;
      else delete next.due;
    }
    if (patch.threadId !== undefined) {
      if (patch.threadId === null) delete next.threadId;
      else {
        if (task.team) throw new Error("Cette carte est déjà liée à une équipe.");
        const thread = this.store.getThread(patch.threadId);
        if (!thread || thread.projectId !== task.projectId) {
          throw new Error("Ce fil n'est pas dans le projet de la carte.");
        }
        next.threadId = thread.id;
        // From now on the card stands where its thread does.
        next.status = threadStatus(thread);
      }
    }
    return this.put({ ...next, updatedAt: Date.now() });
  }

  /**
   * Starts the card's work in a new thread, made by `start` from the card, and links the two.
   * A card a team does, or one whose thread still exists, is not started again.
   */
  run(id: string, start: (card: PlanTask) => string): string {
    const card = this.store.getPlanTask(id);
    if (!card) throw new Error("Cette carte n'existe plus.");
    if (card.team) throw new Error("Cette carte est déjà confiée à une équipe.");
    if (this.threadOf(card)) throw new Error("Cette carte a déjà son fil : ouvre-le.");
    const threadId = start(card);
    const thread = this.store.getThread(threadId);
    this.put({
      ...card,
      threadId,
      status: thread ? threadStatus(thread) : "doing",
      updatedAt: Date.now(),
    });
    return threadId;
  }

  /** Moves the cards that follow this thread to where it now stands. Called as it changes. */
  syncThread(thread: Thread): void {
    this.followed ??= new Set(this.list().flatMap((c) => (c.threadId ? [c.threadId] : [])));
    if (!this.followed.has(thread.id)) return;
    const status = threadStatus(thread);
    for (const card of this.list()) {
      if (card.threadId !== thread.id || card.team || card.status === status) continue;
      this.put({ ...card, status, updatedAt: Date.now() });
    }
  }

  /**
   * Brings every linked card to where its thread stands. Called once at start: a card
   * linked before cards followed their thread is then where its thread really is.
   */
  syncThreads(): void {
    for (const card of this.list()) {
      const thread = card.team ? undefined : this.threadOf(card);
      if (!thread) continue;
      const status = threadStatus(thread);
      if (status !== card.status) this.put({ ...card, status, updatedAt: Date.now() });
    }
  }

  private threadOf(card: PlanTask): Thread | undefined {
    return card.threadId ? this.store.getThread(card.threadId) : undefined;
  }

  remove(id: string): void {
    if (!this.store.getPlanTask(id)) return;
    this.store.deletePlanTask(id);
    this.broadcast({ type: "planTaskRemoved", id });
  }

  /**
   * Brings the board in line with a team: a card for each piece of the lead's plan, at the
   * place its piece really is. Called each time the team changes.
   */
  syncTeam(lead: Thread): void {
    const team = lead.team;
    if (!team?.tasks.length) return;
    const cards = this.list().filter((c) => c.team?.leadId === lead.id);
    // A piece gets its card once: one the user deleted since is not laid down again.
    const laid = this.laid();
    const already = laid[lead.id] ?? 0;
    team.tasks.forEach((piece, index) => {
      const status = pieceStatus(piece, team.phase === "done");
      const card = cards.find((c) => c.team?.index === index);
      if (!card) {
        if (index < already) return;
        this.add(
          { projectId: lead.projectId, title: piece.title, description: piece.brief, status },
          { source: "lead", team: { leadId: lead.id, index } },
        );
      } else if (card.status !== status) {
        this.put({ ...card, status, updatedAt: Date.now() });
      }
    });
    if (team.tasks.length > already) {
      this.store.setSetting(LAID, { ...laid, [lead.id]: team.tasks.length });
    }
  }

  /** How many pieces of each team's plan already got their card, by lead thread. */
  private laid(): Record<string, number> {
    return this.store.getSetting<Record<string, number>>(LAID, {});
  }

  /** A deleted thread leaves its cards where they were, no longer linked to it. */
  threadDeleted(threadId: string): void {
    const { [threadId]: wasLead, ...laid } = this.laid();
    if (wasLead !== undefined) this.store.setSetting(LAID, laid);
    for (const card of this.list()) {
      if (card.threadId === threadId) {
        const { threadId: _thread, ...rest } = card;
        this.put(rest);
      } else if (card.team?.leadId === threadId) {
        const { team: _team, ...rest } = card;
        this.put(rest);
      }
    }
  }

  private put(card: PlanTask): PlanTask {
    if (card.threadId) this.followed?.add(card.threadId);
    const task = stamped(card, Date.now());
    this.store.putPlanTask(task);
    this.broadcast({ type: "planTask", task });
    return task;
  }
}
