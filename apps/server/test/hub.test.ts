import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item, ServerMessage, Thread } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { historyBefore } from "../src/history.ts";
import { type Client, Hub } from "../src/hub.ts";
import { LEGACY_MODE, modelOption } from "../src/session.ts";
import { Store } from "../src/store.ts";

class TestClient implements Client {
  openThreadIds?: Set<string>;
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

function setup(options: { idleMs?: number; maxLiveAgents?: number; forceStopMs?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-test-"));
  mkdirSync(path.join(dir, ".home"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const hub = new Hub(store, new Agents({ demo: true }), {
    worktreesDir: path.join(dir, ".worktrees"),
    homeDir: path.join(dir, ".home"),
    ...options,
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
function demoModels(style: "legacy" | "none" | "hang" | "fail" | "load" | "resume-fail" | "auth") {
  process.env.MOONAGENTIC_DEMO_MODELS = style;
  cleanups.push(() => {
    delete process.env.MOONAGENTIC_DEMO_MODELS;
  });
}

const isPermissionRequest = (m: ServerMessage) =>
  m.type === "item" && m.item.kind === "permission" && m.item.outcome === null;

const kinds = (items: Item[]) => items.map((i) => i.kind);

/** Everything the agent said in the thread's last turn. */
const lastTurnSaid = (items: Item[]) =>
  items
    .slice(items.findLastIndex((i) => i.kind === "user"))
    .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
    .join(" ");

describe("Hub with the demo agent", () => {
  it("keeps the question an agent asks with a tool, and ends the turn on it", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "/question",
    });
    await hub.whenIdle(threadId);

    expect(store.getThread(threadId)?.status).toBe("idle");
    const tool = store.listItems(threadId).find((i) => i.kind === "tool");
    expect(tool).toMatchObject({
      status: "pending",
      questions: [
        {
          question: "Quelle couleur préfères-tu ?",
          options: ["(Recommandé) Bleu", "Vert", "Rouge"],
        },
      ],
    });
  });

  it("lets a team's reviewer with full access run things, but asks before it changes a file", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    // The demo agent reads a file, then asks to edit one.
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Relis",
      role: "reviewer",
    });
    client.openThreadIds = new Set([threadId]);
    await asked;
    expect(store.getThread(threadId)?.status).toBe("waiting");
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);
  });

  it("streams a supervised turn, waits for permission, and persists the timeline", async () => {
    const { hub, store, client, projectId } = setup();
    const asked = client.next(isPermissionRequest);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Corrige la réponse",
    });
    client.openThreadIds = new Set([threadId]);

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
    expect(items.find((i) => i.id.endsWith(":edit-1"))).toMatchObject({ status: "completed" });
  });

  it("keeps each turn's tool calls, even when the agent numbers them the same way", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);

    const turns = store
      .listItems(threadId)
      .map((i) => i.kind)
      .join(" ")
      .split("user");
    expect(
      turns.filter((turn) => turn.split(" ").filter((k) => k === "tool").length === 2),
    ).toHaveLength(2);
  });

  it("stops a turn cancelled while its agent was still starting", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Stop",
    });
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    expect(store.getThread(threadId)?.error).toBeUndefined();
    expect(kinds(store.listItems(threadId))).toEqual(["user"]);

    // The thread still works afterwards.
    hub.send(threadId, "Encore");
    const client = new TestClient();
    client.openThreadIds = new Set([threadId]);
    hub.connect(client);
    await client.next(isPermissionRequest);
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.status).toBe("idle");
  });

  it("kills an agent that does not stop after « Arrêter », and keeps the thread usable", async () => {
    const { hub, store, projectId } = setup({ forceStopMs: 300 });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/fige",
    });
    await expect
      .poll(() => lastTurnSaid(store.listItems(threadId)), { timeout: 10_000 })
      .toContain("Je réfléchis");
    const asked = Date.now();
    await hub.cancel(threadId);
    await hub.whenIdle(threadId);

    expect(Date.now() - asked).toBeGreaterThanOrEqual(250);
    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    expect(store.getThread(threadId)?.error).toBeUndefined();
    expect(hub.liveAgents).toBe(0);

    // The next message starts the agent again.
    hub.send(threadId, "/compact");
    await hub.whenIdle(threadId);
    expect(lastTurnSaid(store.listItems(threadId))).toContain("Contexte compacté.");
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
    client.openThreadIds = new Set([threadId]);
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
    client.openThreadIds = new Set([threadId]);
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

    expect(lastTurnSaid(store.listItems(threadId))).toContain("(modèle precis)");
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
    client.openThreadIds = new Set([threadId]);
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
    client.openThreadIds = new Set([threadId]);
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
    expect(lastTurnSaid(store.listItems(threadId))).toContain(
      "« Deux » (modèle precis). J'ai reçu l'historique, qui commence par « Un ».",
    );
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

  it("stops a turn whose agent is still starting up when the server stops", async () => {
    demoModels("hang");
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Bonjour",
    });
    // Well under the two minutes a start may take, and the test's own time limit.
    await hub.close();
    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    expect(store.getThread(threadId)?.error).toBeUndefined();
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

  it("never adds the same folder twice, nor clones a repository a project already has", async () => {
    const { hub, dir, client } = setup();
    const first = hub.createProject("a", dir);
    expect(hub.createProject("b", path.join(dir, "."))).toBe(first);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/Moon/App.git"], {
      cwd: dir,
    });
    await hub.handle(client, {
      type: "project.clone",
      requestId: "r1",
      repo: "moon/app",
      parent: path.join(dir, "elsewhere"),
    });
    expect(client.messages.at(-1)).toEqual({ type: "created", requestId: "r1", id: first });
    expect(existsSync(path.join(dir, "elsewhere"))).toBe(false);
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

