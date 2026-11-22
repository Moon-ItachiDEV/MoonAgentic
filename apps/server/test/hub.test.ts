import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { historyBefore } from "../src/history.ts";
import { type Client, Hub } from "../src/hub.ts";
import { LEGACY_MODE, modelOption } from "../src/session.ts";
import { Store } from "../src/store.ts";

class TestClient implements Client {
  openThreadId?: string;
  readonly messages: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];

  send(message: ServerMessage): void {
    this.messages.push(message);
    this.waiters = this.waiters.filter((w) => !(w.match(message) && (w.resolve(message), true)));
  }

  next(match: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-test-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, ".worktrees"),
  });
  const client = new TestClient();
  hub.connect(client);
  const projectId = hub.createProject("demo", dir);
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, hub, client, projectId };
}

/** Makes demo agents started from now on offer their models in another way. */
function demoModels(style: "legacy" | "none" | "hang" | "fail" | "load") {
  process.env.MOONAGENTIC_DEMO_MODELS = style;
  cleanups.push(() => {
    delete process.env.MOONAGENTIC_DEMO_MODELS;
  });
}

const isPermissionRequest = (m: ServerMessage) =>
  m.type === "item" && m.item.kind === "permission" && m.item.outcome === null;

const kinds = (items: Item[]) => items.map((i) => i.kind);

