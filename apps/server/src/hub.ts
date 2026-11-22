import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentInfo,
  ClientMessage,
  Favorites,
  Item,
  PermissionMode,
  ServerMessage,
  Snapshot,
  Thread,
  ToolContent,
} from "@moonagentic/protocol";
import type { Agents } from "./agents.ts";
import { AgentSession, describe, type ModelOption } from "./session.ts";
import type { Store } from "./store.ts";

export interface Client {
  send(message: ServerMessage): void;
  /** The thread whose timeline this client is showing. */
  openThreadId?: string;
}

type ToolItem = Extract<Item, { kind: "tool" }>;

const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Nouvelle discussion";
};

const toolContent = (content: acp.ToolCallContent[] | null | undefined): ToolContent[] =>
  (content ?? []).flatMap((c): ToolContent[] => {
    if (c.type === "diff")
      return [{ type: "diff", path: c.path, oldText: c.oldText ?? null, newText: c.newText }];
    if (c.type === "content" && c.content.type === "text")
      return [{ type: "text", text: c.content.text }];
    return [];
  });

/** Owns threads and their agent sessions, and keeps every connected client in sync. */
export class Hub {
  private readonly store: Store;
  private readonly agents: Agents;
  private readonly clients = new Set<Client>();
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly turns = new Map<string, Promise<void>>();
  private readonly discoveries = new Map<string, Promise<void>>();
  /** Identifies the running turn, so a turn's plan and text stay separate from the next. */
  private readonly turnIds = new Map<string, string>();
  private readonly pendingPermissions = new Map<
    string,
    { threadId: string; resolve: (r: acp.RequestPermissionResponse) => void }
  >();

  constructor(store: Store, agents: Agents) {
    this.store = store;
    this.agents = agents;
    store.recoverAfterRestart();
  }

  connect(client: Client): () => void {
    this.clients.add(client);
    client.send({ type: "snapshot", snapshot: this.snapshot() });
    return () => this.clients.delete(client);
  }

  snapshot(): Snapshot {
    return {
      favorites: this.store.getSetting<Favorites>("favorites", {}),
      agents: this.agentList(),
      projects: this.store.listProjects(),
      threads: this.store.listThreads(),
    };
  }

  async handle(client: Client, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "project.create": {
        const id = this.createProject(message.name, message.path);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "thread.create": {
        const id = this.createThread(message);
        client.openThreadId = id;
        client.send({ type: "created", requestId: message.requestId, id });
        client.send({ type: "items", threadId: id, items: this.store.listItems(id) });
        return;
      }
      case "thread.open":
        client.openThreadId = message.threadId;
        client.send({
          type: "items",
          threadId: message.threadId,
          items: this.store.listItems(message.threadId),
        });
        return;
      case "thread.send":
        this.send(message.threadId, message.text);
        return;
      case "thread.cancel":
        await this.cancel(message.threadId);
        return;
      case "thread.setPermissionMode":
        this.setPermissionMode(message.threadId, message.permissionMode);
        return;
      case "thread.setModel":
        await this.setModel(message.threadId, message.model);
        return;
      case "favorites.set": {
        const favorites = this.store.getSetting<Favorites>("favorites", {});
        favorites[message.agentId] = [...new Set(message.models)];
        this.store.setSetting("favorites", favorites);
        this.broadcast({ type: "favorites", favorites });
        return;
      }
      case "agent.discover":
        await this.discover(message.agentId, message.projectId);
        return;
      case "permission.respond":
        this.respondToPermission(message.threadId, message.itemId, message.optionId);
        return;
    }
  }

  createProject(name: string, rawPath: string): string {
    const resolved = path.resolve(rawPath.replace(/^~(?=$|[\\/])/, os.homedir()));
    let isDirectory = false;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch {
      // reported below
    }
    if (!isDirectory) throw new Error(`Ce dossier n'existe pas sur cette machine : ${resolved}`);
    const project = { id: randomUUID(), name, path: resolved, createdAt: Date.now() };
    this.store.addProject(project);
    this.broadcast({ type: "project", project });
    return project.id;
  }

