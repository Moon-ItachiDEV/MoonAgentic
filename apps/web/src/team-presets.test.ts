import { type AgentInfo, defaultTeam, type TeamPreset } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  addPreset,
  pickMember,
  presetLine,
  presetMembers,
  suggestedPresets,
  teamPresets,
  setRole,
  withRoles,
} from "./team-presets.ts";

const agent = (id: string, models: string[], available = true): AgentInfo =>
  ({
    id,
    name: id,
    available,
    models: models.map((name) => ({ id: name.toLowerCase(), name })),
    defaultModel: models[0]?.toLowerCase(),
  }) as AgentInfo;

describe("team presets", () => {
  const agents = [
    agent("claude", [
      "Claude Opus 5.5",
      "Claude Fable 5.2",
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
    ]),
    agent("gemini", ["Gemini 4 Neon", "Gemini 4 Hydrogen"]),
    agent("codex", ["GPT-6.2 Sol"], false),
  ];
  const pick = (preset: string, role: "lead" | "coder" | "reviewer" | "tester" | "merger") =>
    suggestedPresets(agents).find((p) => p.id === preset)!.roles[role];

  it("gives each role the model it prefers, best first, from any agent ready", () => {
    expect(pick("equilibree", "lead")).toEqual({ agentId: "claude", model: "claude fable 5.2" });
    expect(pick("equilibree", "reviewer")).toEqual({ agentId: "gemini", model: "gemini 4 neon" });
    expect(pick("qualite", "coder")).toEqual({ agentId: "claude", model: "claude fable 5.2" });
    expect(pick("economique", "tester")).toEqual({ agentId: "gemini", model: "gemini 4 hydrogen" });
    expect(pick("neon", "tester")).toEqual({ agentId: "gemini", model: "gemini 4 neon" });
  });

  it("skips an agent that is not ready, and falls back on the first one that is", () => {
    // GPT Sol is not ready: the next preference, any GPT, is not either.
    expect(pick("economique", "reviewer")).toEqual({ agentId: "claude", model: "claude opus 5.5" });
    expect(pickMember([agent("x", [], false)], [/opus/i])).toBeUndefined();
  });

  it("skips an agent installed but unable to give its models, as one not signed in", () => {
    const claude = { ...agent("claude", []), modelsError: "Connecte-toi d'abord." } as AgentInfo;
    const agy = agent("antigravity", ["Gemini 4 Neon"]);
    // Neither has Fable: the first agent able to work leads, not the one signed out.
    expect(pickMember([claude, agy], [/fable/i])).toEqual({
      agentId: "antigravity",
      model: "gemini 4 neon",
    });
  });
});

