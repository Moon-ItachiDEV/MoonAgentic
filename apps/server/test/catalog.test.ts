import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSettingsFor, type AgentSetting } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { AgentCatalog } from "../src/catalog.ts";
import type { ModelOption } from "../src/session.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const modeSetting = (current = "default"): AgentSetting => ({
  id: "mode",
  kind: "mode",
  current,
  choices: [
    { id: "default", name: "Par défaut" },
    { id: "plan", name: "Plan" },
  ],
});

const effortSetting = (current = "medium", choices = ["low", "medium", "high"]): AgentSetting => ({
  id: "thought_level",
  kind: "effort",
  current,
  choices: choices.map((id) => ({ id, name: id })),
});

function setupCatalog() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-catalog-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const agents = new Agents({ demo: true });
  const catalog = new AgentCatalog(store, agents, () => undefined, dir);
  cleanups.push(async () => {
    await catalog.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return { dir, store, agents, catalog };
}

describe("agentSettingsFor", () => {
  it("returns model-specific settings when observed, even when a model omits effort", () => {
    const mode = modeSetting();
    const effort = effortSetting();
    const agent = {
      settings: [mode, effort],
      modelSettings: {
        "gemini-4-neon": [mode, effort],
        "gemini-4-hydrogen": [mode],
      },
    };
    expect(agentSettingsFor(agent, "gemini-4-neon")).toEqual([mode, effort]);
    expect(agentSettingsFor(agent, "gemini-4-hydrogen")).toEqual([mode]);
    // An unobserved model falls back to the agent's general settings.
    expect(agentSettingsFor(agent, "claude-opus-thinking")).toEqual([mode, effort]);
    expect(agentSettingsFor(agent, undefined)).toEqual([mode, effort]);
    expect(agentSettingsFor(undefined, "gemini-4-neon")).toEqual([]);
  });
});

describe("AgentCatalog per-model settings", () => {
  it("keeps effort for thinking models when switching to a model without effort", () => {
    const { catalog } = setupCatalog();
    const models = (current: string): ModelOption => ({
      configId: "model",
      current,
      choices: [
        { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
        { id: "gemini-4-neon", name: "Gemini 4 Neon" },
        { id: "claude-opus-thinking", name: "Claude Opus (Thinking)" },
      ],
    });

    // Fresh session on Neon reports mode + thought_level.
    catalog.learn("demo", models("gemini-4-neon"), [modeSetting(), effortSetting("medium")], true);
    // Later session switches to Hydrogen, which only reports mode.
    catalog.learn("demo", models("gemini-4-hydrogen"), [modeSetting()], false);

    const listed = catalog.list().find((a) => a.id === "demo");
    expect(listed?.modelSettings?.["gemini-4-neon"]?.map((s) => s.kind)).toEqual([
      "mode",
      "effort",
    ]);
    expect(listed?.modelSettings?.["gemini-4-hydrogen"]?.map((s) => s.kind)).toEqual(["mode"]);
    // General fallback settings still preserve effort because Neon offers it.
    expect(listed?.settings?.map((s) => s.kind)).toEqual(["mode", "effort"]);
    expect(catalog.settingsFor("demo", "gemini-4-neon").map((s) => s.kind)).toEqual([
      "mode",
      "effort",
    ]);
    expect(catalog.settingsFor("demo", "gemini-4-hydrogen").map((s) => s.kind)).toEqual(["mode"]);
    expect(catalog.settingsFor("demo", "claude-opus-thinking").map((s) => s.kind)).toEqual([
      "mode",
      "effort",
    ]);

    // A fresh session starting on Hydrogen does not wipe Neon's learned effort either.
    catalog.learn("demo", models("gemini-4-hydrogen"), [modeSetting()], true);
    expect(catalog.settingsFor("demo", "gemini-4-neon").map((s) => s.kind)).toEqual([
      "mode",
      "effort",
    ]);
    // A thread's custom effort override does not replace Neon's learned default.
    catalog.learn("demo", models("gemini-4-neon"), [modeSetting(), effortSetting("high")], false);
    expect(
      catalog.settingsFor("demo", "gemini-4-neon").find((s) => s.kind === "effort")?.current,
    ).toBe("medium");
  });

  it("prunes removed models and discovers both initial and preferred models", async () => {
    const { catalog } = setupCatalog();
    await catalog.discover("demo");

    const demo = catalog.list().find((a) => a.id === "demo");
    expect(demo?.defaultModel).toBe("precis");
    expect(
      demo?.modelSettings?.rapide?.find((s) => s.kind === "effort")?.choices.map((c) => c.id),
    ).toEqual(["bas", "moyen", "haut"]);
    expect(
      demo?.modelSettings?.precis?.find((s) => s.kind === "effort")?.choices.map((c) => c.id),
    ).toEqual(["bas", "moyen", "haut", "max"]);

    // When a model disappears from choices, its stale per-model entry is dropped.
    catalog.learn(
      "demo",
      { configId: "model", current: "precis", choices: [{ id: "precis", name: "Démo précis" }] },
      [modeSetting(), effortSetting("moyen", ["bas", "moyen", "haut", "max"])],
      false,
    );
    expect(Object.keys(catalog.list().find((a) => a.id === "demo")?.modelSettings ?? {})).toEqual([
      "precis",
    ]);
  });

  it("records modelSettings during discover for a custom ACP agent whose models differ in effort", async () => {
    const { dir, catalog } = setupCatalog();
    const script = path.join(dir, "mock-agy.mjs");
    writeFileSync(
      script,
      `import readline from "node:readline";
      let model = "hydrogen";
      const opts = () => [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: [
            { value: "hydrogen", name: "Hydrogen" },
            { value: "neon", name: "Neon" },
          ],
        },
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
        ...(model === "neon"
          ? [{
              id: "thought_level",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            }]
          : []),
      ];
      const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        if (!line.trim()) return;
        const { id, method, params } = JSON.parse(line);
        if (method === "initialize") {
          send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "mock-agy", version: "1.5.0" } } });
        } else if (method === "session/new") {
          send({ id, result: { sessionId: "s1", configOptions: opts() } });
        } else if (method === "session/set_config_option") {
          if (params.configId === "model") model = params.value;
          send({ id, result: { configOptions: opts() } });
        }
      });`,
    );
    const id = catalog.addCustomAgent({
      name: "Mock Agy",
      command: process.execPath,
      args: [script],
    });
    await catalog.discover(id);
    const agent = catalog.list().find((a) => a.id === id);
    expect(agent?.modelSettings?.hydrogen?.map((s) => s.kind)).toEqual(["mode"]);
  });
});
