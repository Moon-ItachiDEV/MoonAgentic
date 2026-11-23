import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { pickMember, TEAM_PRESETS } from "./team-presets.ts";

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
    pickMember(agents, TEAM_PRESETS.find((p) => p.id === preset)!.prefer[role]);

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