  createThread(input: {
    projectId: string;
    agentId: string;
    permissionMode: PermissionMode;
    model?: string | undefined;
    text: string;
  }): string {
    if (!this.store.getProject(input.projectId)) throw new Error("Projet introuvable.");
    this.agents.launch(input.agentId);
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      projectId: input.projectId,
      title: titleFrom(input.text),
      agentId: input.agentId,
      status: "idle",
      permissionMode: input.permissionMode,
      ...(input.model ? { model: input.model } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.addThread(thread);
    this.broadcast({ type: "thread", thread });
    this.send(thread.id, input.text);
    return thread.id;
  }

  send(threadId: string, text: string): void {
    const thread = this.requireThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    this.putItem(threadId, { id: `user:${randomUUID()}`, kind: "user", text, at: Date.now() });
    this.updateThread(threadId, { status: "running", error: null });
    this.turnIds.set(threadId, randomUUID());
    const turn = this.runTurn(thread, text).finally(() => {
      this.turns.delete(threadId);
      this.turnIds.delete(threadId);
    });
    this.turns.set(threadId, turn);
  }

  /** Resolves once the thread has no turn running. */
  async whenIdle(threadId: string): Promise<void> {
    await this.turns.get(threadId);
  }

  async cancel(threadId: string): Promise<void> {
    this.settlePermissions(threadId);
    const session = await this.sessions.get(threadId)?.catch(() => undefined);
    await session?.cancel();
  }

  /** Switches the thread's model now if its agent is running, otherwise when it next starts. */
  async setModel(threadId: string, model: string): Promise<void> {
    this.requireThread(threadId);
    const session = await this.sessions.get(threadId)?.catch(() => undefined);
    if (session?.model) {
      if (!session.model.choices.some((c) => c.id === model)) throw new Error("Modèle inconnu.");
      await session.setConfig(session.model.configId, model);
    }
    this.updateThread(threadId, { model });
  }

  /** Starts the agent briefly so the UI can list its models before the first message. */
  discover(agentId: string, projectId: string): Promise<void> {
    const running = this.discoveries.get(agentId);
    if (running) return running;
    const project = this.store.getProject(projectId);
    if (!project) return Promise.reject(new Error("Projet introuvable."));
    const discovery = AgentSession.start({
      launch: this.agents.launch(agentId),
      cwd: project.path,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    })
      .then((session) => {
        this.learnModels(agentId, session);
        session.close();
      })
      .finally(() => this.discoveries.delete(agentId));
    this.discoveries.set(agentId, discovery);
    return discovery;
  }

  setPermissionMode(threadId: string, permissionMode: PermissionMode): void {
    this.requireThread(threadId);
    this.updateThread(threadId, { permissionMode });
  }

  respondToPermission(threadId: string, itemId: string, optionId: string): void {
    const pending = this.pendingPermissions.get(itemId);
    const item = this.store.getItem(threadId, itemId);
    if (!pending || pending.threadId !== threadId || item?.kind !== "permission") {
      throw new Error("Cette demande n'attend plus de réponse.");
    }
    if (!item.options.some((o) => o.optionId === optionId)) throw new Error("Choix inconnu.");
    this.pendingPermissions.delete(itemId);
    this.putItem(threadId, { ...item, outcome: optionId });
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.updateThread(threadId, { status: "running" });
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  /** Stops every agent and resolves once their turns have ended. */
  async close(): Promise<void> {
    for (const threadId of new Set([...this.pendingPermissions.values()].map((p) => p.threadId))) {
      this.settlePermissions(threadId);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((s) => s.then((session) => session.close()).catch(() => undefined)),
    );
    await Promise.all(this.turns.values());
  }

  private async runTurn(thread: Thread, text: string): Promise<void> {
    try {
      const session = await this.session(thread);
      const stopReason = await session.prompt(text);
      const error =
        stopReason === "refusal"
          ? "L'agent a refusé de continuer."
          : stopReason === "max_tokens"
            ? "L'agent a atteint sa limite de réponse."
            : null;
      this.updateThread(thread.id, error ? { status: "error", error } : { status: "idle" });
    } catch (error) {
      this.settlePermissions(thread.id);
      // An agent that crashed already left its own reason, which beats "connection closed".
      if (this.store.getThread(thread.id)?.status !== "error") {
        this.updateThread(thread.id, { status: "error", error: describe(error) });
      }
    }
  }

  private session(thread: Thread): Promise<AgentSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const project = this.store.getProject(thread.projectId);
    if (!project) return Promise.reject(new Error("Projet introuvable."));
    const started = this.startSession(thread, project.path);
    this.sessions.set(thread.id, started);
    started.then(
      (s) => this.store.setSessionId(thread.id, s.sessionId),
      () => this.sessions.delete(thread.id),
    );
    return started;
  }

  private async startSession(thread: Thread, cwd: string): Promise<AgentSession> {
    const session = await AgentSession.start({
      launch: this.agents.launch(thread.agentId),
      cwd,
      previousSessionId: this.store.getSessionId(thread.id),
      handlers: {
        onUpdate: (update) => this.applyUpdate(thread.id, update),
        requestPermission: (request, signal) => this.requestPermission(thread.id, request, signal),
        onExit: (reason) => {
          this.sessions.delete(thread.id);
          this.settlePermissions(thread.id);
          if (reason && this.turns.has(thread.id)) {
            this.updateThread(thread.id, { status: "error", error: reason });
          }
        },
        onConfig: () => {
          const current = this.sessions.get(thread.id);
          void current?.then((s) => {
            const model = s.model?.current;
            if (model && model !== this.store.getThread(thread.id)?.model) {
              this.updateThread(thread.id, { model });
            }
          });
        },
      },
    });
    this.learnModels(thread.agentId, session);
    const model = session.model;
    if (model) {
      const wanted = this.store.getThread(thread.id)?.model ?? this.defaultModel(thread.agentId);
      if (wanted && wanted !== model.current && model.choices.some((c) => c.id === wanted)) {
        await session.setConfig(model.configId, wanted);
      }
      this.updateThread(thread.id, { model: session.model?.current ?? model.current });
    }
    return session;
  }

  private agentList(): AgentInfo[] {
    return this.agents.list().map((agent) => {
      const known = this.store.getAgentModels(agent.id);
      if (!known) return agent;
      const defaultModel = this.defaultModel(agent.id);
      return { ...agent, models: known.models, ...(defaultModel ? { defaultModel } : {}) };
    });
  }

  private defaultModel(agentId: string): string | undefined {
    const known = this.store.getAgentModels(agentId);
    if (!known) return undefined;
    const preferred = this.agents.preferredModel(agentId);
    const match =
      preferred && known.models.find((m) => preferred.test(m.name) || preferred.test(m.id));
    return match?.id ?? known.current;
  }

  /** Remembers the models an agent offers, so new threads can offer them before starting it. */
  private learnModels(agentId: string, session: AgentSession): void {
    const model: ModelOption | undefined = session.model;
    if (!model) return;
    const before = this.store.getAgentModels(agentId);
    const current = session.fresh || !before ? model.current : before.current;
    const next = { models: model.choices, current };
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.store.setAgentModels(agentId, next);
    this.broadcast({ type: "agents", agents: this.agentList() });
  }

  private applyUpdate(threadId: string, update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.appendText(
            threadId,
            update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought",
            update.content.text,
          );
        }
        return;
      case "tool_call":
      case "tool_call_update":
        this.upsertTool(threadId, update);
        return;
      case "plan":
        this.putItem(threadId, {
          id: `plan:${this.turnIds.get(threadId) ?? "late"}`,
          kind: "plan",
          entries: update.entries.map((e) => ({ content: e.content, status: e.status })),
          at: Date.now(),
        });
        return;
      default:
        return;
    }
  }

  private appendText(threadId: string, kind: "agent" | "thought", text: string): void {
    const last = this.store.lastItem(threadId);
    if (last && last.kind === kind) {
      this.store.putItem(threadId, { ...last, text: last.text + text });
      this.sendToViewers(threadId, { type: "append", threadId, itemId: last.id, text });
      return;
    }
    this.putItem(threadId, { id: `${kind}:${randomUUID()}`, kind, text, at: Date.now() });
  }

  private upsertTool(threadId: string, update: acp.ToolCall | acp.ToolCallUpdate): void {
    const id = `tool:${update.toolCallId}`;
    const existing = this.store.getItem(threadId, id) as ToolItem | undefined;
    const content = update.content ? toolContent(update.content) : undefined;
    this.putItem(threadId, {
      id,
      kind: "tool",
      title: update.title ?? existing?.title ?? "Outil",
      toolKind: update.kind ?? existing?.toolKind ?? "other",
      status: update.status ?? existing?.status ?? "pending",
      content: content ?? existing?.content ?? [],
      at: existing?.at ?? Date.now(),
    });
  }

  private requestPermission(
    threadId: string,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const thread = this.requireThread(threadId);
    if (request.toolCall.title) this.upsertTool(threadId, request.toolCall);
    if (thread.permissionMode === "full") {
      const allow =
        request.options.find((o) => o.kind === "allow_once") ??
        request.options.find((o) => o.kind === "allow_always");
      if (allow)
        return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    const id = `permission:${randomUUID()}`;
    this.putItem(threadId, {
      id,
      kind: "permission",
      title: request.toolCall.title ?? "L'agent demande une autorisation",
      options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      outcome: null,
      at: Date.now(),
    });
    this.updateThread(threadId, { status: "waiting" });
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, { threadId, resolve });
      signal.addEventListener("abort", () => this.settlePermission(id), { once: true });
    });
  }

  /** Answers every open permission request of the thread with "cancelled", as ACP requires on cancel. */
  private settlePermissions(threadId: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.threadId === threadId) this.settlePermission(id);
    }
  }

  private settlePermission(itemId: string): void {
    const pending = this.pendingPermissions.get(itemId);
    if (!pending) return;
    this.pendingPermissions.delete(itemId);
    const item = this.store.getItem(pending.threadId, itemId);
    if (item?.kind === "permission")
      this.putItem(pending.threadId, { ...item, outcome: "cancelled" });
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }

  private requireThread(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Fil introuvable.");
    return thread;
  }

  private putItem(threadId: string, item: Item): void {
    this.store.putItem(threadId, item);
    this.sendToViewers(threadId, { type: "item", threadId, item });
  }

  private updateThread(threadId: string, patch: Parameters<Store["updateThread"]>[1]): void {
    this.broadcast({ type: "thread", thread: this.store.updateThread(threadId, patch) });
  }

  private sendToViewers(threadId: string, message: ServerMessage): void {
    for (const client of this.clients) if (client.openThreadId === threadId) client.send(message);
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }
}
