import type { AgentInfo } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  coordinatorDefault,
  findModel,
  isDiscussionsProject,
  isLooseHome,
  looseDefault,
} from "./default-models.ts";

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
    expect(looseDefault([claude, { ...agy, modelsError: "agy est parti" }])).toBeUndefined();
    expect(findModel([agent("antigravity")], () => true)).toBeUndefined();
  });

  it("recognizes Discussions and treats home without a code project as loose mode", () => {
    expect(isDiscussionsProject({ name: "Discussions" })).toBe(true);
    expect(isDiscussionsProject({ name: "MoonAgentic" })).toBe(false);
    // As the server makes it: in a folder of that name, a trailing separator or not.
    expect(isDiscussionsProject({ name: "Discussions", path: "/home/a/Discussions" })).toBe(true);
    expect(isDiscussionsProject({ name: "Discussions", path: "C:\\Users\\a\\Discussions\\" })).toBe(
      true,
    );
    // A project of the user's that is only called so stays a project.
    expect(isDiscussionsProject({ name: "Discussions", path: "/home/a/code/forum" })).toBe(false);
    expect(isDiscussionsProject(undefined)).toBe(false);

    // Home with only Discussions or no project starts on Hydrogen immediately.
    expect(isLooseHome({ routeName: "home", loose: false, project: undefined })).toBe(true);
    expect(isLooseHome({ routeName: "home", loose: false, project: { name: "Discussions" } })).toBe(
      true,
    );
    // Home with a code project stays on the user's pick unless « Nouvelle discussion » was asked.
    expect(isLooseHome({ routeName: "home", loose: false, project: { name: "MoonAgentic" } })).toBe(
      false,
    );
    expect(isLooseHome({ routeName: "home", loose: true, project: { name: "MoonAgentic" } })).toBe(
      true,
    );
    // Outside home (project page or thread), loose mode does not apply.
    expect(
      isLooseHome({ routeName: "project", loose: false, project: { name: "Discussions" } }),
    ).toBe(false);
    expect(
      isLooseHome({ routeName: "thread", loose: true, project: { name: "Discussions" } }),
    ).toBe(false);
  });
});
