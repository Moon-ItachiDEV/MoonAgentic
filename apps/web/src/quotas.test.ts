import type { AgentInfo, AgentQuota } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatReset,
  limitsModel,
  parseSeenQuotas,
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
    expect(tightest({ ...quota("a", 20), state: "loading" })).toBeUndefined();
    expect(tightest(undefined)).toBeUndefined();
  });

  it("counts a window of one model only for that model", () => {
    const claude: AgentQuota = {
      ...quota("claude", 30),
      windows: [
        { label: "Session de 5 h", short: "5 h", usedPercent: 30 },
        { label: "Semaine, Fable", short: "semaine Fable", model: "Fable", usedPercent: 100 },
        { label: "Semaine, Opus", short: "semaine Opus", model: "Opus", usedPercent: 85 },
      ],
    };
    expect(tightest(claude)?.short).toBe("5 h");
    expect(tightest(claude, ["claude-fable-5-2", undefined])?.short).toBe("semaine Fable");
    expect(tightest(claude, ["default", "Opus 5.5"])?.short).toBe("semaine Opus");
    expect(tightest(claude, ["sonnet", "Sonnet 5.5"])?.short).toBe("5 h");
    const named = (model: string) => ({ label: model, short: model, model, usedPercent: 100 });
    expect(limitsModel(named("Fable 5.2"), ["claude-fable-5-2"])).toBe(true);
    expect(limitsModel(named("Fable 5.2"), ["claude-fable-5-3", "Fable 5.3"])).toBe(false);
    expect(limitsModel(named("Claude Fable"), ["claude-sonnet-5-5", "Sonnet 5.5"])).toBe(false);
    expect(limitsModel(named("Claude Fable"), ["claude-fable-5-2"])).toBe(true);
    expect(limitsModel(named("Opus"), ["claude-opus-5-5"])).toBe(true);
    expect(limitsModel(named("Opus"), ["opusculum"])).toBe(false);
    expect(quotaWarning(claude, "Claude Code")).toBeUndefined();
    expect(quotaWarning(claude, "Claude Code", Date.now(), ["fable"])).toMatchObject({
      level: "full",
      text: "Claude Code a atteint sa limite (semaine Fable).",
      brief: "Limite atteinte (semaine Fable)",
    });
    expect(quotaWarning(claude, "Claude Code", Date.now(), ["opus"])).toMatchObject({
      level: "warn",
      text: `Claude Code a utilisé ${formatPercent(85)} (semaine Opus).`,
      brief: `${formatPercent(85)} (semaine Opus)`,
    });
  });

  it("counts a window of a group of models for each of them, and shows the fullest without a model", () => {
    const group = (short: string, models: string[], usedPercent: number) => ({
      label: short,
      short,
      model: short.split(" ").at(-1)!,
      models,
      usedPercent,
    });
    const agy: AgentQuota = {
      agentId: "antigravity",
      state: "ok",
      extras: [],
      windows: [
        group("5 h Gemini", ["Gemini 4 Neon", "Orchestrator (Neon)"], 14),
        group("semaine Gemini", ["Gemini 4 Neon", "Orchestrator (Neon)"], 86),
        group("semaine Claude et GPT", ["Claude Opus 5.5", "GPT-OSS 120B"], 100),
      ],
    };
    expect(limitsModel(agy.windows[0]!, ["gemini-4-neon"])).toBe(true);
    expect(limitsModel(agy.windows[0]!, ["x", "Claude Opus 5.5"])).toBe(false);
    expect(limitsModel(agy.windows[2]!, ["claude-opus-5-5"])).toBe(true);
    expect(tightest(agy, ["gemini-4-neon", "Gemini 4 Neon"])?.short).toBe("semaine Gemini");
    expect(tightest(agy, ["opus", "Claude Opus 5.5"])?.short).toBe("semaine Claude et GPT");
    // An unknown model is limited by no group: no figure is borrowed from another.
    expect(tightest(agy, ["mystery"])).toBeUndefined();
    // No model in sight (side bar, agent menu): the fullest window stands for the agent.
    expect(tightest(agy)?.short).toBe("semaine Claude et GPT");
    expect(quotaWarning(agy, "Antigravity", Date.now(), ["Gemini 4 Neon"])).toMatchObject({
      level: "warn",
      key: expect.stringContaining("semaine Gemini"),
    });
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

  it("says when a window frees up in local time, and handles past reset times", () => {
    const now = new Date(2026, 10, 23, 10, 0).getTime();
    expect(formatReset(now - 60_000, now)).toBe("bientôt");
    expect(formatReset(now, now)).toBe("bientôt");
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

  it("warns only for a window nearly spent, and keeps the key stable across minor reset jitter", () => {
    expect(quotaWarning(quota("a", 50), "A")).toBeUndefined();
    const baseReset = Date.parse("2026-11-23T14:00:00.000Z");
    const w1 = quotaWarning(
      {
        ...quota("a", 86),
        windows: [{ label: "Semaine", short: "semaine", usedPercent: 86, resetsAt: baseReset }],
      },
      "Codex",
      baseReset - 3_600_000,
    );
    const w2 = quotaWarning(
      {
        ...quota("a", 87),
        windows: [
          { label: "Semaine", short: "semaine", usedPercent: 87, resetsAt: baseReset + 1_200 },
        ],
      },
      "Codex",
      baseReset - 3_600_000,
    );
    expect(w1).toMatchObject({ level: "warn", text: "Codex a utilisé 86 % (semaine)." });
    expect(w1?.key).toBe(w2?.key);
    expect(quotaWarning(quota("a", 100), "A")?.level).toBe("full");
  });

  it("parses per-agent dismissed warnings safely", () => {
    expect(parseSeenQuotas(null)).toEqual({});
    expect(parseSeenQuotas("claude:5h:123:warn")).toEqual({});
    expect(parseSeenQuotas("[]")).toEqual({});
    expect(parseSeenQuotas(JSON.stringify({ claude: "k1", codex: "k2", bad: 42 }))).toEqual({
      claude: "k1",
      codex: "k2",
    });
  });
});
