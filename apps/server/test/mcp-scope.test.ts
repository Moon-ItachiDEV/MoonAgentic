// Who gets an MCP server: the threads of its projects, and in a team those who write code.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import { mcpInfo, mcpServersFor, type McpServerRecord } from "../src/mcp.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const server = (name: string, more: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: name,
  name,
  enabled: true,
  transport: { type: "stdio", command: name, args: [], env: [] },
  ...more,
});
const names = (servers: McpServerRecord[]) => servers.map((s) => s.name);

describe("mcpServersFor", () => {
  const servers = [
    server("partout"),
    server("projet-a", { projectIds: ["a"] }),
    server("a-et-b", { projectIds: ["a", "b"], allRoles: true }),
    server("nulle-part", { projectIds: [] }),
    server("toute-l-equipe", { allRoles: true }),
  ];

  it("gives a thread the servers of every project and those of its own", () => {
    expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "a" }))).toEqual([
      "partout",
      "projet-a",
      "a-et-b",
      "toute-l-equipe",
    ]);
    expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "b" }))).toEqual([
      "partout",
      "a-et-b",
      "toute-l-equipe",
    ]);
    expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "c" }))).toEqual([
      "partout",
      "toute-l-equipe",
    ]);
  });

  it("gives a team's reviewer, tester and merger only the servers said to be for every role", () => {
    for (const role of ["lead", "coder"] as const) {
      expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "a", role }))).toEqual([
        "partout",
        "projet-a",
        "a-et-b",
        "toute-l-equipe",
      ]);
    }
    for (const role of ["reviewer", "tester", "merger"] as const) {
      expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "a", role }))).toEqual([
        "a-et-b",
        "toute-l-equipe",
      ]);
      expect(names(mcpServersFor(servers, { agentId: "claude", projectId: "c", role }))).toEqual([
        "toute-l-equipe",
      ]);
    }
  });

  it("gives a server only to the agents it is for", () => {
    const some = [
      server("tous"),
      server("claude-seul", { agentIds: ["claude"] }),
      server("aucun", { agentIds: [] }),
    ];
    expect(names(mcpServersFor(some, { agentId: "claude", projectId: "a" }))).toEqual([
      "tous",
      "claude-seul",
    ]);
    expect(names(mcpServersFor(some, { agentId: "codex", projectId: "a" }))).toEqual(["tous"]);
    expect(mcpInfo(some[1]!)).toMatchObject({ agentIds: ["claude"] });
    expect(mcpInfo(some[0]!)).not.toHaveProperty("agentIds");
  });

  it("tells clients who gets a server, and nothing when it is everyone who writes code", () => {
    expect(mcpInfo(server("partout"))).not.toHaveProperty("projectIds");
    expect(mcpInfo(server("partout"))).not.toHaveProperty("allRoles");
    expect(mcpInfo(servers[2]!)).toMatchObject({ projectIds: ["a", "b"], allRoles: true });
    expect(mcpInfo(servers[3]!)).toMatchObject({ projectIds: [] });
  });
});

