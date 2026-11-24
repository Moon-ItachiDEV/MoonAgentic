import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { favoriteSuggestions } from "./favorite-suggestions.ts";

const agent = (id: string, models: string[] | undefined, extra: Partial<AgentInfo> = {}) =>
  ({
    id,
    name: id,
    short: id.slice(0, 2),
    available: true,
    models: models?.map((m) => ({ id: m.toLowerCase().replace(/\W+/g, "-"), name: m })),
    ...extra,
  }) as AgentInfo;

describe("favoriteSuggestions", () => {
  const claude = agent("claude", ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  const agy = agent("antigravity", ["Orchestrator (Neon)", "Gemini 4 Neon", "Gemini 4 Hydrogen"]);

  it("suggests the models the app picks by default, in the wheel's order", () => {
    const names = favoriteSuggestions([claude, agy], {}).map((s) => [s.model, s.roles[0]]);
    expect(names).toEqual([
      ["orchestrator-neon-", "Coordinateur des projets"],
      ["fable-5-2", "Chef de l'équipe"],
      ["opus-5-5", "Codeur de l'équipe"],
      ["gemini-4-neon", "Relecteur de l'équipe"],
      ["sonnet-5-5", "Tests de l'équipe"],
      ["haiku-5-5", "Fusion de l'équipe"],
      ["gemini-4-hydrogen", "Discussions hors projet"],
    ]);
  });

  it("suggests nothing from an agent whose models are not known, or not ready", () => {
    const unknown = agent("antigravity", undefined);
    const off = agent("claude", ["Opus 5.5"], { available: false });
    expect(favoriteSuggestions([off, unknown], {})).toEqual([]);
  });

  it("leaves out what is already a favorite, and gives one line per model", () => {
    const onlyOpus = agent("claude", ["Opus 5.5"]);
    expect(favoriteSuggestions([onlyOpus], { claude: ["opus-5-5"] })).toEqual([]);
    // Opus alone: the team's coder only, never twice.
    expect(favoriteSuggestions([onlyOpus], {})).toEqual([
      { agentId: "claude", model: "opus-5-5", roles: ["Codeur de l'équipe"] },
    ]);
  });
});
