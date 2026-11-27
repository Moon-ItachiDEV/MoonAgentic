import type { Schedule } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  firstMoment,
  fromField,
  momentLabel,
  nextHour,
  repeatLabel,
  scheduleState,
  timeChange,
  titleFromText,
  toField,
} from "./schedule.ts";

const at = (day: number, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const schedule = (patch: Partial<Schedule> = {}): Schedule => ({
  id: "s",
  projectId: "p",
  title: "Tests du matin",
  text: "Lance les tests",
  agentId: "demo",
  permissionMode: "supervised",
  repeat: "daily",
  nextAt: at(24),
  enabled: true,
  runs: 0,
  createdAt: at(22),
  ...patch,
});

describe("planned tasks", () => {
  it("reads and writes the date field on this device's clock", () => {
    expect(toField(at(23, 9, 5))).toBe("2026-11-23T09:05");
    expect(fromField("2026-11-23T09:05")).toBe(at(23, 9, 5));
    // A year half typed is not a moment yet.
    expect(fromField("0002-11-23T09:05")).toBeNull();
    expect(fromField("")).toBeNull();
    expect(toField(nextHour(at(23, 9, 5)))).toBe("2026-11-23T10:00");
    expect(toField(nextHour(at(23, 23, 30)))).toBe("2026-11-24T00:00");
  });

  it("says a moment in words", () => {
    const now = at(23, 12);
    expect(momentLabel(at(23, 18, 30), now)).toBe("aujourd'hui à 18:30");
    expect(momentLabel(at(24), now)).toBe("demain à 09:00");
    expect(momentLabel(at(22), now)).toBe("hier à 09:00");
    expect(momentLabel(at(30), now)).toBe("lun. 30 nov. à 09:00");
    expect(momentLabel(new Date(2027, 0, 4, 9).getTime(), now)).toBe("lun. 4 janv. 2027 à 09:00");
  });

  it("says how a task repeats and where it stands", () => {
    expect(repeatLabel(schedule())).toBe("Tous les jours à 09:00");
    expect(repeatLabel(schedule({ repeat: "weekly", nextAt: at(30) }))).toBe(
      "Tous les lundis à 09:00",
    );
    expect(repeatLabel(schedule({ repeat: "hourly", nextAt: at(24, 9, 30) }))).toBe(
      "Toutes les heures, à la minute 30",
    );
    const now = at(23, 12);
    expect(scheduleState(schedule(), now)).toEqual({
      tone: "on",
      label: "Prochain lancement demain à 09:00",
    });
    expect(scheduleState(schedule({ enabled: false }), now)).toEqual({
      tone: "off",
      label: "En pause",
    });
    expect(
      scheduleState(schedule({ repeat: "once", enabled: false, lastAt: at(23, 9), runs: 1 }), now),
    ).toEqual({ tone: "done", label: "Lancée aujourd'hui à 09:00" });
  });

  it("never shows as done a one-time task that did not start", () => {
    const failed = schedule({
      repeat: "once",
      enabled: false,
      lastAt: at(23, 9),
      lastError: "Agent inconnu : demo",
    });
    expect(scheduleState(failed, at(23, 12))).toEqual({
      tone: "off",
      label: "Non lancée aujourd'hui à 09:00",
    });
  });

  it("opens a paused task that repeats on its own time, not on the next hour", () => {
    const now = at(23, 14, 20);
    const paused = schedule({ enabled: false, nextAt: at(24) });
    expect(toField(firstMoment(paused, now))).toBe("2026-11-24T09:00");
    expect(toField(firstMoment(schedule(), now))).toBe("2026-11-24T09:00");
    // A new task, and a one-time task that is over, are offered the next full hour.
    expect(toField(firstMoment(undefined, now))).toBe("2026-11-23T15:00");
    const over = schedule({ repeat: "once", enabled: false, nextAt: at(22), lastAt: at(22) });
    expect(toField(firstMoment(over, now))).toBe("2026-11-23T15:00");
    // A one-time task still waiting keeps its time.
    expect(toField(firstMoment(schedule({ repeat: "once" }), now))).toBe("2026-11-24T09:00");
  });

  it("names a task after its first line", () => {
    expect(titleFromText("  Lance les tests\net corrige")).toBe("Lance les tests");
    expect(titleFromText("x".repeat(100))).toHaveLength(80);
  });
});

describe("the time of a task when the clocks change", () => {
  it("says the time it was set for, not its next run moved by the clocks", () => {
    // Its next run is at 3:30 the night 2:30 does not exist.
    const moved = schedule({ at: at(1, 2, 30), nextAt: at(29, 3, 30) });
    expect(repeatLabel(moved)).toBe("Tous les jours à 02:30");
    expect(repeatLabel(schedule({ nextAt: at(29, 3, 30) }))).toBe("Tous les jours à 03:30");
  });

  it("a new repetition alone sends no time, which would move the one it was set for", () => {
    const task = schedule({ at: at(1, 2, 30), nextAt: at(29, 3, 30) });
    expect(timeChange(task, { timeChanged: false, repeat: "weekdays", at: at(29, 3, 30) })).toEqual(
      { repeat: "weekdays" },
    );
    expect(timeChange(task, { timeChanged: true, repeat: "daily", at: at(29, 8) })).toEqual({
      at: at(29, 8),
      repeat: "daily",
    });
    expect(timeChange(task, { timeChanged: false, repeat: "daily", at: at(29, 3, 30) })).toEqual(
      {},
    );
    // A one-time task that has run is planned again, at the time shown.
    const ran = schedule({ repeat: "once", enabled: false });
    expect(timeChange(ran, { timeChanged: false, repeat: "once", at: at(30) })).toEqual({
      at: at(30),
      repeat: "once",
    });
  });
});