describe("Hub: one cap on turns for the whole server", () => {
  const said = (store: Store, id: string) => lastTurnSaid(store.listItems(id));

  it("keeps what the server starts in line past the cap, and lets the user's own messages through", async () => {
    const { hub, store, client, projectId } = setup({ forceStopMs: 200 });
    await hub.handle(client, { type: "server.setMaxTurns", maxTurns: 1 });
    expect(hub.coordinatorSettings().maxTurns).toBe(1);
    const create = (text: string, auto?: boolean) =>
      hub.createThread({ projectId, agentId: "demo", permissionMode: "full", text, auto });

    // The only place is taken by a turn that never ends.
    const frozen = create("/fige");
    await expect.poll(() => said(store, frozen), { timeout: 10_000 }).toContain("Je réfléchis");

    // A planned task waits, in plain sight, and its agent is not started.
    const first = create("/compact", true);
    const second = create("/compact", true);
    expect(store.getThread(first)).toMatchObject({ status: "running", inLine: true });
    expect(store.getThread(second)).toMatchObject({ status: "running", inLine: true });
    expect(hub.liveAgents).toBe(1);

    // What the user sends goes at once.
    const mine = create("/compact");
    await hub.whenIdle(mine);
    expect(said(store, mine)).toContain("Contexte compacté.");
    expect(store.getThread(first)?.inLine).toBe(true);

    // Stopped while in line: it leaves it without ever starting.
    await hub.cancel(second);
    await hub.whenIdle(second);
    expect(store.getThread(second)).toMatchObject({ status: "idle" });
    expect(store.getThread(second)?.inLine).toBeUndefined();
    expect(said(store, second)).toBe("");

    // The place frees: the first in line starts by itself.
    await hub.cancel(frozen);
    await hub.whenIdle(frozen);
    await hub.whenIdle(first);
    expect(store.getThread(first)?.inLine).toBeUndefined();
    expect(said(store, first)).toContain("Contexte compacté.");
  });

  it("starts the turns in line when the cap is raised, and does not count a turn waiting for the user", async () => {
    const { hub, store, client, projectId } = setup();
    await hub.handle(client, { type: "server.setMaxTurns", maxTurns: 1 });
    const frozen = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/fige",
    });
    await expect
      .poll(() => lastTurnSaid(store.listItems(frozen)), { timeout: 10_000 })
      .toContain("Je réfléchis");
    const waits = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Modifie",
      auto: true,
    });
    const then = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "/compact",
      auto: true,
    });
    expect(store.getThread(waits)?.inLine).toBe(true);

    await hub.handle(client, { type: "server.setMaxTurns", maxTurns: 2 });
    // The first in line starts and asks the user: that takes no place, so the next goes too.
    await expect.poll(() => store.getThread(waits)?.status, { timeout: 10_000 }).toBe("waiting");
    await hub.whenIdle(then);
    expect(lastTurnSaid(store.listItems(then))).toContain("Contexte compacté.");
    await hub.cancel(waits);
    await hub.cancel(frozen);
  });
});

