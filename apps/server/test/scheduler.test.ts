import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Schedule, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { nextRun, Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A moment of November 2026 on the server's own calendar; the 23rd is a Monday. */
const at = (day: number, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const stamp = (time: number) => {
  const d = new Date(time);
  return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

function scheduler() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-sched-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  store.addProject({ id: "p", name: "p", path: "/p", createdAt: 1 });
  const sent: ServerMessage[] = [];
  const started: Schedule[] = [];
  const clock = { now: at(23, 8) };
  const running = new Set<string>();
  let fail: string | undefined;
  const plan = new Scheduler(store, (m) => sent.push(m), {
    start: (s) => {
      if (fail) throw new Error(fail);
      started.push(s);
      return `t${started.length}`;
    },
    running: (id) => running.has(id),
    now: () => clock.now,
  });
  cleanups.push(() => {
    plan.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const task = (patch: Partial<Parameters<Scheduler["add"]>[0]> = {}) =>
    plan.add({
      projectId: "p",
      text: "Lance les tests\net corrige",
      agentId: "demo",
      permissionMode: "full",
      repeat: "once",
      at: at(23, 9),
      ...patch,
    });
  return {
    store,
    sent,
    started,
    clock,
    running,
    plan,
    task,
    failWith: (message: string | undefined) => (fail = message),
  };
}

describe("nextRun", () => {
  it("finds the next time of each kind of repeat", () => {
    const now = at(25, 12);
    expect(nextRun("once", at(23), now)).toBe(at(23));
    expect(stamp(nextRun("hourly", at(23, 9, 30), now))).toEqual([11, 25, 12, 30]);
    expect(stamp(nextRun("daily", at(23), now))).toEqual([11, 26, 9, 0]);
    expect(stamp(nextRun("daily", at(23, 18), now))).toEqual([11, 25, 18, 0]);
    // Friday evening goes to Monday; a first time on a Sunday too.
    expect(stamp(nextRun("weekdays", at(23), at(27, 12)))).toEqual([11, 30, 9, 0]);
    expect(stamp(nextRun("weekdays", at(29), at(25)))).toEqual([11, 30, 9, 0]);
    expect(stamp(nextRun("weekly", at(23), now))).toEqual([11, 30, 9, 0]);
    // A time still to come is kept as it is.
    expect(nextRun("daily", at(28), now)).toBe(at(28));
    expect(nextRun("hourly", at(28), now)).toBe(at(28));
  });

  it("keeps the hour and the weekday after a long time off", () => {
    const later = new Date(2027, 5, 16, 12).getTime();
    expect(stamp(nextRun("daily", at(23), later))).toEqual([6, 17, 9, 0]);
    const weekly = new Date(nextRun("weekly", at(23), later));
    expect([weekly.getDay(), weekly.getHours()]).toEqual([1, 9]);
    expect(weekly.getTime() - later).toBeLessThanOrEqual(7 * 24 * 3_600_000);
  });
});

describe("scheduler", () => {
  it("starts a one-time task at its time, once", () => {
    const { plan, task, started, clock, sent } = scheduler();
    const planned = task();
    expect(planned).toMatchObject({ title: "Lance les tests", enabled: true, runs: 0 });
    expect(sent.at(-1)).toEqual({ type: "schedule", schedule: planned });
    plan.tick();
    expect(started).toEqual([]);
    clock.now = at(23, 9);
    plan.tick();
    plan.tick();
    expect(started.map((s) => s.id)).toEqual([planned.id]);
    expect(plan.list()[0]).toMatchObject({
      enabled: false,
      runs: 1,
      lastAt: at(23, 9),
      lastThreadId: "t1",
    });
  });

  it("refuses a one-time task in the past, and moves a repeated one to its next time", () => {
    const { task } = scheduler();
    expect(() => task({ at: at(22) })).toThrow(/déjà passé/);
    expect(stamp(task({ repeat: "daily", at: at(20, 7) }).nextAt)).toEqual([11, 24, 7, 0]);
  });

  it("starts a repeated task again and again, once for all the times it missed", () => {
    const { plan, task, started, clock } = scheduler();
    task({ repeat: "daily" });
    clock.now = at(23, 9, 1);
    plan.tick();
    expect(stamp(plan.list()[0]!.nextAt)).toEqual([11, 24, 9, 0]);
    // The server was off for three days.
    clock.now = at(27, 10);
    plan.tick();
    plan.tick();
    expect(started.length).toBe(2);
    expect(stamp(plan.list()[0]!.nextAt)).toEqual([11, 28, 9, 0]);
    expect(plan.list()[0]).toMatchObject({ enabled: true, runs: 2, lastThreadId: "t2" });
  });

  it("skips a time when the run before is still at work, and says so", () => {
    const { plan, task, started, clock, running } = scheduler();
    task({ repeat: "hourly" });
    clock.now = at(23, 9);
    plan.tick();
    running.add("t1");
    clock.now = at(23, 10);
    plan.tick();
    expect(started.length).toBe(1);
    expect(plan.list()[0]).toMatchObject({ runs: 1, lastThreadId: "t1" });
    expect(plan.list()[0]!.lastError).toMatch(/tournait encore/);
    expect(() => plan.runNow(plan.list()[0]!.id)).toThrow(/tourne encore/);
    running.clear();
    clock.now = at(23, 11);
    plan.tick();
    expect(plan.list()[0]).toMatchObject({ runs: 2, lastThreadId: "t2" });
    expect(plan.list()[0]!.lastError).toBeUndefined();
  });

  it("writes down why a task could not start, and goes on to its next time", () => {
    const { plan, task, clock, failWith } = scheduler();
    task({ repeat: "daily" });
    failWith("Agent inconnu : demo");
    clock.now = at(23, 9);
    plan.tick();
    expect(plan.list()[0]).toMatchObject({ runs: 0, lastError: "Agent inconnu : demo" });
    expect(stamp(plan.list()[0]!.nextAt)).toEqual([11, 24, 9, 0]);
  });

  it("pauses, comes back at its next time, and takes a new time", () => {
    const { plan, task, started, clock } = scheduler();
    const daily = task({ repeat: "daily" });
    plan.update(daily.id, { enabled: false });
    clock.now = at(25, 12);
    plan.tick();
    expect(started).toEqual([]);
    expect(stamp(plan.update(daily.id, { enabled: true }).nextAt)).toEqual([11, 26, 9, 0]);
    const moved = plan.update(daily.id, { repeat: "weekly", at: at(27, 14), title: "Vendredi" });
    expect(moved).toMatchObject({ title: "Vendredi", repeat: "weekly", nextAt: at(27, 14) });

    // A one-time task that has run needs a new time to run again.
    const once = task({ at: at(25, 13) });
    clock.now = at(25, 13);
    plan.tick();
    clock.now = at(25, 13, 5);
    expect(() => plan.update(once.id, { enabled: true })).toThrow(/déjà passé/);
    expect(plan.update(once.id, { at: at(26) })).toMatchObject({ enabled: true, nextAt: at(26) });
  });

  it("starts a task now without moving its time, and forgets a deleted run", () => {
    const { plan, task, sent } = scheduler();
    const daily = task({ repeat: "daily" });
    expect(plan.runNow(daily.id)).toBe("t1");
    expect(plan.list()[0]).toMatchObject({ runs: 1, lastThreadId: "t1", nextAt: at(23, 9) });
    plan.threadDeleted("t1");
    expect(plan.list()[0]!.lastThreadId).toBeUndefined();
    plan.remove(daily.id);
    expect(sent.at(-1)).toEqual({ type: "scheduleRemoved", id: daily.id });
    expect(() => plan.remove(daily.id)).toThrow(/introuvable/);
  });

  it("drops a project's planned tasks with the project", () => {
    const { plan, task, store } = scheduler();
    task();
    store.deleteProject("p");
    expect(plan.list()).toEqual([]);
  });

  it("keeps watching the clock when saving fails, and never starts a task twice for it", () => {
    const { store, started, clock, plan, task } = scheduler();
    const errors: unknown[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    cleanups.push(() => (console.error = quiet));
    plan.start();
    const one = task();
    const other = task({ title: "Autre", at: at(23, 9, 1) });
    clock.now = at(23, 9, 5);
    const put = store.putSchedule.bind(store);
    let failures = 1;
    store.putSchedule = (schedule) => {
      if (schedule.id === one.id && failures-- > 0) throw new Error("disque plein");
      put(schedule);
    };
    plan.tick();
    // The other task started anyway, and the clock is still watched.
    expect(started.map((s) => s.id).sort()).toEqual([one.id, other.id].sort());
    expect(errors).toHaveLength(1);
    expect((plan as unknown as { timer?: NodeJS.Timeout }).timer).toBeDefined();
    // Next look: its state is saved, it does not start a second time.
    plan.tick();
    expect(started.map((s) => s.id).sort()).toEqual([one.id, other.id].sort());
    expect(store.getSchedule(one.id)).toMatchObject({ enabled: false, runs: 1 });
  });
});
