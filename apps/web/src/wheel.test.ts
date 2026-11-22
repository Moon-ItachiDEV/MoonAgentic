import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { wheelEntries } from "./wheel.ts";

const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, name: id, short: id.slice(0, 2), available: true, ...extra }) as AgentInfo;

describe("wheelEntries", () => {
  const claude = agent("claude", {
    models: [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ],
  });
  const codex = agent("codex");
  const cursor = agent("cursor", { available: false });

  it("lists every runnable agent's favorites, by their names", () => {
    const entries = wheelEntries(
      [claude, codex, cursor],
      { claude: ["sonnet"], codex: ["gpt"], cursor: ["x"] },
      { agent: claude, model: "sonnet" },
    );
    expect(entries.map((e) => [e.agent.id, e.model, e.name])).toEqual([
      ["claude", "sonnet", "Sonnet"],
      ["codex", "gpt", "gpt"],
    ]);
  });

  it("puts the current pick first when it is not a favorite", () => {
    const entries = wheelEntries(
      [claude],
      { claude: ["sonnet"] },
      { agent: claude, model: "opus" },
    );
    expect(entries.map((e) => e.name)).toEqual(["Opus", "Sonnet"]);
  });

  it("drops a favorite the agent no longer offers", () => {
    const entries = wheelEntries([claude], { claude: ["gone"] }, { agent: claude, model: "opus" });
    expect(entries.map((e) => e.model)).toEqual(["opus"]);
  });

  it("shows an agent without models by its default", () => {
    const entries = wheelEntries([codex], {}, { agent: codex, model: undefined });
    expect(entries).toEqual([{ agent: codex, model: undefined, name: "Modèle par défaut" }]);
  });
});
