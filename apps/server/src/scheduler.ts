import { randomUUID } from "node:crypto";
import type {
  PermissionMode,
  Schedule,
  ScheduleRepeat,
  ServerMessage,
} from "@moonagentic/protocol";
import type { Store } from "./store.ts";

const HOUR = 3_600_000;
/** A one-time task may be planned for the minute that is ending. */
const GRACE = 60_000;
/** After a failure, the next look at the clock waits this long, so it never loops at once. */
const RETRY_MS = 60_000;
const STILL_RUNNING = "Le lancement précédent tournait encore : celui-ci a été sauté.";

/**
 * The first time a planned task is due after `now`, on the series that starts at `at`.
 * Days are counted on the server's calendar, so a daily task keeps its hour when the
 * clocks change. A one-time task has only `at`.
 */
export function nextRun(repeat: ScheduleRepeat, at: number, now: number): number {
  if (repeat === "once") return at;
  if (repeat === "hourly") {
    return at > now ? at : at + (Math.floor((now - at) / HOUR) + 1) * HOUR;
  }
  const day = new Date(at);
  const step = repeat === "weekly" ? 7 : 1;
  const weekend = () => repeat === "weekdays" && (day.getDay() === 0 || day.getDay() === 6);
  // Far behind, the days are first skipped at once, then walked one by one.
  if (now - at > 14 * 24 * HOUR) {
    const behind = Math.floor((now - at) / (24 * HOUR)) - 7;
    day.setDate(day.getDate() + behind - (behind % 7));
  }
  while (day.getTime() <= now || weekend()) day.setDate(day.getDate() + step);
  return day.getTime();
}

export interface ScheduleAdd {
  projectId: string;
  title?: string | undefined;
  text: string;
  agentId: string;
  model?: string | undefined;
  permissionMode: PermissionMode;
  isolated?: boolean | undefined;
  repeat: ScheduleRepeat;
  at: number;
}

export interface SchedulePatch {
  title?: string | undefined;
  text?: string | undefined;
  repeat?: ScheduleRepeat | undefined;
  at?: number | undefined;
  enabled?: boolean | undefined;
}

export interface SchedulerHost {
  /** Starts a thread on the task and returns it; throws when it cannot. */
  start: (schedule: Schedule) => string;
  /** True while that thread's agent is at work. */
  running: (threadId: string) => boolean;
  now?: () => number;
}

/** The tasks planned for later: keeps them, and starts each one when its time comes. */
export class Scheduler {
  private readonly store: Store;
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly host: SchedulerHost;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  /** A task started whose new state could not be saved: saved on the next try, not started again. */
  private readonly unsaved = new Map<string, { from: number; next: Schedule }>();

