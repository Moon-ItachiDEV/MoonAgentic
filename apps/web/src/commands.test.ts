import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  composerCommands,
  fillTemplate,
  matchCommands,
  messageTokens,
  planModes,
  replaceTrigger,
  resolveSubmission,
  triggerAt,
} from "./commands.ts";

const agent: AgentInfo = {
  id: "claude",
  name: "Claude Code",
  short: "CC",
  available: true,
  settings: [
    {
      id: "mode",
      kind: "mode",
      current: "default",
      choices: [
        { id: "default", name: "Par défaut" },
        { id: "plan", name: "Plan Mode" },
      ],
    },
  ],
  commands: [{ name: "compact", description: "ancienne liste" }],
};

const list = (inThread = true) =>
  composerCommands({
    agent,
    agentCommands: [
      { name: "init", description: "Crée CLAUDE.md" },
      { name: "plan", description: "Le plan de l'agent" },
      { name: "explique", description: "Explique", hint: "fichier" },
      { name: "deploy", description: "Celle de l'agent" },
    ],
    projectCommands: [{ name: "deploy", description: "Déploie", template: "Déploie $ARGUMENTS" }],
    inThread,
  });

describe("composer commands", () => {
  it("lets MoonAgentic's actions win, then the project's, then the agent's, then ready-made ones", () => {
    const commands = list();
    const byName = (name: string) => commands.find((c) => c.name === name);
    expect(byName("plan")).toMatchObject({ source: "app", hides: ["Claude Code"] });
    expect(byName("deploy")).toMatchObject({ source: "project", hides: ["Claude Code"] });
    expect(byName("init")).toMatchObject({ source: "agent", hides: ["MoonAgentic"] });
    expect(byName("review")).toMatchObject({ source: "template" });
    expect(byName("explique")).toMatchObject({ by: "Claude Code", hint: "fichier" });
    // The thread's own list replaces the one remembered for the agent.
    expect(byName("compact")).toBeUndefined();
    expect(commands.filter((c) => c.name === "deploy")).toHaveLength(1);
  });

  it("offers thread actions only in a thread, and plan only to agents that have it", () => {
    expect(list(false).some((c) => c.name === "epingler")).toBe(false);
    expect(list(true).some((c) => c.name === "epingler")).toBe(true);
    const noPlan = composerCommands({
      agent: { ...agent, settings: [] },
      agentCommands: undefined,
      projectCommands: [],
      inThread: false,
    });
    expect(noPlan.some((c) => c.name === "plan")).toBe(false);
    expect(noPlan.some((c) => c.name === "compact")).toBe(true);
    expect(planModes(agent.settings)).toMatchObject({ plan: "plan", normal: "default" });
  });

  it("matches the start of a name before its middle", () => {
    expect(matchCommands(list(), "ex").map((c) => c.name)).toEqual(["exporter", "explique"]);
    expect(matchCommands(list(), "pin").map((c) => c.name)).toEqual(["epingler"]);
  });

  it("turns what is sent into an action, a ready-made message, or the text as typed", () => {
    const commands = list();
    expect(resolveSubmission("/plan corrige le bug", commands)).toEqual({
      kind: "action",
      action: "plan",
      rest: "corrige le bug",
    });
    expect(resolveSubmission("/deploy main", commands)).toEqual({
      kind: "send",
      text: "Déploie main",
    });
    expect(resolveSubmission("/test", commands).kind).toBe("send");
    expect(resolveSubmission("/init", commands)).toEqual({ kind: "send", text: "/init" });
    expect(resolveSubmission("/inconnue x", commands)).toEqual({
      kind: "send",
      text: "/inconnue x",
    });
    expect(fillTemplate("Relis.", "src/app.ts")).toBe("Relis.\n\nsrc/app.ts");
  });
});

describe("the word being typed", () => {
  it("finds a command at the start only, and mentions or skills anywhere", () => {
    expect(triggerAt("/pl", 3)).toEqual({ kind: "/", query: "pl", start: 0, end: 3 });
    expect(triggerAt("lis /pl", 7)).toBeNull();
    expect(triggerAt("lis @src/a", 10)).toEqual({ kind: "@", query: "src/a", start: 4, end: 10 });
    expect(triggerAt("fais $rev puis", 9)).toEqual({ kind: "$", query: "rev", start: 5, end: 9 });
    expect(triggerAt("fais $revue puis", 9)).toMatchObject({ query: "rev", end: 11 });
    expect(triggerAt("a@b", 3)).toBeNull();
    expect(triggerAt("/usr/bin", 8)).toBeNull();
  });

  it("puts the picked value in place of the word", () => {
    const trigger = triggerAt("lis @ap puis", 7)!;
    expect(replaceTrigger("lis @ap puis", trigger, "@src/app.ts")).toEqual({
      text: "lis @src/app.ts puis",
      caret: 16,
    });
  });

  it("marks files and skills in a sent message", () => {
    expect(messageTokens("Lis @src/app.ts, avec $revue. Coût : $5")).toEqual([
      { text: "Lis " },
      { text: "@src/app.ts", kind: "file" },
      { text: ", avec " },
      { text: "$revue", kind: "skill" },
      { text: ". Coût : $5" },
    ]);
  });
});
