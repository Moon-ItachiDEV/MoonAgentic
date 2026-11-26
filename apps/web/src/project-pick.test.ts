import type { Project, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { codeThreads, startProject, tabProjects } from "./project-pick.ts";

const project = (id: string, more: Partial<Project> = {}): Project =>
  ({ id, name: id, path: `/p/${id}`, createdAt: 1, ...more }) as Project;
const thread = (id: string, projectId: string, updatedAt = 1): Thread =>
  ({
    id,
    projectId,
    title: id,
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    workspace: { branch: id },
    createdAt: 1,
    updatedAt,
  }) as unknown as Thread;

describe("archived projects", () => {
  it("leave the phone's « Code » tab", () => {
    const state = {
      projects: [project("a"), project("b", { archived: true })],
      threads: [thread("t1", "a", 1), thread("t2", "b", 2)],
    };
    expect(codeThreads(state).map((t) => t.id)).toEqual(["t1"]);
  });

  it("leave the phone's « Projets » tab", () => {
    const projects = [project("a"), project("b", { archived: true }), project("Discussions")];
    expect(tabProjects(projects).map((p) => p.id)).toEqual(["a"]);
  });

  it("are not where a new conversation starts, even when last picked", () => {
    const projects = [project("a", { archived: true }), project("b"), project("Discussions")];
    expect(startProject({ projects, looseHome: false, pickedProjectId: "a" })?.id).toBe("b");
    // The open thread's own project stays its own.
    expect(
      startProject({ projects, looseHome: false, threadProjectId: "a", pickedProjectId: "b" })?.id,
    ).toBe("a");
    expect(startProject({ projects, looseHome: true, pickedProjectId: "b" })?.id).toBe(
      "Discussions",
    );
  });
});
