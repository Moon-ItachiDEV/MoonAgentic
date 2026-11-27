import type { McpServerInfo, Project } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { mcpCount, mcpInProject, mcpScopeLabel, scopeOf } from "./mcp-scope.ts";
import { scopeSwitched } from "./mcp-switch.ts";

const project = (id: string): Project => ({
  id,
  name: `Projet ${id}`,
  path: `/p/${id}`,
  createdAt: 1,
});
const server = (id: string, more: Partial<McpServerInfo> = {}): McpServerInfo => ({
  id,
  name: id,
  enabled: true,
  transport: "stdio",
  target: id,
  secretNames: [],
  ...more,
});
const projects = [project("a"), project("b"), project("c")];

describe("who gets an MCP server", () => {
  it("says the projects and the roles in a few words", () => {
    expect(mcpScopeLabel(scopeOf(server("s")), projects)).toBe("Tous les projets");
    expect(mcpScopeLabel(scopeOf(server("s", { allRoles: true })), projects)).toBe(
      "Tous les projets · toute l'équipe",
    );
    expect(mcpScopeLabel({ projectIds: ["b"], allRoles: false }, projects)).toBe("Projet b");
    expect(mcpScopeLabel({ projectIds: ["a", "c"], allRoles: true }, projects)).toBe(
      "Projet a, Projet c · toute l'équipe",
    );
    expect(mcpScopeLabel({ projectIds: ["a", "b", "c"], allRoles: false }, projects)).toBe(
      "3 projets",
    );
    // For no project, or for one that is gone: it is given to none.
    expect(mcpScopeLabel({ projectIds: [], allRoles: false }, projects)).toBe("Aucun projet");
    expect(mcpScopeLabel({ projectIds: ["parti"], allRoles: false }, projects)).toBe(
      "Aucun projet",
    );
  });

  it("counts the enabled servers a project's threads are given", () => {
    const servers = [
      server("partout"),
      server("pour-a", { projectIds: ["a"] }),
      server("coupé", { enabled: false }),
      server("nulle-part", { projectIds: [] }),
    ];
    expect(mcpCount(servers, "a")).toBe(2);
    expect(mcpCount(servers, "b")).toBe(1);
    // No project yet: only those for every project.
    expect(mcpCount(servers, undefined)).toBe(1);
    expect(mcpInProject(servers[3]!, "a")).toBe(false);
  });
});

describe("a project switched on or off for a server, from its settings", () => {
  // Neon's review of PR #192: switched off then on again, a server for every project stayed
  // stuck on the projects of that day, the new ones never getting it.
  it("goes back to every project once they all have it again", () => {
    const global = server("s");
    const cut = scopeSwitched(global, "b", false, projects);
    expect(cut).toEqual(["a", "c"]);
    expect(scopeSwitched(server("s", { projectIds: cut! }), "b", true, projects)).toBeNull();
  });

  it("keeps the other projects, a locked one included, when one is cut", () => {
    const locked = { ...project("c"), locked: true as const };
    expect(scopeSwitched(server("s"), "a", false, [project("a"), project("b"), locked])).toEqual([
      "b",
      "c",
    ]);
  });

  it("adds or removes only that project from a list", () => {
    const some = server("s", { projectIds: ["a"] });
    expect(scopeSwitched(some, "b", true, projects)).toEqual(["a", "b"]);
    expect(scopeSwitched(some, "a", false, projects)).toEqual([]);
  });
});
