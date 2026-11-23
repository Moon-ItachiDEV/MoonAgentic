import type { AgentInfo, AgentQuota } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatReset,
  quotaLevel,
  quotaWarning,
  readAgo,
  roomiest,
  tightest,
} from "./quotas.ts";

const quota = (agentId: string, ...used: number[]): AgentQuota => ({
  agentId,
  state: "ok",
  windows: used.map((u, i) => ({ label: `W${i}`, short: `w${i}`, usedPercent: u })),
  extras: [],
});
const agent = (id: string, available = true): AgentInfo => ({
  id,
  name: id.toUpperCase(),
  short: id.slice(0, 2),
  available,
});

describe("quotas", () => {
  it("finds the window closest to its limit", () => {
    expect(tightest(quota("a", 20, 86, 40))?.label).toBe("W1");
    expect(tightest({ ...quota("a", 20), state: "unreadable" })).toBeUndefined();
    expect(tightest(undefined)).toBeUndefined();
  });

  it("warns from 80 % and says full from 100 %", () => {
    expect([79.9, 80, 99, 100, 120].map(quotaLevel)).toEqual([
      "ok",
      "warn",
      "warn",
      "full",
      "full",
    ]);
    expect(formatPercent(85.6)).toBe("86 %");
  });

  it("says when a window frees up in local time", () => {
    const now = new Date(2026, 10, 23, 10, 0).getTime();
    expect(formatReset(new Date(2026, 10, 23, 14, 20).getTime(), now)).toBe("à 14:20");
    expect(formatReset(new Date(2026, 10, 24, 9, 5).getTime(), now)).toBe("demain à 09:05");
    expect(formatReset(new Date(2026, 10, 27, 18, 40).getTime(), now)).toBe("vendredi à 18:40");
    expect(formatReset(new Date(2026, 11, 2, 7, 0).getTime(), now)).toBe("le 2 déc. à 07:00");
  });

  it("says how long ago it was read", () => {
    expect(readAgo(1000, 30_000)).toBe("Lu à l'instant");
    expect(readAgo(0, 3 * 60_000)).toBe("Lu il y a 3 min");
    expect(readAgo(0, 125 * 60_000)).toBe("Lu il y a 2 h");
  });

  it("offers the installed agent with the most room, never one nearly spent", () => {
    const quotas = [quota("a", 90), quota("b", 60), quota("c", 10), quota("d", 5)];
    const agents = [agent("a"), agent("b"), agent("c"), agent("d", false)];
    expect(roomiest(quotas, agents, "a")?.id).toBe("c");
    expect(roomiest([quota("a", 90), quota("b", 85)], agents, "a")).toBeUndefined();
  });

  it("warns only for a window nearly spent", () => {
    expect(quotaWarning(quota("a", 50), "A")).toBeUndefined();
    const warn = quotaWarning(
      { ...quota("a", 86), windows: [{ label: "Semaine", short: "semaine", usedPercent: 86 }] },
      "Codex",
    );
    expect(warn).toMatchObject({ level: "warn", text: "Codex a utilisé 86 % (semaine)." });
    expect(quotaWarning(quota("a", 100), "A")?.level).toBe("full");
  });
});