describe("Hub after a restart", () => {
  it("starts the threads left in a coordinator's line", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-test-"));
    mkdirSync(path.join(dir, ".home"));
    const store = new Store(path.join(dir, "state.sqlite"));
    store.addProject({ id: "p", name: "p", path: dir, createdAt: 1 });
    const thread = (id: string, extra: Partial<Thread>): Thread => ({
      id,
      projectId: "p",
      title: id,
      agentId: "demo",
      status: "idle",
      permissionMode: "full",
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    });
    store.addThread(thread("coord", { kind: "coordinator" }));
    store.addThread(thread("waits", { openedBy: "coord", held: "/compact" }));
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    await expect.poll(() => store.getThread("waits")?.held, { timeout: 10_000 }).toBeUndefined();
    await hub.whenIdle("waits");
    const items = store.listItems("waits");
    expect(items.find((i) => i.kind === "user")).toMatchObject({
      text: "/compact",
      from: "coordinator",
    });
    expect(lastTurnSaid(items)).not.toBe("");
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
    store.addThread({
      id: "quiet",
      projectId: "p",
      title: "quiet",
      agentId: "demo",
      status: "running",
      permissionMode: "supervised",
      quietSince: 5,
      pinned: true,
      createdAt: 1,
      updatedAt: 1,
    });
    store.addThread({
      id: "in-line",
      projectId: "p",
      title: "in line",
      agentId: "demo",
      status: "running",
      permissionMode: "supervised",
      inLine: true,
      createdAt: 1,
      updatedAt: 1,
    });
    store.addThread({
      id: "only-quiet",
      projectId: "p",
      title: "only quiet",
      agentId: "demo",
      status: "running",
      permissionMode: "supervised",
      quietSince: 5,
      createdAt: 1,
      updatedAt: 1,
    });
    store.recoverAfterRestart();

    expect(store.getThread("t")?.status).toBe("idle");
    expect(store.getItem("t", "perm")).toMatchObject({ outcome: "cancelled" });
    // A turn cut short is not quiet any more, and keeps the rest of its state.
    expect(store.getThread("quiet")).toMatchObject({ status: "idle", pinned: true });
    expect(store.getThread("quiet")?.quietSince).toBeUndefined();
    expect(store.getThread("only-quiet")?.quietSince).toBeUndefined();
    expect(store.getThread("in-line")?.inLine).toBeUndefined();
    store.close();
  });
});

/** Writes files under `dir`, making their folders. */
function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