describe("Hub with the demo agent", () => {
  it("streams a supervised turn, waits for permission, and persists the timeline", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Corrige la réponse",
    });
    client.openThreadId = threadId;

    const request = await asked;
    expect(store.getThread(threadId)?.status).toBe("waiting");
    if (request.type !== "item") throw new Error("unreachable");
    hub.respondToPermission(threadId, request.item.id, "allow");
    await hub.whenIdle(threadId);

    const items = store.listItems(threadId);
    expect(kinds(items)).toEqual([
      "user",
      "thought",
      "plan",
      "tool",
      "agent",
      "tool",
      "permission",
      "agent",
    ]);
    expect(items[4]).toMatchObject({
      kind: "agent",
      text: "Tu m'as demandé : « Corrige la réponse » (modèle precis). ",
    });
    expect(items[5]).toMatchObject({
      kind: "tool",
      status: "completed",
      content: [{ type: "diff", path: "src/app.ts", newText: "export const answer = 42;" }],
    });
    expect(items[2]).toMatchObject({ entries: [{ status: "completed" }, { status: "completed" }] });
    expect(items[6]).toMatchObject({ outcome: "allow" });
    expect(store.getThread(threadId)).toMatchObject({
      status: "idle",
      title: "Corrige la réponse",
    });
    expect(client.messages.some((m) => m.type === "append")).toBe(true);
  });

  it("answers permission requests itself in full access", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Vas-y",
    });
    await hub.whenIdle(threadId);

    const items = store.listItems(threadId);
    expect(kinds(items)).not.toContain("permission");
    expect(items.find((i) => i.id === "tool:edit-1")).toMatchObject({ status: "completed" });
  });

  it("settles an open permission request as cancelled when the turn is cancelled", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Stop",
    });
    client.openThreadId = threadId;
    await asked;
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    expect(store.listItems(threadId).find((i) => i.kind === "permission")).toMatchObject({
      outcome: "cancelled",
    });
    expect(store.getThread(threadId)?.status).toBe("idle");
  });

  it("keeps the same agent session across turns", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const first = store.getSessionId(threadId);
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);

    expect(first).toBeTruthy();
    expect(store.getSessionId(threadId)).toBe(first);
    expect(store.listItems(threadId).filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("refuses a second message while a turn is running", async () => {
    const { hub, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Un",
    });
    client.openThreadId = threadId;
    await asked;
    expect(() => hub.send(threadId, "Deux")).toThrow("L'agent travaille encore");
  });

  it("marks the thread as failed when the agent errors", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "boom",
    });
    await hub.whenIdle(threadId);

    expect(store.getThread(threadId)?.status).toBe("error");
    expect(store.getThread(threadId)?.error).toContain("Le démo a planté exprès.");
  });

  it("starts new threads on the agent's preferred model and remembers the models it offers", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);

    expect(store.getThread(threadId)?.model).toBe("precis");
    expect(hub.snapshot().agents.find((a) => a.id === "demo")).toMatchObject({
      defaultModel: "precis",
      models: [{ id: "rapide" }, { id: "precis" }],
    });
  });

  it("uses the model picked at creation, and switches models between turns", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    await hub.setModel(threadId, "precis");
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);

    const replies = store
      .listItems(threadId)
      .filter((i) => i.kind === "agent")
      .map((i) => ("text" in i ? i.text : ""));
    expect(replies.some((t) => t.includes("« Un » (modèle rapide)"))).toBe(true);
    expect(replies.some((t) => t.includes("« Deux » (modèle precis)"))).toBe(true);
    expect(store.getThread(threadId)?.model).toBe("precis");
  });

  it("keeps a model picked while the thread's agent was stopped, despite the session replay", async () => {
    demoModels("load");
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      model: "rapide",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    await hub.close();

    // A restarted server: the agent reloads its saved session, which replays "rapide".
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(os.tmpdir(), "unused-worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    await restarted.setModel(threadId, "precis");
    restarted.send(threadId, "Deux");
    await restarted.whenIdle(threadId);

    const replies = store.listItems(threadId).filter((i) => i.kind === "agent");
    expect(replies.at(-1)).toMatchObject({ text: expect.stringContaining("(modèle precis)") });
    expect(store.getThread(threadId)?.model).toBe("precis");
  });

  it("takes the context use an agent states while reloading its session", async () => {
    demoModels("load");
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.usage?.used).toBe(24_000);
    await hub.close();

    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(os.tmpdir(), "unused-worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    // This turn fails before the agent reports anything new, so only the reload speaks.
    restarted.send(threadId, "boom");
    await restarted.whenIdle(threadId);
    expect(store.getThread(threadId)?.usage?.used).toBe(99_000);
  });

  it("refuses an unknown model, and a switch while the agent is answering", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Un",
    });
    client.openThreadId = threadId;
    await asked;
    await expect(hub.setModel(threadId, "rapide")).rejects.toThrow("fin de la réponse");
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    await expect(hub.setModel(threadId, "inexistant")).rejects.toThrow("Modèle inconnu");
    expect(store.getThread(threadId)?.model).toBe("precis");
  });

  it("lists an agent's models before any thread uses it", async () => {
    const { hub, projectId } = setup();
    expect(hub.snapshot().agents.find((a) => a.id === "demo")?.models).toBeUndefined();
    await hub.discover("demo", projectId);
    expect(hub.snapshot().agents.find((a) => a.id === "demo")?.models).toHaveLength(2);
  });

  it("remembers that an agent offers no model choice, so the UI stops asking", async () => {
    demoModels("none");
    const { hub, store, projectId } = setup();
    // A catalog saved before settings existed is missing them, so the picker asks again.
    store.setAgentModels("demo", { models: [], current: "" });
    expect(hub.snapshot().agents.find((a) => a.id === "demo")).not.toHaveProperty("settings");
    await hub.discover("demo", projectId);
    expect(hub.snapshot().agents.find((a) => a.id === "demo")).toMatchObject({
      models: [],
      settings: [],
    });
  });

  it("shows why an agent could not list its models, until a retry", async () => {
    demoModels("fail");
    const { hub, projectId } = setup();
    await hub.discover("demo", projectId);
    expect(hub.snapshot().agents.find((a) => a.id === "demo")?.modelsError).toContain(
      "Connecte-toi d'abord.",
    );

    delete process.env.MOONAGENTIC_DEMO_MODELS;
    await hub.discover("demo", projectId);
    const demo = hub.snapshot().agents.find((a) => a.id === "demo");
    expect(demo?.modelsError).toBeUndefined();
    expect(demo?.models).toHaveLength(2);
  });

  it("picks models and modes on agents that still use session/set_model and set_mode", async () => {
    demoModels("legacy");
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      settings: { [LEGACY_MODE]: "plan" },
      text: "Un",
    });
    await hub.whenIdle(threadId);

    expect(store.getThread(threadId)).toMatchObject({
      model: "precis",
      settings: { [LEGACY_MODE]: "plan" },
    });
    const replies = store.listItems(threadId).filter((i) => i.kind === "agent");
    expect(replies.map((i) => ("text" in i ? i.text : "")).join()).toContain(
      "Mode plan (modèle precis",
    );
  });

  it("runs a thread in the mode and effort it was given, and follows its context use", async () => {
    const { hub, store, projectId } = setup();
    await hub.discover("demo", projectId);
    const settings = () => hub.snapshot().agents.find((a) => a.id === "demo")?.settings;
    expect(settings()).toMatchObject([
      { id: "mode", kind: "mode", current: "agent", choices: [{ id: "agent" }, { id: "plan" }] },
      { id: "effort", kind: "effort", current: "moyen" },
    ]);

    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      settings: { mode: "plan", effort: "haut" },
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const lastReply = () => {
      const reply = store.listItems(threadId).findLast((i) => i.kind === "agent");
      return reply && "text" in reply ? reply.text : "";
    };
    expect(lastReply()).toContain("Mode plan (modèle precis, effort haut)");
    expect(store.listItems(threadId).some((i) => i.kind === "tool")).toBe(false);
    expect(store.getThread(threadId)).toMatchObject({
      settings: { mode: "plan", effort: "haut" },
      usage: { used: 24_000, size: 200_000 },
      canCompact: true,
    });
    // The thread's choices are not the agent's defaults, and its model offers one more level.
    expect(settings()?.map((s) => s.current)).toEqual(["agent", "moyen"]);
    expect(settings()?.[1]?.choices.map((c) => c.id)).toEqual(["bas", "moyen", "haut", "max"]);

    await hub.setModel(threadId, "rapide");
    expect(settings()?.[1]?.choices).toHaveLength(3);
    await hub.setModel(threadId, "precis");
    await hub.setSetting(threadId, "mode", "agent");
    await expect(hub.setSetting(threadId, "mode", "yolo")).rejects.toThrow("Réglage inconnu");
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    expect(lastReply()).toContain("C'est fait");
    expect(store.getThread(threadId)?.usage?.used).toBe(48_000);

    hub.send(threadId, "/compact");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.usage?.used).toBe(3_000);
  });

  it("hands a thread to another agent between turns, with the conversation so far", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      settings: { mode: "agent" },
      text: "Un",
    });
    client.openThreadId = threadId;
    await asked;
    await expect(hub.switchAgent(threadId, "demo-2")).rejects.toThrow("fin de la réponse");
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);
    const firstSession = store.getSessionId(threadId);
    await expect(hub.switchAgent(threadId, "inconnu")).rejects.toThrow("Agent inconnu");

    await hub.switchAgent(threadId, "demo-2");
    expect(store.getThread(threadId)).toMatchObject({ agentId: "demo-2" });
    expect(store.getThread(threadId)).not.toHaveProperty("settings");
    expect(store.listItems(threadId).at(-1)).toMatchObject({
      kind: "handoff",
      from: "demo",
      to: "demo-2",
    });
    // Changing again before any message moves that one hand-off rather than adding more.
    await hub.switchAgent(threadId, "demo");
    expect(store.listItems(threadId).some((i) => i.kind === "handoff")).toBe(false);
    await hub.switchAgent(threadId, "demo-2");
    expect(store.listItems(threadId).filter((i) => i.kind === "handoff")).toHaveLength(1);
    hub.setPermissionMode(threadId, "full");
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);

    expect(store.getSessionId(threadId)).not.toBe(firstSession);
    expect(store.listItems(threadId).findLast((i) => i.kind === "agent")).toMatchObject({
      text: expect.stringContaining(
        "« Deux » (modèle precis). J'ai reçu l'historique, qui commence par « Un ».",
      ),
    });
    // Only the first prompt of the new session carries the history.
    hub.send(threadId, "Trois");
    await hub.whenIdle(threadId);
    expect(store.listItems(threadId).findLast((i) => i.kind === "agent")).toMatchObject({
      text: expect.not.stringContaining("historique"),
    });
  });

  it("keeps the most recent part of a long conversation for the next agent", () => {
    const items: Item[] = Array.from({ length: 60 }, (_, n) => ({
      id: `agent:${n}`,
      kind: "agent",
      text: `${n} ${"x".repeat(3_000)}`,
      at: n,
    }));
    const name = (id: string) => id;
    const history = historyBefore(
      [...items, { id: "user:now", kind: "user", text: "?", at: 60 }],
      "user:now",
      name,
    )!;
    expect(history).toContain("(Le début de la conversation est coupé.)");
    expect(history).toContain("Agent : 59 ");
    expect(history).not.toContain("Agent : 0 ");
    expect(history.length).toBeLessThan(45_000);
    expect(historyBefore(items.slice(0, 1), "agent:0", name)).toBeUndefined();
  });

  it("stops an agent still starting up when the server stops", async () => {
    demoModels("hang");
    const { hub, projectId } = setup();
    const discovery = hub.discover("demo", projectId);
    await hub.close();
    await discovery;
    expect(hub.snapshot().agents.find((a) => a.id === "demo")).not.toHaveProperty("models");
  });

  it("stars and unstars favorite models one at a time, for known agents only", async () => {
    const { hub, client } = setup();
    hub.toggleFavorite("demo", "precis", true);
    hub.toggleFavorite("demo", "rapide", true);
    hub.toggleFavorite("demo", "precis", false);

    expect(hub.snapshot().favorites).toEqual({ demo: ["rapide"] });
    expect(client.messages.at(-1)).toEqual({ type: "favorites", favorites: { demo: ["rapide"] } });
    expect(() => hub.toggleFavorite("__proto__", "x", true)).toThrow("Agent inconnu");
  });

  it("hands enabled MCP servers to agents, and never shows their secrets to clients", async () => {
    const { hub, store, client, projectId } = setup();
    hub.addMcpServer({
      name: "fichiers",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "mcp fichiers"],
        env: [{ name: "TOKEN", value: "s3cret" }],
      },
    });
    // The demo agent cannot reach HTTP servers, so it must not be given one.
    hub.addMcpServer({
      name: "web",
      transport: {
        type: "http",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Bearer s3cret" }],
      },
    });
    const off = hub.addMcpServer({
      name: "coupé",
      transport: { type: "stdio", command: "off", args: [], env: [] },
    });
    await hub.handle(client, { type: "mcp.setEnabled", id: off, enabled: false });
    expect(() =>
      hub.addMcpServer({
        name: "Web",
        transport: { type: "stdio", command: "x", args: [], env: [] },
      }),
    ).toThrow("déjà");

    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);

    const reply = store.listItems(threadId).find((i) => i.kind === "agent");
    expect(reply && "text" in reply ? reply.text : "").toContain("Serveurs MCP reçus : fichiers.");
    expect(hub.snapshot().mcpServers).toMatchObject([
      { name: "fichiers", enabled: true, target: 'npx -y "mcp fichiers"', secretNames: ["TOKEN"] },
      { name: "web", transport: "http", secretNames: ["Authorization"] },
      { name: "coupé", enabled: false },
    ]);
    expect(JSON.stringify([hub.snapshot(), client.messages])).not.toContain("s3cret");

    await hub.handle(client, { type: "mcp.remove", id: off });
    expect(hub.snapshot().mcpServers.map((m) => m.name)).toEqual(["fichiers", "web"]);
    const sent = client.messages.length;
    await hub.handle(client, { type: "mcp.remove", id: off });
    await hub.handle(client, { type: "mcp.setEnabled", id: "inconnu", enabled: false });
    expect(client.messages.length).toBe(sent);
  });

  it("rejects a project folder that does not exist", () => {
    const { hub, dir } = setup();
    expect(() => hub.createProject("x", path.join(dir, "missing"))).toThrow("n'existe pas");
  });
});

