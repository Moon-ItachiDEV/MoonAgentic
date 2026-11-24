import { describe, expect, it } from "vitest";
import { modelLabel, modelNameOf } from "./model-label.ts";

describe("modelLabel", () => {
  it("names the underlying model in French for Claude Code's Default (recommended)", () => {
    expect(
      modelLabel({
        id: "default",
        name: "Default (recommended)",
        description: "Opus 4.6 · Most capable for complex work",
      }),
    ).toBe("Opus 4.6 (par défaut)");
    expect(
      modelLabel({
        id: "default",
        name: "Default (recommended)",
        description: "Opus 4.6 (1M context) · Most capable for complex work",
      }),
    ).toBe("Opus 4.6 (par défaut)");
    expect(
      modelLabel({
        id: "default",
        name: "Default (recommended)",
        description: "Use the default model (currently Sonnet 4.6) · Best for everyday tasks",
      }),
    ).toBe("Sonnet 4.6 (par défaut)");
  });

  it("falls back to plain French « Par défaut » when the description names no model", () => {
    expect(modelLabel({ id: "default", name: "Default (recommended)" })).toBe("Par défaut");
    expect(
      modelLabel({
        id: "default",
        name: "Default",
        description: "Recommended for everyday coding",
      }),
    ).toBe("Par défaut");
  });

  it("translates a trailing (recommended) on a named model and leaves other names untouched", () => {
    expect(modelLabel({ id: "sonnet", name: "Sonnet 4.6 (recommended)" })).toBe(
      "Sonnet 4.6 (recommandé)",
    );
    expect(modelLabel({ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" })).toBe(
      "Gemini 4 Hydrogen",
    );
    expect(modelLabel({ id: "rapide", name: "Démo rapide" })).toBe("Démo rapide");
  });

  it("looks up by id and falls back to the raw id when unknown", () => {
    const models = [
      { id: "default", name: "Default (recommended)", description: "Sonnet 5.5 · Everyday" },
    ];
    expect(modelNameOf(models, "default")).toBe("Sonnet 5.5 (par défaut)");
    expect(modelNameOf(models, "custom-1")).toBe("custom-1");
    expect(modelNameOf(models, undefined)).toBeUndefined();
  });
});
