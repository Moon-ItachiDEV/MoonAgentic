import { describe, expect, it } from "vitest";
import { speakerName } from "./speaker.ts";

const agy = {
  id: "antigravity",
  name: "Antigravity",
  models: [
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "claude-opus", name: "Claude Opus 5.5" },
  ],
  defaultModel: "gemini-3-pro",
};

describe("speakerName", () => {
  it("names the model that answers, not the agent that runs it", () => {
    expect(speakerName(agy, { agentId: "antigravity", model: "claude-opus" })).toBe(
      "Claude Opus 5.5",
    );
  });

  it("uses the agent's default model when the thread picked none", () => {
    expect(speakerName(agy, { agentId: "antigravity" })).toBe("Gemini 3 Pro");
  });

  it("shows a model it has no name for by its id", () => {
    expect(speakerName(agy, { agentId: "antigravity", model: "gemini-4-neon" })).toBe(
      "gemini-4-neon",
    );
  });

  it("does the same for every agent", () => {
    const claude = {
      id: "claude",
      name: "Claude Code",
      models: [{ id: "opus", name: "Opus 5.5" }],
    };
    const codex = { id: "codex", name: "Codex", models: [{ id: "gpt-5", name: "GPT-5" }] };
    expect(speakerName(claude, { agentId: "claude", model: "opus" })).toBe("Opus 5.5");
    expect(speakerName(codex, { agentId: "codex", model: "gpt-5" })).toBe("GPT-5");
  });

  it("keeps the agent's name while no model is known", () => {
    expect(speakerName({ id: "hermes", name: "Hermes" }, { agentId: "hermes" })).toBe("Hermes");
  });

  it("keeps the agent's name for an answer from before a handoff", () => {
    expect(speakerName(agy, { agentId: "claude", model: "opus" })).toBe("Antigravity");
  });

  it("says when the agent is gone", () => {
    expect(speakerName(undefined, { agentId: "x" })).toBe("Agent retiré");
  });
});