describe("Composer: files, skills, commands, pins and search", () => {
  it("sends the files a message mentions and the skills it calls along with it", async () => {
    const { dir, hub, store, projectId } = setup();
    write(dir, {
      "src/app.ts": "export const answer = 41;\n",
      ".claude/skills/revue/SKILL.md": "---\nname: revue\ndescription: Relit\n---\nRelis.\n",
    });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Lis @src/app.ts avec $revue, et @../hors.txt",
    });
    await hub.whenIdle(threadId);
    expect(lastTurnSaid(store.listItems(threadId))).toContain(
      "Pièces jointes : app.ts (texte), SKILL.md (texte).",
    );
  });

  it("only links them for an agent that takes no embedded content", async () => {
    process.env.MOONAGENTIC_DEMO_EMBED = "0";
    cleanups.push(() => {
      delete process.env.MOONAGENTIC_DEMO_EMBED;
    });
    const { dir, hub, store, projectId } = setup();
    write(dir, { "src/app.ts": "x" });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Lis @src/app.ts",
    });
    await hub.whenIdle(threadId);
    expect(lastTurnSaid(store.listItems(threadId))).toContain(
      "Pièces jointes : src/app.ts (lien).",
    );
  });

  it("keeps the agent's commands with the thread and with the agent", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)).toMatchObject({
      canCompact: true,
      commands: [
        { name: "compact" },
        { name: "init" },
        { name: "explique", hint: "fichier à expliquer" },
      ],
    });
    const demo = hub.snapshot().agents.find((a) => a.id === "demo");
    expect(demo?.commands?.map((c) => c.name)).toEqual(["compact", "init", "explique"]);
    // A hand-off forgets them until the next agent lists its own.
    await hub.switchAgent(threadId, "demo-2");
    expect(store.getThread(threadId)?.commands).toBeUndefined();
  });

  it("learns an agent's commands while listing its models", async () => {
    const { hub, projectId } = setup();
    await hub.discover("demo-2", projectId);
    const agent = hub.snapshot().agents.find((a) => a.id === "demo-2");
    expect(agent?.commands?.length).toBe(3);
  });

  it("searches project files, lists skills and commands, and finds messages", async () => {
    const { dir, hub, store, client, projectId } = setup();
    write(dir, {
      "src/app.ts": "",
      "src/other.ts": "",
      ".agents/skills/tests/SKILL.md": "# Écrit des tests\n",
      ".moonagentic/commands/deploy.md": "Déploie $ARGUMENTS",
    });
    await hub.handle(client, {
      type: "files.search",
      requestId: "f1",
      projectId,
      query: "app",
    });
    expect(client.messages.at(-1)).toEqual({
      type: "files",
      requestId: "f1",
      files: ["src/app.ts"],
    });

    await hub.handle(client, { type: "composer.catalog", requestId: "c1", projectId });
    expect(client.messages.at(-1)).toMatchObject({
      type: "catalog",
      skills: [{ name: "tests", description: "Écrit des tests", scope: "project" }],
      commands: [{ name: "deploy", template: "Déploie $ARGUMENTS" }],
    });
    const catalog = client.messages.at(-1);
    // The server's own paths stay on the server.
    expect(JSON.stringify(catalog)).not.toContain(dir);

    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Où est la fonction 100% fiable ?",
    });
    await hub.whenIdle(threadId);
    await hub.handle(client, { type: "search", requestId: "s1", query: "100%" });
    // The demo agent repeats the question, so its answer matches too, newest first.
    expect(client.messages.at(-1)).toMatchObject({
      type: "searched",
      hits: [
        { threadId, kind: "agent" },
        { threadId, kind: "user", snippet: "Où est la fonction 100% fiable ?" },
      ],
    });
    // `%` and `_` are searched as themselves.
    await hub.handle(client, { type: "search", requestId: "s2", query: "1_0" });
    expect(client.messages.at(-1)).toMatchObject({ type: "searched", hits: [] });
    // Neither case nor accents get in the way, in French as in English.
    await hub.handle(client, { type: "search", requestId: "s3", query: "OU EST" });
    expect(client.messages.at(-1)).toMatchObject({
      type: "searched",
      hits: [{ kind: "agent" }, { kind: "user", snippet: "Où est la fonction 100% fiable ?" }],
    });
    // A team's own message to its agent is not the user's: the search leaves it out.
    const briefed = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Consigne interne zorglub",
      byTeam: true,
    });
    await hub.whenIdle(briefed);
    expect(store.listItems(briefed)[0]).toMatchObject({ kind: "user", byTeam: true });
    await hub.handle(client, { type: "search", requestId: "s4", query: "zorglub" });
    expect(client.messages.at(-1)).toMatchObject({
      type: "searched",
      hits: [{ threadId: briefed, kind: "agent" }],
    });
  });

  it("pins a thread for every device", async () => {
    const { hub, store, client, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const before = store.getThread(threadId)!.updatedAt;
    await hub.handle(client, { type: "thread.setPinned", threadId, pinned: true });
    expect(store.getThread(threadId)).toMatchObject({ pinned: true, updatedAt: before });
    expect(client.messages.at(-1)).toMatchObject({ type: "thread", thread: { pinned: true } });
    await hub.handle(client, { type: "thread.setPinned", threadId, pinned: false });
    expect(store.getThread(threadId)?.pinned).toBeUndefined();
  });

  it("holds a message sent while the model is being switched", async () => {
    const { hub, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const switching = hub.setModel(threadId, "rapide");
    expect(() => hub.send(threadId, "Deux")).toThrow("changement de modèle");
    await switching;
    const setting = hub.setSetting(threadId, "mode", "plan");
    expect(() => hub.send(threadId, "Deux")).toThrow("changement de réglage");
    await setting;
  });

  it("reloads a session the agent failed to resume", async () => {
    demoModels("resume-fail");
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    const sessionId = store.getSessionId(threadId);
    await hub.close();

    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(os.tmpdir(), "unused-worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    restarted.send(threadId, "Deux");
    await restarted.whenIdle(threadId);
    expect(store.getSessionId(threadId)).toBe(sessionId);
    // The reload replayed where the context stood, so the session went on.
    expect(store.getThread(threadId)?.usage?.used).toBe(99_000 + 24_000);
  });
});

describe("Connexions: agents' state, custom agents and pending requests", () => {
  it("records what a check finds: the agent's version, then a needed sign-in", async () => {
    const { hub, client } = setup();
    // Checked from Connexions, before any project is open.
    await hub.handle(client, { type: "agent.discover", agentId: "demo" });
    const demo = () => hub.snapshot().agents.find((a) => a.id === "demo");
    expect(demo()?.check).toMatchObject({ ok: true, version: "moonagentic-demo 0.1.0" });
    expect(demo()?.command).toBe("agent de démo intégré à MoonAgentic");
    const first = demo()?.check?.at ?? 0;

    demoModels("auth");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await hub.handle(client, { type: "agent.discover", agentId: "demo" });
    expect(demo()?.check).toMatchObject({ ok: false, signInNeeded: true });
    expect(demo()?.check?.at).toBeGreaterThan(first);
  });

  it("adds and removes an agent of the user's own", async () => {
    const { hub, client } = setup();
    const created = client.next((m) => m.type === "created");
    await hub.handle(client, {
      type: "agent.addCustom",
      requestId: "r1",
      agent: { name: "Mon agent", command: process.execPath, args: ["agent.js"] },
    });
    const reply = await created;
    if (reply.type !== "created") throw new Error("unreachable");
    const added = hub.snapshot().agents.find((a) => a.id === reply.id);
    expect(added).toMatchObject({
      name: "Mon agent",
      short: "Ma",
      custom: true,
      available: true,
      command: `${process.execPath} agent.js`,
    });
    expect(() => hub.addCustomAgent({ name: "mon AGENT", command: "x", args: [] })).toThrow(
      "s'appelle déjà",
    );
    expect(() => hub.removeCustomAgent("demo")).toThrow("pas été ajouté");

    // A command this machine does not have leaves the agent listed, with why it cannot start.
    const missing = hub.addCustomAgent({
      name: "Absent",
      command: "pas-une-commande-xyz",
      args: [],
    });
    expect(hub.snapshot().agents.find((a) => a.id === missing)).toMatchObject({
      available: false,
      hint: expect.stringContaining("pas-une-commande-xyz"),
    });

    await hub.handle(client, { type: "agent.removeCustom", agentId: reply.id });
    expect(hub.snapshot().agents.some((a) => a.id === reply.id)).toBe(false);
  });

  it("keeps the user's agents across a restart", async () => {
    const { hub, store } = setup();
    const id = hub.addCustomAgent({ name: "Gardé", command: process.execPath, args: [] });
    await hub.close();
    const restarted = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(os.tmpdir(), "unused-worktrees"),
    });
    cleanups.unshift(() => restarted.close());
    expect(restarted.snapshot().agents.find((a) => a.id === id)?.name).toBe("Gardé");
  });

  it("lists every request waiting for the user, and drops it once answered", async () => {
    const { hub, client, projectId } = setup();
    const listed = client.next((m) => m.type === "requests" && m.requests.length > 0);
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "supervised",
      text: "Corrige la réponse",
    });
    const message = await listed;
    if (message.type !== "requests") throw new Error("unreachable");
    const [request] = message.requests;
    expect(request).toMatchObject({ threadId, options: expect.any(Array) });
    expect(hub.snapshot().requests).toHaveLength(1);

    const emptied = client.next((m) => m.type === "requests" && m.requests.length === 0);
    await hub.handle(client, {
      type: "permission.respond",
      threadId,
      itemId: request!.itemId,
      optionId: "allow",
    });
    await emptied;
    await hub.whenIdle(threadId);
    expect(hub.snapshot().requests).toEqual([]);
  });

  it("keeps what the session has cost, when the agent says", async () => {
    const { hub, store, projectId } = setup();
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.usage).toEqual({
      used: 24_000,
      size: 200_000,
      cost: { amount: 0.24, currency: "USD" },
    });
    // An update that gives only the tokens keeps the cost known.
    hub.send(threadId, "/compact");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)?.usage).toEqual({
      used: 3_000,
      size: 200_000,
      cost: { amount: 0.24, currency: "USD" },
    });
  });

  it("records a check for an agent gone from this machine instead of failing", async () => {
    const { hub, client } = setup();
    const id = hub.addCustomAgent({ name: "Fragile", command: process.execPath, args: [] });
    // Its command disappears after the list was sent: checking it still ends.
    const agents = (hub as unknown as { agents: Agents }).agents;
    agents.setCustom([{ id, name: "Fragile", command: "plus-la-xyz", args: [] }]);
    await hub.handle(client, { type: "agent.discover", agentId: id });
    expect(hub.snapshot().agents.find((a) => a.id === id)?.check).toMatchObject({
      ok: false,
      error: expect.stringContaining("plus-la-xyz"),
    });
  });

  it("hands a thread over from an agent that is no longer there", async () => {
    const { hub, store, projectId } = setup();
    const id = hub.addCustomAgent({ name: "Parti", command: process.execPath, args: [] });
    const threadId = "ancien-fil";
    store.addThread({
      id: threadId,
      projectId,
      agentId: id,
      title: "Ancien fil",
      status: "idle",
      permissionMode: "full",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    hub.removeCustomAgent(id);
    await hub.switchAgent(threadId, "demo");
    hub.send(threadId, "Reprends");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)).toMatchObject({ agentId: "demo", status: "idle" });
  });
});

