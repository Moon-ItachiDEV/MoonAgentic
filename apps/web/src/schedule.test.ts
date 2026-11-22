import type { Schedule } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  fromField,
  momentLabel,
  nextHour,
  repeatLabel,
  scheduleState,
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
});