describe("the user's teams", () => {
  const agents = [
    agent("claude", ["Claude Opus 5.5", "Claude Sonnet 5.5"]),
    agent("gemini", ["Gemini 4 Neon"]),
    agent("codex", ["GPT-6.2 Sol"], false),
  ];
  const mine: TeamPreset = {
    id: "mine",
    label: "La mienne",
    roles: {
      lead: { agentId: "gemini", model: "gemini 4 neon" },
      coder: { agentId: "claude", model: "claude sonnet 5.5" },
      reviewer: null,
      tester: { agentId: "codex", model: "gpt-6.2 sol" },
      merger: { agentId: "claude", model: "gone" },
    },
  };

  it("takes the user's teams over the suggested ones, the first for the coordinator", () => {
    expect(teamPresets(undefined, agents).map((p) => p.label)).toEqual([
      "Équilibrée",
      "Économique",
      "Qualité max",
      "Neon relit et teste",
    ]);
    expect(teamPresets([mine], agents)).toEqual([mine]);
    expect(defaultTeam(agents, [mine])).toEqual({
      lead: { agentId: "gemini", model: "gemini 4 neon" },
      coder: { agentId: "claude", model: "claude sonnet 5.5" },
      // The model gone gives way to the agent's own default.
      merger: { agentId: "claude", model: "claude opus 5.5" },
    });
  });

  it("does without a role set to nobody or whose agent is not ready, never the lead", () => {
    const members = presetMembers(mine, agents);
    expect(members.reviewer).toBeUndefined();
    expect(members.tester).toBeUndefined();
    const gone = presetMembers({ ...mine, roles: { lead: { agentId: "codex" } } }, agents);
    // The lead and the coders fall back on the first agent ready.
    expect(gone.lead).toEqual({ agentId: "claude", model: "claude opus 5.5" });
    expect(gone.coder).toEqual({ agentId: "claude", model: "claude opus 5.5" });
    expect(gone.reviewer).toBeUndefined();
  });

  it("keeps the roles chosen, adds a team under a free name, and says who does what", () => {
    const start = suggestedPresets(agents);
    const kept = withRoles(start, "economique", {
      lead: { agentId: "claude", model: "claude opus 5.5" },
      coder: { agentId: "claude", model: "claude sonnet 5.5" },
    });
    expect(kept.find((p) => p.id === "economique")!.roles).toEqual({
      lead: { agentId: "claude", model: "claude opus 5.5" },
      coder: { agentId: "claude", model: "claude sonnet 5.5" },
      reviewer: null,
      reviewer2: null,
      judge: null,
      tester: null,
      merger: null,
    });
    expect(kept.find((p) => p.id === "equilibree")).toEqual(start[0]);
    const more = addPreset(kept, {}, "x");
    expect(more.at(-1)).toEqual({ id: "x", label: "Équipe 5", roles: {} });
    expect(
      presetLine(
        kept.find((p) => p.id === "economique")!,
        agents,
      ),
    ).toBe("Chef : Claude Opus 5.5 · Codeurs : Claude Sonnet 5.5");
  });
});

describe("teams kept whatever happens to the agents", () => {
  const agents = [
    agent("claude", ["Claude Opus 5.5", "Claude Sonnet 5.5"]),
    agent("gemini", ["Gemini 4 Neon"], false),
  ];
  const saved: TeamPreset = {
    id: "mine",
    label: "La mienne",
    roles: {
      lead: { agentId: "claude", model: "claude opus 5.5" },
      coder: { agentId: "claude", model: "claude sonnet 5.5" },
      reviewer: { agentId: "gemini", model: "gemini 4 neon" },
    },
  };

  it("falls back on the suggested teams when the list kept is empty", () => {
    expect(teamPresets([], agents).length).toBe(4);
    expect(defaultTeam(agents, [])).toBeDefined();
  });

  it("finds a lead and coders even for a team kept with nobody there", () => {
    const old = { ...saved, roles: { lead: null, coder: null } } as unknown as TeamPreset;
    expect(presetMembers(old, agents).lead).toEqual({
      agentId: "claude",
      model: "claude opus 5.5",
    });
    expect(defaultTeam(agents, [old])).toBeDefined();
  });

  it("changes one role and keeps the others as saved, even one whose agent is away", () => {
    const [next] = setRole([saved], "mine", "tester", {
      agentId: "claude",
      model: "claude opus 5.5",
    });
    // Gemini is not ready now: its place as reviewer is kept for when it is.
    expect(next!.roles).toEqual({
      ...saved.roles,
      tester: { agentId: "claude", model: "claude opus 5.5" },
    });
    expect(setRole([saved], "mine", "reviewer", undefined)[0]!.roles.reviewer).toBeNull();
    // Nobody for the lead is never written: it falls back on the first agent ready.
    expect("lead" in setRole([saved], "mine", "lead", undefined)[0]!.roles).toBe(false);
  });

  it("never writes nobody for the lead or the coders", () => {
    const roles = withRoles([saved], "mine", { tester: undefined })[0]!.roles;
    expect(roles.tester).toBeNull();
    expect("lead" in roles).toBe(false);
    expect("coder" in roles).toBe(false);
  });
});