describe("agents left alone", () => {
  it("stops an idle agent, keeps its session, and picks the thread up on the next message", async () => {
    const { hub, store, projectId } = setup({ idleMs: 30 });
    const threadId = hub.createThread({
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Un",
    });
    await hub.whenIdle(threadId);
    await expect.poll(() => hub.liveAgents).toBe(0);
    // The session stays known, so the agent can resume it.
    expect(store.getSessionId(threadId)).not.toBeNull();

    // Sent while the agent may still be stopping: it waits rather than being refused.
    hub.send(threadId, "Deux");
    await hub.whenIdle(threadId);
    expect(store.getThread(threadId)).toMatchObject({ status: "idle" });
    expect(lastTurnSaid(store.listItems(threadId))).not.toBe("");
  });

  it("keeps no more agents running than allowed, stopping the one left alone longest", async () => {
    const { hub, store, projectId } = setup({ maxLiveAgents: 2 });
    const start = async (text: string) => {
      const id = hub.createThread({ projectId, agentId: "demo", permissionMode: "full", text });
      await hub.whenIdle(id);
      return id;
    };
    const first = await start("Un");
    const second = await start("Deux");
    expect(hub.liveAgents).toBe(2);
    const third = await start("Trois");
    // The one paused counts until its process is gone.
    await expect.poll(() => hub.liveAgents).toBe(2);

    // The first, left alone longest, was the one stopped: it comes back on its next message.
    hub.send(first, "Encore");
    await hub.whenIdle(first);
    expect(store.getThread(first)).toMatchObject({ status: "idle" });
    await expect.poll(() => hub.liveAgents).toBe(2);
    for (const id of [second, third]) expect(store.getThread(id)?.status).toBe("idle");
  });
});