describe("modelOption", () => {
  it("flattens grouped choices and falls back to an option named model", () => {
    expect(
      modelOption([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "b",
          options: [
            { group: "g1", name: "G1", options: [{ value: "a", name: "A" }] },
            { group: "g2", name: "G2", options: [{ value: "b", name: "B", description: "Bee" }] },
          ],
        },
      ]),
    ).toEqual({
      configId: "model",
      current: "b",
      choices: [
        { id: "a", name: "A" },
        { id: "b", name: "B", description: "Bee" },
      ],
    });
  });
});

describe("Store.recoverAfterRestart", () => {
  it("settles turns and permission requests left open by a stopped server", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(path.join(dir, "state.sqlite"));
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    store.addThread({
      id: "t",
      projectId: "p",
      title: "t",
      agentId: "demo",
      status: "waiting",
      permissionMode: "supervised",
      createdAt: 1,
      updatedAt: 1,
    });
    store.putItem("t", {
      id: "perm",
      kind: "permission",
      title: "Edit",
      options: [],
      outcome: null,
      at: 1,
    });
    store.recoverAfterRestart();

    expect(store.getThread("t")?.status).toBe("idle");
    expect(store.getItem("t", "perm")).toMatchObject({ outcome: "cancelled" });
    store.close();
  });
});
