import type { AgentQuota, PlanTask, Schedule, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import type { HomeCard } from "./components/HomeCards.tsx";
import {
  brief,
  byUrgency,
  formatWhen,
  heatmap,
  localDay,
  pullRequestStatus,
  pullRequests,
  upcoming,
} from "./overview.ts";

const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({
    id,
    projectId: "p",
    title: id,
    agentId: "claude",
    status: "idle",
    permissionMode: "supervised",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Thread;
const card = (id: string, tone: HomeCard["tone"]): HomeCard => ({
  thread: thread(id),
  agentIds: ["claude"],
  sub: "",
  tone,
});
const pr = (extra: Partial<NonNullable<Thread["pr"]>> = {}): NonNullable<Thread["pr"]> => ({
  url: "https://github.com/o/r/pull/1",
  number: 1,
  state: "open",
  checks: "none",
  ...extra,
});

describe("overview", () => {
  it("puts what waits for the user first, then work, then reviews", () => {
    const sorted = byUrgency([card("a", "review"), card("b", "work"), card("c", "wait")]);
    expect(sorted.map((c) => c.thread.id)).toEqual(["c", "b", "a"]);
  });

  it("counts the pills and names the agent nearest its limit, from 80 %", () => {
    const quotas: AgentQuota[] = [
      {
        agentId: "codex",
        state: "ok",
        windows: [{ label: "Semaine", short: "semaine", usedPercent: 18 }],
        extras: [],
      },
      {
        agentId: "claude",
        state: "ok",
        windows: [{ label: "Session de 5 h", short: "5 h", usedPercent: 86 }],
        extras: [],
      },
      { agentId: "agy", state: "unreadable", windows: [], extras: [] },
    ];
    const b = brief([card("a", "wait"), card("b", "work"), card("c", "work")], quotas);
    expect(b).toEqual({
      waiting: 1,
      working: 2,
      review: 0,
      quota: { agentId: "claude", usedPercent: 86, label: "5 h" },
    });
    expect(brief([], [quotas[0]!]).quota).toBeUndefined();
  });

  it("says where a pull request stands", () => {
    expect(pullRequestStatus(pr({ state: "merged" })).label).toBe("Fusionnée");
    expect(pullRequestStatus(pr({ checks: "pending" })).label).toBe("Vérifs en cours");
    expect(pullRequestStatus(pr({ checks: "failed" })).tone).toBe("bad");
    expect(pullRequestStatus(pr({ checks: "passed" })).label).toBe("Prête");
    expect(pullRequestStatus(pr({ checks: "passed", conflicts: true })).label).toBe("Conflits");
  });

  it("lists open pull requests before closed ones, and counts the open ones", () => {
    const { rows, open } = pullRequests([
      thread("fusionnée", { pr: pr({ state: "merged", number: 3 }), updatedAt: 9 }),
      thread("ouverte", { pr: pr({ number: 5 }), updatedAt: 1 }),
      thread("sans"),
    ]);
    expect(rows.map((r) => r.number)).toEqual([5, 3]);
    expect(open).toBe(1);
  });

  it("shows the next scheduled tasks and planner due dates, soonest first", () => {
    const now = new Date(2026, 10, 23, 12).getTime();
    const schedule = (id: string, nextAt: number, enabled = true) =>
      ({ id, title: id, nextAt, enabled, repeat: "daily", agentId: "claude" }) as Schedule;
    const task = (id: string, due: number, status: PlanTask["status"] = "todo") =>
      ({ id, number: 14, title: id, due, status }) as PlanTask;
    const list = upcoming(
      [schedule("nuit", now + 14 * 3600_000), schedule("pause", now + 1000, false)],
      [task("échéance", now + 3 * 86_400_000), task("livrée", now + 1000, "live")],
      now,
    );
    expect(list.map((u) => u.title)).toEqual(["nuit", "#14 échéance"]);
    expect(list[0]!.when).toBe("Demain, 2 h");
    expect(list[0]!.detail).toBe("tous les jours");
  });

  it("says when in words", () => {
    const now = new Date(2026, 10, 23, 12).getTime();
    expect(formatWhen(new Date(2026, 10, 23, 14, 40).getTime(), now)).toBe("Aujourd'hui, 14 h 40");
    expect(formatWhen(new Date(2026, 10, 26, 9).getTime(), now, false)).toBe("Jeudi");
  });
});

describe("activity map", () => {
  // Monday 23 November 2026, noon, in UTC (offset 0) to keep the test independent of the machine.
  const now = Date.UTC(2026, 10, 23, 12);
  const today = localDay(now, 0);

  it("draws full weeks, Monday first, ending with the current one", () => {
    const map = heatmap([], 4, undefined, now, 0);
    expect(map.weeks).toHaveLength(4);
    expect(map.weeks.every((w) => w.length === 7)).toBe(true);
    const last = map.weeks[3]!;
    expect(last[0]!.day).toBe(today); // the 23rd is a Monday
    expect(last[0]!.state).toBe("today");
    expect(last[1]!.state).toBe("after");
  });

  it("never draws days before the first thread as days without work", () => {
    const first = Date.UTC(2026, 10, 21, 9);
    const map = heatmap(
      [
        { day: today - 2, count: 96 },
        { day: today - 1, count: 212 },
        { day: today, count: 58 },
      ],
      4,
      first,
      now,
      0,
    );
    const cells = map.weeks.flat();
    expect(cells.find((c) => c.day === today - 3)!.state).toBe("before");
    expect(cells.find((c) => c.day === today - 1)!.level).toBe(4);
    expect(map.total).toBe(366);
    expect(map.streak).toBe(3);
    expect(map.busiest).toBe("dimanche");
    expect(map.sinceStart).toBe(true);
  });

  it("counts the streak up to yesterday when today has nothing yet", () => {
    const map = heatmap(
      [
        { day: today - 1, count: 2 },
        { day: today - 2, count: 1 },
      ],
      2,
      0,
      now,
      0,
    );
    expect(map.streak).toBe(2);
  });
});