describe("streamed text", () => {
  it("sends each piece at once but writes the text down in batches", async () => {
    const { hub, store, client, projectId } = setup();
    let writes = 0;
    const putItem = store.putItem.bind(store);
    store.putItem = (threadId, item) => {
      if (item.kind === "agent") writes += 1;
      putItem(threadId, item);
    };
    await hub.handle(client, {
      type: "thread.create",
      requestId: "r1",
      projectId,
      agentId: "demo",
      permissionMode: "full",
      text: "Corrige la réponse",
    });
    const threadId = [...client.openThreadIds!][0]!;
    await hub.whenIdle(threadId);
    const appends = client.messages.filter((m) => m.type === "append").length;
    expect(appends).toBeGreaterThan(10);
    expect(writes).toBeLessThan(appends / 2);
    // Nothing is lost: what was written is what viewers saw.
    const said = store
      .listItems(threadId)
      .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
      .join("");
    expect(said).toContain("42");
  });
});

describe("teams outside git", () => {
  it("refuses a team in a folder that is not a git repository", () => {
    const { hub, projectId } = setup();
    expect(() =>
      hub.startTeam({
        projectId,
        task: "Corrige",
        lead: { agentId: "demo" },
        coder: { agentId: "demo" },
        coders: 2,
        permissionMode: "full",
      }),
    ).toThrow("dépôt git");
  });
});

