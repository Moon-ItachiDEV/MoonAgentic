import type { McpServerInfo, Project } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { mcpCount, mcpInProject, mcpScopeLabel, scopeOf } from "./mcp-scope.ts";
import { lockedOnly, scopeSwitched } from "./mcp-switch.ts";

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
  // Neon's reviews of PR #192 and #193: cut from one project, a server for every project
  // stayed a list of that day's projects, and could no longer be told from one made for them.
  it("keeps a server for every project one, that project left out, then let back in", () => {
    const cut = scopeSwitched(server("s"), "b", false);
    expect(cut).toEqual({ projectIds: null, exceptProjectIds: ["b"] });
    expect(scopeSwitched(server("s", { exceptProjectIds: ["b"] }), "b", true)).toEqual({
      projectIds: null,
    });
    expect(mcpScopeLabel({ ...cut, allRoles: false }, projects)).toBe("Tous sauf 1 projet");
    expect(mcpInProject(server("s", { exceptProjectIds: ["b"] }), "b")).toBe(false);
    expect(mcpInProject(server("s", { exceptProjectIds: ["b"] }), "a")).toBe(true);
  });

  it("adds or removes only that project from a list", () => {
    const some = server("s", { projectIds: ["a"] });
    expect(scopeSwitched(some, "b", true)).toEqual({ projectIds: ["a", "b"] });
    expect(scopeSwitched(some, "a", false)).toEqual({ projectIds: [] });
  });

  it("tells a locked project's own server, not to be offered elsewhere", () => {
    const locked = [{ ...project("a"), locked: true as const }, project("b")];
    expect(lockedOnly(server("s", { projectIds: ["a"] }), locked)).toBe(true);
    expect(lockedOnly(server("s", { projectIds: ["a", "b"] }), locked)).toBe(false);
    expect(lockedOnly(server("s"), locked)).toBe(false);
    expect(lockedOnly(server("s", { projectIds: [] }), locked)).toBe(false);
  });
});
