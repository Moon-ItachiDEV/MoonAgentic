import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { coordinatorDefault, findModel, looseDefault } from "./default-models.ts";

const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, name: id, short: id.slice(0, 2), available: true, ...extra }) as AgentInfo;

const claude = agent("claude", { models: [{ id: "opus", name: "Opus 5.5" }] });
const agy = agent("antigravity", {
  models: [
    { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "orch-neon", name: "Orchestrator (Neon)" },
  ],
});

describe("default models", () => {
  it("gives the coordinator Antigravity's Neon orchestrator", () => {
    expect(coordinatorDefault([claude, agy], { claude: ["opus"] })).toEqual({
      agentId: "antigravity",
      model: "orch-neon",
    });
  });

  it("falls back to the first favorite without the orchestrator", () => {
    const plain = agent("antigravity", {
      models: [{ id: "gemini-4-neon", name: "Gemini 4 Neon" }],
    });
    expect(coordinatorDefault([claude, plain], { claude: ["opus"] })).toEqual({
      agentId: "claude",
      model: "opus",
    });
  });

  it("starts a conversation outside a project on Hydrogen", () => {
    expect(looseDefault([claude, agy])).toEqual({
      agentId: "antigravity",
      model: "gemini-4-hydrogen",
    });
  });

  it("finds nothing on an agent that cannot run or has no list yet", () => {
    expect(looseDefault([claude, { ...agy, available: false }])).toBeUndefined();
    expect(findModel([agent("antigravity")], () => true)).toBeUndefined();
  });
});
