// Audit N10: a planned task keeps its hour through the change of the clocks, and its runs
// do not pile up, each with its thread and its copy of the repository.
// The server's calendar is Paris's here, set before any date is made.
process.env.TZ = "Europe/Paris";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Schedule, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { nextRun, Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Paris time as [month, day, hour, minute]. */
const stamp = (time: number) => {
  const d = new Date(time);
  return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};
const paris = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

function planner(start: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-runs-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
  const started: Schedule[] = [];
  const clock = { now: start };
  const plan = new Scheduler(store, () => undefined, {
    start: (s) => {
      started.push(s);
      return `t${started.length}`;
    },
    running: () => false,
    now: () => clock.now,
  });
  cleanups.push(() => {
    plan.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  /** Moves the clock just past the task's next time, and lets it start. */
  const runNext = (id: string) => {
    clock.now = plan.list().find((s) => s.id === id)!.nextAt + 1000;
    plan.tick();
    return plan.list().find((s) => s.id === id)!.nextAt;
  };
  return { store, plan, clock, started, runNext };
}

describe("the hour of a planned task when the clocks change", () => {
  it("is Paris's calendar here (summer time from 29 March 2026)", () => {
    expect(new Date(2026, 2, 29, 12).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 2, 28, 12).getTimezoneOffset()).toBe(-60);
  });

  it("a daily task of 2:30 runs at 3:30 the night 2:30 does not exist, then at 2:30 again", () => {
    const { plan, runNext } = planner(paris(3, 26, 12));
    const task = plan.add({
      projectId: "p",
      text: "t",
      agentId: "demo",
      permissionMode: "full",
      repeat: "daily",
      at: paris(3, 27, 2, 30),
    });
    const seen = [stamp(task.nextAt)];
    for (let i = 0; i < 4; i++) seen.push(stamp(runNext(task.id)));
    expect(seen).toEqual([
      [3, 27, 2, 30],
      [3, 28, 2, 30],
      [3, 29, 3, 30],
      [3, 30, 2, 30],
      [3, 31, 2, 30],
    ]);
  });

  it("a weekly task of Sunday 2:30 is back at 2:30 the week after", () => {
    const { plan, runNext } = planner(paris(3, 21, 12));
    const task = plan.add({
      projectId: "p",
      text: "t",
      agentId: "demo",
      permissionMode: "full",
      repeat: "weekly",
      at: paris(3, 22, 2, 30),
    });
    expect([runNext(task.id), runNext(task.id)].map(stamp)).toEqual([
      [3, 29, 3, 30],
      [4, 5, 2, 30],
    ]);
  });

  it("a task of the working days at 2:15 stays at 2:15 on the Monday after", () => {
    expect(stamp(nextRun("weekdays", paris(3, 27, 2, 15), paris(3, 27, 2, 16)))).toEqual([
      3, 30, 2, 15,
    ]);
  });

  it("when the clocks go back, a daily task of 2:30 runs once and keeps its hour", () => {
    const { plan, runNext, started } = planner(paris(10, 23, 12));
    const task = plan.add({
      projectId: "p",
      text: "t",
      agentId: "demo",
      permissionMode: "full",
      repeat: "daily",
      at: paris(10, 24, 2, 30),
    });
    expect([runNext(task.id), runNext(task.id)].map(stamp)).toEqual([
      [10, 25, 2, 30],
      [10, 26, 2, 30],
    ]);
    expect(started).toHaveLength(2);
  });

  it("a task given a new time counts from it; one saved before keeps working", () => {
    const { plan, store, runNext } = planner(paris(3, 26, 12));
    const task = plan.add({
      projectId: "p",
      text: "t",
      agentId: "demo",
      permissionMode: "full",
      repeat: "daily",
      at: paris(3, 27, 9),
    });
    const moved = plan.update(task.id, { at: paris(3, 28, 2, 30) });
    expect(moved.at).toBe(paris(3, 28, 2, 30));
    expect([runNext(task.id), runNext(task.id)].map(stamp)).toEqual([
      [3, 29, 3, 30],
      [3, 30, 2, 30],
    ]);
    // As an earlier version saved it: no time it was set for, only its next one.
    const { at: _at, ...old } = store.getSchedule(task.id)!;
    store.putSchedule({ ...old, nextAt: paris(4, 2, 7) });
    expect(stamp(runNext(task.id))).toEqual([4, 3, 7, 0]);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true },
  ).trim();

function repoHub() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-runs-hub-"));
  const repo = path.join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(path.join(repo, "README.md"), "# Demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const store = new Store(path.join(root, "state.sqlite"));
  const worktrees = path.join(root, "worktrees");
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: worktrees,
    homeDir: root,
    prWatchMs: 0,
  });
  hub.connect({ send: (_m: ServerMessage) => undefined });
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const projectId = hub.createProject("demo", repo);
  return { store, hub, worktrees, projectId };
}

describe("what the runs of a planned task leave", { timeout: 60_000 }, () => {
  it("only the latest run stays in sight; the earlier ones go to the archive, their folder given back", async () => {
    const { hub, store, worktrees, projectId } = repoHub();
    await hub.recovered;
    const task = hub.scheduler.add({
      projectId,
      text: "Vérifie les dépendances",
      agentId: "demo",
      permissionMode: "full",
      isolated: true,
      repeat: "hourly",
      at: Date.now() + 3_600_000,
    });
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = hub.scheduler.runNow(task.id);
      runs.push(id);
      await hub.whenIdle(id);
    }
    const thread = (id: string) => store.getThread(id)!;
    expect(runs.map((id) => !!thread(id).archived)).toEqual([true, true, false]);
    expect(readdirSync(worktrees)).toHaveLength(1);
    // An earlier run comes back whole when asked for.
    await hub.setArchived(runs[0]!, false);
    expect(thread(runs[0]!).archived).toBeFalsy();
    expect(readdirSync(worktrees)).toHaveLength(2);
  });

  it("the same for a task in the project's own folder", async () => {
    const { hub, store, projectId } = repoHub();
    await hub.recovered;
    const task = hub.scheduler.add({
      projectId,
      text: "Résume la journée",
      agentId: "demo",
      permissionMode: "full",
      repeat: "daily",
      at: Date.now() + 3_600_000,
    });
    const first = hub.scheduler.runNow(task.id);
    await hub.whenIdle(first);
    const second = hub.scheduler.runNow(task.id);
    await hub.whenIdle(second);
    expect(store.getThread(first)!.archived).toBe(true);
    expect(store.getThread(second)!.archived).toBeFalsy();
  });

  it("an earlier run the user deleted, or put away already, is left as it is", async () => {
    const { hub, store, projectId } = repoHub();
    await hub.recovered;
    const task = hub.scheduler.add({
      projectId,
      text: "Résume la journée",
      agentId: "demo",
      permissionMode: "full",
      repeat: "daily",
      at: Date.now() + 3_600_000,
    });
    const first = hub.scheduler.runNow(task.id);
    await hub.whenIdle(first);
    await hub.deleteThread(first);
    const second = hub.scheduler.runNow(task.id);
    await hub.whenIdle(second);
    await hub.setArchived(second, true);
    const third = hub.scheduler.runNow(task.id);
    await hub.whenIdle(third);
    expect(store.getThread(first)).toBeUndefined();
    expect(store.getThread(second)!.archived).toBe(true);
    expect(store.getThread(third)!.archived).toBeFalsy();
  });
});
