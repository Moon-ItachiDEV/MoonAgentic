import { describe, expect, it } from "vitest";
import { workerModel } from "../src/worker-model.ts";

const agy = {
  defaultModel: "gemini-4-carbon",
  models: [
    { id: "orchestrator-neon", name: "Orchestrator (Neon)" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
  ],
};

describe("workerModel", () => {
  it("swaps an orchestrator for the model it is named after", () => {
    expect(workerModel(agy, "orchestrator-neon")).toBe("gemini-4-neon");
  });

  it("knows an orchestrator by its name when its id does not say", () => {
    const opaque = {
      ...agy,
      models: [{ id: "m7", name: "Orchestrator (Neon)" }, ...agy.models.slice(1)],
    };
    expect(workerModel(opaque, "m7")).toBe("gemini-4-neon");
  });

  it("falls back on the agent's default, then on its first other model", () => {
    const unnamed = {
      ...agy,
      models: [{ id: "orch", name: "Orchestrator" }, ...agy.models.slice(1)],
    };
    expect(workerModel(unnamed, "orch")).toBe("gemini-4-carbon");
    expect(workerModel({ ...unnamed, defaultModel: "orch" }, "orch")).toBe("gemini-4-carbon");
  });

  it("keeps any other model, and an orchestrator that is all the agent has", () => {
    expect(workerModel(agy, "gemini-4-hydrogen")).toBe("gemini-4-hydrogen");
    expect(workerModel(agy, undefined)).toBeUndefined();
    const only = { models: [{ id: "orchestrator-neon", name: "Orchestrator (Neon)" }] };
    expect(workerModel(only, "orchestrator-neon")).toBe("orchestrator-neon");
  });

  it("lets the agent pick while its models are not known", () => {
    expect(workerModel({}, "orchestrator-neon")).toBeUndefined();
  });
});