  constructor(store: Store, broadcast: (message: ServerMessage) => void, host: SchedulerHost) {
    this.store = store;
    this.broadcast = broadcast;
    this.host = host;
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  list(): Schedule[] {
    return this.store.listSchedules();
  }

  /**
   * Starts watching the clock. A task that was due while the server was off starts now,
   * once, however many of its times were missed.
   */
  start(): void {
    this.started = true;
    this.tick();
  }

  close(): void {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  add(input: ScheduleAdd): Schedule {
    const now = this.now();
    const schedule: Schedule = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title ?? titleOf(input.text),
      text: input.text,
      agentId: input.agentId,
      ...(input.model ? { model: input.model } : {}),
      permissionMode: input.permissionMode,
      ...(input.isolated ? { isolated: true } : {}),
      repeat: input.repeat,
      nextAt: this.firstTime(input.repeat, input.at, now),
      enabled: true,
      runs: 0,
      createdAt: now,
    };
    this.put(schedule);
    this.arm();
    return schedule;
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const before = this.require(id);
    const now = this.now();
    const repeat = patch.repeat ?? before.repeat;
    const moved = patch.at !== undefined || repeat !== before.repeat;
    const on = patch.enabled ?? (moved ? true : before.enabled);
    // Given a new time, or turned back on after its time passed, it goes to its next time.
    const nextAt =
      moved || (on && !before.enabled && before.nextAt <= now)
        ? this.firstTime(repeat, patch.at ?? before.nextAt, now)
        : before.nextAt;
    const schedule: Schedule = {
      ...before,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      repeat,
      nextAt,
      enabled: on,
    };
    this.put(schedule);
    this.arm();
    return schedule;
  }

  remove(id: string): void {
    this.require(id);
    this.store.deleteSchedule(id);
    this.broadcast({ type: "scheduleRemoved", id });
    this.arm();
  }

  /** Starts the task now, whatever its time; its next time stays where it is. */
  runNow(id: string): string {
    const schedule = this.require(id);
    if (schedule.lastThreadId && this.host.running(schedule.lastThreadId)) {
      throw new Error("Son lancement précédent tourne encore.");
    }
    const threadId = this.host.start(schedule);
    const { lastError: _, ...rest } = schedule;
    this.put({ ...rest, runs: schedule.runs + 1, lastAt: this.now(), lastThreadId: threadId });
    return threadId;
  }

  /** A thread deleted is no longer the last run of anything. */
  threadDeleted(threadId: string): void {
    for (const schedule of this.list()) {
      if (schedule.lastThreadId !== threadId) continue;
      const { lastThreadId: _, ...rest } = schedule;
      this.put(rest);
    }
  }

  /** Starts every task that is due, then waits for the next one. */
  tick(): void {
    let failed = false;
    try {
      const now = this.now();
      for (const schedule of this.list()) {
        if (!schedule.enabled || schedule.nextAt > now) continue;
        // One task that cannot be saved does not keep the others from starting.
        try {
          const unsaved = this.unsaved.get(schedule.id);
          // Started already, only its new state was not saved: it is saved, not started again.
          if (unsaved?.from === schedule.nextAt) this.put(unsaved.next);
          else this.fire(schedule, now);
          this.unsaved.delete(schedule.id);
        } catch (error) {
          failed = true;
          console.error(`Tâche planifiée « ${schedule.title} » :`, error);
        }
      }
    } catch (error) {
      failed = true;
      console.error("Tâches planifiées :", error);
    } finally {
      // Whatever failed, the clock is watched again; a task still due is tried again in a
      // while, not at once in a loop.
      this.arm(failed ? RETRY_MS : 0);
    }
  }

  private fire(schedule: Schedule, now: number): void {
    const { lastError: _, ...rest } = schedule;
    let next: Schedule = { ...rest, lastAt: now };
    if (schedule.lastThreadId && this.host.running(schedule.lastThreadId)) {
      next.lastError = STILL_RUNNING;
    } else {
      try {
        next.lastThreadId = this.host.start(schedule);
        next.runs = schedule.runs + 1;
      } catch (error) {
        next.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    next =
      schedule.repeat === "once"
        ? { ...next, enabled: false }
        : { ...next, nextAt: nextRun(schedule.repeat, schedule.nextAt, now) };
    try {
      this.put(next);
    } catch (error) {
      if (next.lastThreadId !== schedule.lastThreadId) {
        this.unsaved.set(schedule.id, { from: schedule.nextAt, next });
      }
      throw error;
    }
  }

  private firstTime(repeat: ScheduleRepeat, at: number, now: number): number {
    if (repeat !== "once") return nextRun(repeat, at, now - 1);
    if (at < now - GRACE) throw new Error("Ce moment est déjà passé : choisis-en un à venir.");
    return at;
  }

  /** One timer, set for the next task due. Long waits are cut in hours, as timers drift. */
  private arm(atLeast = 0): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started) return;
    let wait: number;
    try {
      const due = this.list()
        .filter((s) => s.enabled)
        .map((s) => s.nextAt);
      if (due.length === 0) return;
      wait = Math.min(Math.max(atLeast, Math.min(...due) - this.now()), HOUR);
    } catch (error) {
      // The list could not be read: it is read again in a while.
      console.error("Tâches planifiées :", error);
      wait = RETRY_MS;
    }
    this.timer = setTimeout(() => this.tick(), wait);
    this.timer.unref();
  }

  private require(id: string): Schedule {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw new Error("Tâche planifiée introuvable.");
    return schedule;
  }

  private put(schedule: Schedule): void {
    this.store.putSchedule(schedule);
    this.broadcast({ type: "schedule", schedule });
  }
}

const titleOf = (text: string): string => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
