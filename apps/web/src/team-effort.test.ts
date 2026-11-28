// Each role of a team with its own reasoning level: suggested, kept, shown.
import { type AgentInfo, ClientMessage, type Team, type Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { presetMembers, suggestedPresets } from "./team-presets.ts";
import { teamRows } from "./team-rows.ts";
import { teamTree } from "./team-tree.ts";

const effort = (choices: string[], current = choices[0]!) => ({
  id: "effort",
  kind: "effort" as const,
  choices: choices.map((id) => ({ id, name: id })),
  current,
});
const agents = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    models: [
      { id: "opus", name: "Opus 5.5" },
      { id: "fable", name: "Fable 5.2" },
      { id: "sonnet", name: "Sonnet 5.5" },
      { id: "haiku", name: "Haiku 5.5" },
    ],
    defaultModel: "opus",
    settings: [effort(["low", "medium", "high", "xhigh", "max"], "high")],
  },
  {
    id: "agy",
    name: "Antigravity",
    available: true,
    models: [
      { id: "neon", name: "Gemini 4 Neon" },
      { id: "hydrogen", name: "Gemini 4 Hydrogen" },
    ],
    defaultModel: "neon",
    settings: [effort(["minimal", "high"])],
  },
] as unknown as AgentInfo[];

describe("a team's reasoning, role by role", () => {
  it("sets each suggested team's roles at its level, UltraMoon being an agent's highest", () => {
    const roles = (id: string) => suggestedPresets(agents).find((p) => p.id === id)!.roles;
    expect(roles("qualite").lead).toEqual({
      agentId: "claude",
      model: "fable",
      settings: { effort: "max" },
    });
    expect(roles("qualite").judge?.settings).toEqual({ effort: "max" });
    expect(roles("qualite").merger?.settings).toEqual({ effort: "medium" });
    expect(roles("equilibree").merger?.settings).toEqual({ effort: "low" });
    expect(roles("economique").coder?.settings).toEqual({ effort: "medium" });
    // Gemini has no « low »: the role stays on the agent's own level.
    expect(roles("economique").tester).toEqual({ agentId: "agy", model: "hydrogen" });
    expect(roles("equilibree").reviewer?.settings).toEqual({ effort: "high" });
  });

  it("puts no level on a role whose agent has not said what it offers yet", () => {
    const quiet = agents.map(({ settings: _s, ...a }) => a) as AgentInfo[];
    expect(suggestedPresets(quiet).find((p) => p.id === "qualite")!.roles.lead).toEqual({
      agentId: "claude",
      model: "fable",
    });
  });

  it("keeps a saved level its agent still offers, and drops one it no longer does", () => {
    const members = presetMembers(
      {
        id: "x",
        label: "X",
        roles: {
          lead: { agentId: "claude", model: "fable", settings: { effort: "xhigh" } },
          coder: { agentId: "agy", model: "neon", settings: { effort: "max" } },
        },
      },
      agents,
    );
    expect(members.lead).toEqual({
      agentId: "claude",
      model: "fable",
      settings: { effort: "xhigh" },
    });
    expect(members.coder).toEqual({ agentId: "agy", model: "neon" });
  });

  it("lets a team be started and saved with a level for each role", () => {
    const ok = (message: unknown) => ClientMessage.safeParse(message).success;
    const role = { agentId: "claude", model: "fable", settings: { effort: "max" } };
    expect(
      ok({
        type: "team.start",
        requestId: "r",
        projectId: "p",
        task: "t",
        lead: role,
        coder: role,
        merger: role,
        coders: 1,
        permissionMode: "full",
      }),
    ).toBe(true);
    expect(
      ok({ type: "teamPresets.set", presets: [{ id: "a", label: "A", roles: { lead: role } }] }),
    ).toBe(true);
  });

  it("shows each role's level next to its model while the team works", () => {
    const team = {
      phase: "planning",
      task: "t",
      coder: { agentId: "claude", model: "opus", settings: { effort: "high" } },
      reviewer: { agentId: "agy", model: "neon" },
      merger: { agentId: "claude", model: "haiku", settings: { effort: "medium" } },
      coders: 2,
      permissionMode: "full",
      tasks: [],
      timeline: [{ at: 0, lane: -1, phase: "planning" }],
    } as unknown as Team;
    const lead = {
      id: "lead",
      agentId: "claude",
      model: "fable",
      settings: { effort: "max" },
      status: "running",
    } as unknown as Thread;
    const rows = teamRows(
      team,
      teamTree({ lead, team, threads: [lead], agents, items: {} }),
      agents,
      0,
    );
    expect(rows.map((r) => [r.name, r.model])).toEqual([
      ["Chef", "Fable 5.2 · UltraMoon"],
      ["Codeurs", "Opus 5.5 · high"],
      ["Relecture", "Gemini 4 Neon"],
      ["Fusion", "Haiku 5.5 · medium"],
    ]);
  });
});