describe("quotas on Hub", () => {
  it("starts reading when a client connects and replies done to quotas.refresh", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-test-"));
    mkdirSync(path.join(dir, ".home"));
    const store = new Store(path.join(dir, "state.sqlite"));
    let reads = 0;
    const hub = new Hub(store, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
      quotaReaders: {
        demo: async () => {
          reads++;
          return {
            state: "ok",
            windows: [{ label: "Session de 5 h", short: "5 h", usedPercent: 12 }],
            extras: [],
          };
        },
      },
    });
    cleanups.push(async () => {
      await hub.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // No client connected yet: no background poll ran at startup.
    expect(reads).toBe(0);

    const client = new TestClient();
    const updated = client.next((m) => m.type === "quotas");
    hub.connect(client);
    const snap = client.messages.find((m) => m.type === "snapshot");
    expect(snap?.type === "snapshot" && snap.snapshot.quotas[0]?.state).toBe("loading");
    await updated;
    expect(reads).toBe(1);

    // Asking within ASKED_GAP_MS still replies `done` immediately so the button stops spinning.
    await hub.handle(client, { type: "quotas.refresh", requestId: "q1", agentId: "demo" });
    expect(client.messages).toContainEqual({ type: "done", requestId: "q1" });
    expect(reads).toBe(1);
  });
});