describe("MCP servers by project", () => {
  function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-mcp-scope-"));
    for (const name of [".home", "a", "b"]) mkdirSync(path.join(dir, name));
    const store = new Store(path.join(dir, "state.sqlite"));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
    });
    const messages: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void messages.push(m) };
    hub.connect(client);
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const a = hub.createProject("a", path.join(dir, "a"));
    const b = hub.createProject("b", path.join(dir, "b"));
    /** What the demo agent says it was given, in a new thread of that project. */
    const given = async (projectId: string, role?: "coder" | "reviewer" | "tester" | "merger") => {
      const threadId = hub.createThread({
        projectId,
        agentId: "demo",
        permissionMode: "full",
        text: "Un",
        ...(role ? { role } : {}),
      });
      // A reviewer's turn stops on a permission it has to ask for: that is far enough.
      const said = () => store.listItems(threadId).find((i) => i.kind === "agent");
      await expect
        .poll(() => !!said() && store.getThread(threadId)?.status !== "running", {
          timeout: 10_000,
        })
        .toBe(true);
      await hub.handle(client, { type: "thread.cancel", threadId });
      await hub.whenIdle(threadId);
      const reply = said();
      const text = reply && "text" in reply ? reply.text : "";
      return /Serveurs MCP reçus : ([^.]*)\./.exec(text)?.[1] ?? "";
    };
    const stdio = (command: string): McpServerRecord["transport"] => ({
      type: "stdio",
      command,
      args: [],
      env: [{ name: "TOKEN", value: "s3cret" }],
    });
    return { hub, store, client, messages, a, b, given, stdio };
  }

  it("hands a server to the threads of its projects only, and to a team's checkers when said", async () => {
    const { hub, client, messages, a, b, given, stdio } = setup();
    await hub.addMcpServer({ name: "partout", transport: stdio("x") });
    // Added for one project from the start; a project that does not exist is left out.
    const forA = await hub.addMcpServer({
      name: "pour-a",
      transport: stdio("y"),
      projectIds: [a, "inconnu", a],
    });
    expect(hub.snapshot().mcpServers).toMatchObject([
      { name: "partout" },
      { name: "pour-a", projectIds: [a] },
    ]);
    expect(hub.snapshot().mcpServers[0]).not.toHaveProperty("projectIds");

    expect(await given(a)).toBe("partout, pour-a");
    expect(await given(b)).toBe("partout");
    expect(await given(a, "coder")).toBe("partout, pour-a");
    // Those who read, run and merge get none unless a server is for every role.
    for (const role of ["reviewer", "tester", "merger"] as const)
      expect(await given(a, role)).toBe("");

    await hub.handle(client, {
      type: "mcp.setScope",
      id: forA,
      projectIds: [a, b],
      allRoles: true,
    });
    expect(messages.at(-1)).toMatchObject({
      type: "mcpServers",
      servers: [{ name: "partout" }, { name: "pour-a", projectIds: [a, b], allRoles: true }],
    });
    expect(await given(b)).toBe("partout, pour-a");
    expect(await given(b, "reviewer")).toBe("pour-a");

    // Back to every project, and to those who write code.
    await hub.handle(client, { type: "mcp.setScope", id: forA, projectIds: null, allRoles: false });
    const all = hub.snapshot().mcpServers[1]!;
    expect(all).not.toHaveProperty("projectIds");
    expect(all).not.toHaveProperty("allRoles");
    expect(await given(b, "tester")).toBe("");
    expect(JSON.stringify([hub.snapshot(), messages])).not.toContain("s3cret");
  }, 40_000);

  it("leaves a server for no project when its only project is removed, never for all", async () => {
    const { hub, a, b, given, stdio } = setup();
    const id = await hub.addMcpServer({ name: "pour-a", transport: stdio("y"), projectIds: [a] });
    await hub.removeProject(a);
    expect(hub.snapshot().mcpServers).toMatchObject([{ id, name: "pour-a", projectIds: [] }]);
    expect(await given(b)).toBe("");
  });

  // Neon's review of PR #193: cut from one project, a server for every project stays for
  // every other one, the projects made later included.
  it("keeps a server for every project but those left out, then for all of them again", async () => {
    const { hub, client, a, b, given, stdio } = setup();
    const id = await hub.addMcpServer({ name: "partout", transport: stdio("x") });
    await hub.handle(client, {
      type: "mcp.setScope",
      id,
      projectIds: null,
      exceptProjectIds: [a, "inconnu"],
      allRoles: false,
    });
    expect(hub.snapshot().mcpServers[0]).toMatchObject({ exceptProjectIds: [a] });
    expect(hub.snapshot().mcpServers[0]).not.toHaveProperty("projectIds");
    expect(await given(a)).toBe("");
    expect(await given(b)).toBe("partout");
    await hub.removeProject(a);
    expect(hub.snapshot().mcpServers[0]).not.toHaveProperty("exceptProjectIds");
  }, 40_000);
});
