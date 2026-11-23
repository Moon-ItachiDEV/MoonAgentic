import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { parseRouteValue, routeChoices, routeValue } from "./route-choices.ts";

const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, name: id, short: id.slice(0, 2), available: true, ...extra }) as AgentInfo;

const claude = agent("claude", {
  models: [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
  ],
});
const agy = agent("agy", { models: [{ id: "neon", name: "Neon" }] });
const hermes = agent("hermes");
const cursor = agent("cursor", { available: false, models: [{ id: "x", name: "X" }] });
const all = [claude, agy, hermes, cursor];

const flat = (r: ReturnType<typeof routeChoices>) =>
  r.groups.map((g) => [g.agent.id, g.options.map((o) => o.label)]);

describe("routeChoices", () => {
  it("offers only the favorites when there are some", () => {
    const r = routeChoices(
      all,
      { claude: ["opus"], agy: ["neon"], cursor: ["x"] },
      undefined,
      false,
    );
    expect(r.favoritesOnly).toBe(true);
    expect(flat(r)).toEqual([
      ["claude", ["Opus"]],
      ["agy", ["Neon"]],
    ]);
  });

  it("offers every model of the runnable agents without favorites", () => {
    const r = routeChoices(all, {}, undefined, false);
    expect(r.favoritesOnly).toBe(false);
    expect(flat(r)).toEqual([
      ["claude", ["Modèle par défaut", "Opus", "Sonnet"]],
      ["agy", ["Modèle par défaut", "Neon"]],
      ["hermes", ["Modèle par défaut"]],
    ]);
  });

  it("offers every model once « Tous les modèles » is asked for", () => {
    const r = routeChoices(all, { claude: ["opus"] }, undefined, true);
    expect(r.favoritesOnly).toBe(false);
    expect(r.groups).toHaveLength(3);
  });

  it("ignores favorites the agent no longer offers", () => {
    const r = routeChoices(all, { claude: ["gone"] }, undefined, false);
    expect(r.favoritesOnly).toBe(false);
  });

  it("keeps the current route shown when it is not a favorite", () => {
    const r = routeChoices(
      all,
      { claude: ["opus"] },
      { agentId: "claude", model: "sonnet" },
      false,
    );
    expect(flat(r)).toEqual([["claude", ["Sonnet", "Opus"]]]);
  });

  it("keeps a route to an agent that cannot run, marked unavailable", () => {
    const r = routeChoices(all, { claude: ["opus"] }, { agentId: "cursor", model: "x" }, false);
    expect(flat(r)[0]).toEqual(["cursor", ["X (indisponible)"]]);
  });

  it("keeps a route to an agent that is gone", () => {
    const r = routeChoices(all, {}, { agentId: "old" }, false);
    expect(r.groups[0]?.agent.id).toBe("old");
  });
});

describe("routeValue", () => {
  it("round-trips agent and model", () => {
    expect(parseRouteValue(routeValue("claude", "opus"))).toEqual({
      agentId: "claude",
      model: "opus",
    });
    expect(parseRouteValue(routeValue("hermes"))).toEqual({ agentId: "hermes" });
    expect(parseRouteValue("")).toBeUndefined();
  });
});
