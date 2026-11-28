import type { AgentSetting } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { effortLevels, effortOfValues, pickEffort } from "../src/effort-level.ts";

const levels = (...names: string[]): AgentSetting[] => [
  { id: "mode", kind: "mode", choices: [{ id: "agent", name: "Agent" }], current: "agent" },
  {
    id: "reasoning",
    kind: "effort",
    choices: names.map((name) => ({ id: name.toLowerCase().replace(/\s/g, ""), name })),
    current: names[0]!.toLowerCase(),
  },
];

describe("the effort level a coordinator asks for", () => {
  it("is the agent's level of that name, however it is written", () => {
    const settings = levels("Low", "Medium", "High", "X High", "Max");
    expect(pickEffort(settings, "xhigh", "Neon").choice.id).toBe("xhigh");
    expect(pickEffort(settings, "x-high", "Neon").choice.id).toBe("xhigh");
    expect(pickEffort(settings, "HIGH", "Neon").choice.id).toBe("high");
    // The same level in the other language.
    expect(pickEffort(settings, "élevé", "Neon").choice.id).toBe("high");
    expect(pickEffort(settings, "moyen", "Neon").choice.id).toBe("medium");
    // « UltraMoon » is the highest the model has.
    expect(pickEffort(settings, "UltraMoon", "Neon").choice.id).toBe("max");
    expect(effortLevels(settings)).toEqual(["Low", "Medium", "High", "X High", "Max (UltraMoon)"]);
  });

  it("is never a nearby level: one the model lacks is an error naming those it has", () => {
    expect(() => pickEffort(levels("Low", "Medium", "High"), "xhigh", "Neon")).toThrow(
      "Neon ne propose pas l'effort « xhigh ». Niveaux disponibles : Low, Medium, High (UltraMoon).",
    );
    expect(() => pickEffort([], "high", "Neon")).toThrow("pas encore connus");
    expect(() => pickEffort([levels("Low")[0]!], "high", "Neon")).toThrow(
      "ne propose pas de niveau d'effort",
    );
  });

  it("is said back by its name, from the values the thread runs on", () => {
    const settings = levels("Low", "High");
    expect(effortOfValues(settings, { reasoning: "low", mode: "agent" })).toBe("Low");
    expect(effortOfValues(settings, { reasoning: "high" })).toBe("High (UltraMoon)");
    expect(effortOfValues(settings, { mode: "agent" })).toBeUndefined();
  });
});
