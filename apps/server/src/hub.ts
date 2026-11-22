import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentInfo,
  AgentSetting,
  ClientMessage,
  Favorites,
  Item,
  McpServerInput,
  PermissionMode,
  Project,
  ReviewFile,
  ServerMessage,
  Snapshot,
  Thread,
  ToolContent,
} from "@moonagentic/protocol";
import type { Agents } from "./agents.ts";
import {
  addWorktree,
  branchName,
  dropCheckpoints,
  isGitRepo,
  restoreCheckpoint,
  reviewChanges,
  saveCheckpoint,
  ship,
  type ShipResult,
} from "./git.ts";
import { historyBefore } from "./history.ts";
import { mcpInfo, type McpServerRecord } from "./mcp.ts";
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

const DISCOVERY_TIMEOUT_MS = 30_000;
/** How long an agent may take to open its session before the turn gives up. */
const START_TIMEOUT_MS = 120_000;

const settingValues = (settings: AgentSetting[]) =>
  settings.length ? Object.fromEntries(settings.map((s) => [s.id, s.current])) : undefined;

/** Keeps a message's checkpoint from git's garbage collection, out of sight of branches. */
const checkpointRef = (threadId: string, itemId: string) =>
  `refs/moonagentic/${threadId}/${itemId.replace(/^user:/, "")}`;

/** Owns threads and their agent sessions, and keeps every connected client in sync. */
export class Hub {
  private readonly store: Store;
  private readonly agents: Agents;
  private readonly clients = new Set<Client>();
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly turns = new Map<string, Promise<void>>();
  /** Threads whose running turn the user asked to stop. */
  private readonly cancelled = new Set<string>();
  /** Stops an agent that is still starting, by thread. */
  private readonly starting = new Map<string, AbortController>();
  /** Steps under way (a push, a step back, a hand-off), awaited before the server stops. */
  private readonly steps = new Set<Promise<unknown>>();
  private readonly discoveries = new Map<string, { done: Promise<void>; stop: AbortController }>();
  /** Why listing an agent's models failed, until a retry succeeds. */
  private readonly discoveryErrors = new Map<string, string>();
  /** Identifies the running turn, so a turn's plan and text stay separate from the next. */
  private readonly turnIds = new Map<string, string>();
  private readonly pendingPermissions = new Map<
    string,
    { threadId: string; resolve: (r: acp.RequestPermissionResponse) => void }
  >();

  /** Where threads with their own branch get their worktree. */
  private readonly worktreesDir: string;
  /**
   * Threads busy with their branch or their agent (a push, a step back, a hand-off), with
   * what to answer a message or another such step meanwhile.
   */
  private readonly busy = new Map<string, string>();
  /** Whether each project's folder is in a git repository, checked once. */
  private readonly gitProjects = new Map<string, boolean>();

  constructor(store: Store, agents: Agents, options: { worktreesDir: string }) {
    this.store = store;
    this.agents = agents;
    this.worktreesDir = options.worktreesDir;
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
      mcpServers: this.mcpServers().map(mcpInfo),
      agents: this.agentList(),
      projects: this.store.listProjects().map((p) => this.withGit(p)),
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
      case "thread.restore":
        await this.restore(message.threadId, message.itemId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.switchAgent":
        await this.switchAgent(message.threadId, message.agentId);
        return;
      case "thread.setPermissionMode":
        this.setPermissionMode(message.threadId, message.permissionMode);
        return;
      case "thread.setModel":
        await this.setModel(message.threadId, message.model);
        return;
      case "thread.setSetting":
        await this.setSetting(message.threadId, message.settingId, message.value);
        return;
      case "favorites.toggle":
        this.toggleFavorite(message.agentId, message.model, message.starred);
        return;
      case "mcp.add": {
        const id = this.addMcpServer(message.server);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "mcp.setEnabled":
        if (!this.mcpServers().some((s) => s.id === message.id)) return;
        this.updateMcpServers((servers) =>
          servers.map((s) => (s.id === message.id ? { ...s, enabled: message.enabled } : s)),
        );
        return;
      case "mcp.remove":
        if (!this.mcpServers().some((s) => s.id === message.id)) return;
        this.updateMcpServers((servers) => servers.filter((s) => s.id !== message.id));
        return;
      case "workspace.review":
        // The panel waits for this reply, so a failure is sent to it rather than thrown.
        client.send(
          await this.review(message.threadId).then(
            (files) => ({ type: "review", threadId: message.threadId, files }),
            (error: unknown) => ({
              type: "review",
              threadId: message.threadId,
              files: [],
              error: describe(error),
            }),
          ),
        );
        return;
      case "workspace.ship": {
        const result = await this.ship(message.threadId, message.message, message.pr);
        client.send({
          type: "shipped",
          requestId: message.requestId,
          threadId: message.threadId,
          ...result,
        });
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
    this.broadcast({ type: "project", project: this.withGit(project) });
    return project.id;
  }

  createThread(input: {
    projectId: string;
    agentId: string;
    permissionMode: PermissionMode;
    model?: string | undefined;
    settings?: Record<string, string> | undefined;
    isolated?: boolean | undefined;
    text: string;
  }): string {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error("Projet introuvable.");
    this.agents.launch(input.agentId);
    const now = Date.now();
    const id = randomUUID();
    const title = titleFrom(input.text);
    // The worktree itself is made when the agent first starts, so creating stays instant.
    const workspace =
      input.isolated && this.withGit(project).git
        ? // A short folder name keeps deep projects under Windows' path length limit.
          { branch: branchName(title, id), path: path.join(this.worktreesDir, id.slice(0, 8)) }
        : undefined;
    const thread: Thread = {
      id,
      projectId: input.projectId,
      title,
      agentId: input.agentId,
      status: "idle",
      permissionMode: input.permissionMode,
      ...(input.model ? { model: input.model } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
      ...(workspace ? { workspace } : {}),
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
    const busy = this.busy.get(threadId);
    if (busy) throw new Error(busy);
    const itemId = `user:${randomUUID()}`;
    this.putItem(threadId, { id: itemId, kind: "user", text, at: Date.now() });
    this.updateThread(threadId, { status: "running", error: null });
    this.turnIds.set(threadId, randomUUID());
    this.cancelled.delete(threadId);
    const turn = this.runTurn(thread, text, itemId).finally(() => {
      this.turns.delete(threadId);
      this.turnIds.delete(threadId);
      this.cancelled.delete(threadId);
    });
    this.turns.set(threadId, turn);
  }

  /** Resolves once the thread has no turn running. */
  async whenIdle(threadId: string): Promise<void> {
    await this.turns.get(threadId);
  }

  async cancel(threadId: string): Promise<void> {
    // An agent only cancels a prompt it already has: one that is still starting never sees
    // the request, so the turn remembers it and stops before sending its prompt.
    if (this.turns.has(threadId)) this.cancelled.add(threadId);
    this.starting.get(threadId)?.abort();
    this.settlePermissions(threadId);
    const session = await this.sessions.get(threadId)?.catch(() => undefined);
    await session?.cancel();
  }

  /** Switches the thread's model between turns: now if its agent is running, otherwise when it next starts. */
  async setModel(threadId: string, model: string): Promise<void> {
    const thread = this.requireThread(threadId);
    // Many agents mishandle a settings change in the middle of a prompt.
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer de modèle.");
    const session = await this.sessions.get(threadId)?.catch(() => undefined);
    const choices = session?.model?.choices ?? this.store.getAgentModels(thread.agentId)?.models;
    if (!choices?.some((c) => c.id === model)) throw new Error("Modèle inconnu.");
    if (session?.model) {
      await session.setModel(model);
      // A new model can bring other effort levels, for the picker too.
      this.learnCatalog(thread.agentId, session.model, session.settings, false);
    }
    const settings = session && settingValues(session.settings);
    this.updateThread(threadId, {
      model: session?.model?.current ?? model,
      ...(settings ? { settings } : {}),
    });
  }

  /** Changes one of the agent's settings, such as its mode, between turns. */
  async setSetting(threadId: string, settingId: string, value: string): Promise<void> {
    const thread = this.requireThread(threadId);
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer ce réglage.");
    const session = await this.sessions.get(threadId)?.catch(() => undefined);
    const offered = session?.settings ?? this.store.getAgentModels(thread.agentId)?.settings;
    const setting = offered?.find((s) => s.id === settingId);
    if (!setting?.choices.some((c) => c.id === value)) throw new Error("Réglage inconnu.");
    if (session) {
      await session.setSetting(settingId, value);
      this.learnCatalog(thread.agentId, session.model, session.settings, false);
    }
    // One change can move others, so a running agent's own values win.
    const settings = (session && settingValues(session.settings)) ?? {
      ...this.requireThread(threadId).settings,
      [settingId]: value,
    };
    this.updateThread(threadId, { settings });
  }

  toggleFavorite(agentId: string, model: string, starred: boolean): void {
    if (!this.agents.list().some((a) => a.id === agentId))
      throw new Error(`Agent inconnu : ${agentId}`);
    const favorites = this.store.getSetting<Favorites>("favorites", {});
    const current = Object.hasOwn(favorites, agentId) ? (favorites[agentId] ?? []) : [];
    const next = current.filter((m) => m !== model);
    favorites[agentId] = starred ? [...next, model] : next;
    this.store.setSetting("favorites", favorites);
    this.broadcast({ type: "favorites", favorites });
  }

  /** The thread's changes since its branch started, for review before shipping. */
  async review(threadId: string): Promise<ReviewFile[]> {
    const workspace = this.requireThread(threadId).workspace;
    if (!workspace?.base) return [];
    return reviewChanges(workspace.path, workspace.base);
  }

  /** Commits the thread's changes, pushes its branch and opens a pull request if asked. */
  async ship(threadId: string, message: string, pr: boolean): Promise<ShipResult> {
    const thread = this.requireThread(threadId);
    const workspace = thread.workspace;
    if (!workspace?.base)
      throw new Error("Ce fil travaille dans le dossier du projet, sans branche à lui.");
    return this.exclusive(threadId, "Attends la fin de l'envoi de la branche.", async () => {
      const result = await ship(workspace.path, {
        branch: workspace.branch,
        message,
        pr,
        title: thread.title,
        ...(workspace.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
      });
      // A link to open a pull request never replaces one that is already open.
      if (result.url && !(workspace.prOpened && !result.prOpened)) {
        this.updateThread(threadId, {
          workspace: { ...workspace, prUrl: result.url, prOpened: result.prOpened },
        });
      }
      return result;
    });
  }

  /**
   * Puts the thread's files back as they were just before this message, and removes the
   * message and everything after it. The agent then starts over from what is left.
   */
  async restore(threadId: string, itemId: string): Promise<void> {
    const workspace = this.requireThread(threadId).workspace;
    const item = this.store.getItem(threadId, itemId);
    const tree = item?.kind === "user" ? item.checkpoint : undefined;
    if (!workspace || !tree) throw new Error("Ce message n'a pas de point de retour.");
    await this.exclusive(threadId, "Attends la fin du retour en arrière.", async () => {
      // The agent stops first, so nothing it started holds a file about to change (Windows).
      await this.forgetSession(threadId);
      await restoreCheckpoint(workspace.path, tree);
      const removed = this.store.removeItemsFrom(threadId, itemId);
      // Going back before a hand-off goes back to the agent of that time, on its defaults.
      const handoff = removed.find((i) => i.kind === "handoff");
      this.updateThread(threadId, {
        status: "idle",
        usage: undefined,
        error: null,
        ...(handoff
          ? { agentId: handoff.from, model: undefined, settings: undefined, canCompact: undefined }
          : {}),
      });
      this.sendToViewers(threadId, {
        type: "items",
        threadId,
        items: this.store.listItems(threadId),
      });
      // A ref left behind only keeps an old tree alive, so failing here is harmless.
      await dropCheckpoints(
        workspace.path,
        removed.flatMap((i) =>
          i.kind === "user" && i.checkpoint ? [checkpointRef(threadId, i.id)] : [],
        ),
      ).catch(() => undefined);
    });
  }

  /** Hands the thread to another agent between turns; it gets the conversation so far. */
  async switchAgent(threadId: string, agentId: string): Promise<void> {
    const thread = this.requireThread(threadId);
    if (thread.agentId === agentId) return;
    this.agents.launch(agentId);
    await this.exclusive(threadId, "Attends la fin du changement d'agent.", async () => {
      await this.forgetSession(threadId);
      // The new agent offers its own models and settings, so its defaults apply.
      this.updateThread(threadId, {
        agentId,
        model: undefined,
        settings: undefined,
        usage: undefined,
        canCompact: undefined,
        status: "idle",
        error: null,
      });
      // Switching again before any message only changes where the last hand-off leads.
      const last = this.store.lastItem(threadId);
      if (last?.kind === "handoff" && last.from === agentId) {
        this.store.removeItemsFrom(threadId, last.id);
        this.sendToViewers(threadId, {
          type: "items",
          threadId,
          items: this.store.listItems(threadId),
        });
      } else if (last?.kind === "handoff") {
        this.putItem(threadId, { ...last, to: agentId });
      } else {
        this.putItem(threadId, {
          id: `handoff:${randomUUID()}`,
          kind: "handoff",
          from: thread.agentId,
          to: agentId,
          at: Date.now(),
        });
      }
    });
  }

  /** Runs a step that no turn and no other such step may overlap. */
  private async exclusive<T>(threadId: string, reason: string, work: () => Promise<T>): Promise<T> {
    if (this.turns.has(threadId)) throw new Error("Attends la fin de la réponse de l'agent.");
    const busy = this.busy.get(threadId);
    if (busy) throw new Error(busy);
    this.busy.set(threadId, reason);
    const step = work();
    this.steps.add(step);
    try {
      return await step;
    } finally {
      this.steps.delete(step);
      this.busy.delete(threadId);
    }
  }

  /** Stops the thread's agent and forgets its session, so the next turn starts a new one. */
  private async forgetSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    await session?.then((s) => s.close()).catch(() => undefined);
    this.store.setSessionId(threadId, null);
  }

  /** Registers an MCP server for every agent session started from now on. */
  addMcpServer(input: McpServerInput): string {
    const key = input.name.trim().toLowerCase();
    if (this.mcpServers().some((s) => s.name.trim().toLowerCase() === key)) {
      throw new Error(`Un serveur MCP s'appelle déjà « ${input.name} ».`);
    }
    const id = randomUUID();
    this.updateMcpServers((servers) => [...servers, { ...input, id, enabled: true }]);
    return id;
  }

  private mcpServers(): McpServerRecord[] {
    return this.store.getSetting<McpServerRecord[]>("mcpServers", []);
  }

  private updateMcpServers(change: (servers: McpServerRecord[]) => McpServerRecord[]): void {
    const servers = change(this.mcpServers());
    this.store.setSetting("mcpServers", servers);
    this.broadcast({ type: "mcpServers", servers: servers.map(mcpInfo) });
  }

  /**
   * Starts the agent briefly so the UI can list its models before the first message.
   * A failure is shown with the agent (`modelsError`) rather than thrown, so the picker can offer a retry.
   */
  discover(agentId: string, projectId: string): Promise<void> {
    const running = this.discoveries.get(agentId);
    if (running) return running.done;
    const project = this.store.getProject(projectId);
    if (!project) return Promise.reject(new Error("Projet introuvable."));
    if (this.discoveryErrors.delete(agentId)) {
      this.broadcast({ type: "agents", agents: this.agentList() });
    }
    const stop = new AbortController();
    const done = AgentSession.start({
      launch: this.agents.launch(agentId),
      cwd: project.path,
      previousSessionId: null,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    })
      .then(
        (session) => {
          this.learnCatalog(agentId, session.model, session.settings, session.fresh);
          return session.close();
        },
        (error: unknown) => {
          if (stop.signal.aborted) return;
          this.discoveryErrors.set(agentId, describe(error));
          this.broadcast({ type: "agents", agents: this.agentList() });
        },
      )
      .finally(() => this.discoveries.delete(agentId));
    this.discoveries.set(agentId, { done, stop });
    return done;
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
    const discoveries = [...this.discoveries.values()];
    for (const d of discoveries) d.stop.abort();
    await Promise.all(discoveries.map((d) => d.done.catch(() => undefined)));
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((s) => s.then((session) => session.close()).catch(() => undefined)),
    );
    await Promise.all(this.turns.values());
    await Promise.all([...this.steps].map((step) => step.catch(() => undefined)));
  }

  private async runTurn(thread: Thread, text: string, itemId: string): Promise<void> {
    try {
      const continuing = this.sessions.has(thread.id);
      const session = await this.session(thread);
      await this.checkpoint(thread.id, itemId);
      if (this.cancelled.has(thread.id)) {
        this.updateThread(thread.id, { status: "idle" });
        return;
      }
      // A new session knows nothing of the thread: after a hand-off, a step back, or when
      // the agent could not resume its earlier session.
      const history =
        !continuing && session.fresh
          ? historyBefore(this.store.listItems(thread.id), itemId, this.agentName)
          : undefined;
      const stopReason = await session.prompt(text, history);
      const error =
        stopReason === "refusal"
          ? "L'agent a refusé de continuer."
          : stopReason === "max_tokens"
            ? "L'agent a atteint sa limite de réponse."
            : null;
      this.updateThread(thread.id, error ? { status: "error", error } : { status: "idle" });
    } catch (error) {
      this.settlePermissions(thread.id);
      // Stopping an agent that was still starting is what the user asked for, not a failure.
      if (this.cancelled.has(thread.id)) {
        this.updateThread(thread.id, { status: "idle", error: null });
        return;
      }
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
    const stop = new AbortController();
    this.starting.set(thread.id, stop);
    const started = this.prepareWorkspace(thread.id, project)
      .then((cwd) => this.startSession(thread, cwd, stop.signal))
      .finally(() => {
        if (this.starting.get(thread.id) === stop) this.starting.delete(thread.id);
      });
    this.sessions.set(thread.id, started);
    started.then(
      (s) => this.store.setSessionId(thread.id, s.sessionId),
      () => this.sessions.delete(thread.id),
    );
    return started;
  }

  /** Saves the thread's files before a turn, so the user can come back to this message. */
  private async checkpoint(threadId: string, itemId: string): Promise<void> {
    const workspace = this.store.getThread(threadId)?.workspace;
    if (!workspace?.base) return;
    try {
      const tree = await saveCheckpoint(workspace.path, checkpointRef(threadId, itemId));
      const item = this.store.getItem(threadId, itemId);
      if (item?.kind === "user") this.putItem(threadId, { ...item, checkpoint: tree });
    } catch {
      // The turn goes on; this message just offers no way back.
    }
  }

  /** Makes the thread's worktree on first use; returns the folder the agent works in. */
  private async prepareWorkspace(threadId: string, project: Project): Promise<string> {
    const workspace = this.store.getThread(threadId)?.workspace;
    if (!workspace) return project.path;
    if (!existsSync(workspace.path)) {
      if (workspace.base) {
        throw new Error(`La copie de travail de ce fil a disparu : ${workspace.path}`);
      }
      const made = await addWorktree(project.path, workspace.path, workspace.branch);
      this.updateThread(threadId, { workspace: { ...workspace, ...made } });
    }
    return workspace.path;
  }

  private withGit(project: Project): Project {
    let git = this.gitProjects.get(project.id);
    if (git === undefined) {
      git = isGitRepo(project.path);
      this.gitProjects.set(project.id, git);
    }
    return git ? { ...project, git } : project;
  }

  private async startSession(
    thread: Thread,
    cwd: string,
    stop: AbortSignal,
  ): Promise<AgentSession> {
    // Until the thread's own model and settings are applied, the agent's are not news.
    let ready = false;
    const session = await AgentSession.start({
      launch: this.agents.launch(thread.agentId),
      cwd,
      previousSessionId: this.store.getSessionId(thread.id),
      mcpServers: this.mcpServers(),
      signal: AbortSignal.any([stop, AbortSignal.timeout(START_TIMEOUT_MS)]),
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
        onConfig: ({ model, settings }) => {
          if (!ready) return;
          this.learnCatalog(thread.agentId, model, settings, false);
          const current = this.store.getThread(thread.id);
          if (model && model.current !== current?.model) {
            this.updateThread(thread.id, { model: model.current });
          }
          const values = settingValues(settings);
          if (values && JSON.stringify(values) !== JSON.stringify(current?.settings)) {
            this.updateThread(thread.id, { settings: values });
          }
        },
      },
    });
    try {
      this.learnCatalog(thread.agentId, session.model, session.settings, session.fresh);
      const model = session.model;
      if (model) {
        // A continued session already runs the model it was left on.
        const wanted =
          this.store.getThread(thread.id)?.model ??
          (session.fresh ? this.defaultModel(thread.agentId) : undefined);
        if (wanted && wanted !== model.current && model.choices.some((c) => c.id === wanted)) {
          await session.setModel(wanted);
        }
        this.updateThread(thread.id, { model: session.model?.current ?? model.current });
      }
      // After the model, which can change the effort levels on offer.
      await this.applySettings(thread.id, session);
      this.learnCatalog(thread.agentId, session.model, session.settings, false);
    } catch (error) {
      // An agent that started but could not be set up is stopped, not left running unseen.
      await session.close();
      throw error;
    }
    ready = true;
    return session;
  }

  /** Gives a starting agent the mode and effort the thread asked for. */
  private async applySettings(threadId: string, session: AgentSession): Promise<void> {
    const wanted = this.store.getThread(threadId)?.settings ?? {};
    for (const setting of session.settings) {
      const value = Object.hasOwn(wanted, setting.id) ? wanted[setting.id] : undefined;
      if (value && value !== setting.current && setting.choices.some((c) => c.id === value)) {
        await session.setSetting(setting.id, value);
      }
    }
    const values = settingValues(session.settings);
    if (values) this.updateThread(threadId, { settings: values });
  }

  private readonly agentName = (agentId: string) =>
    this.agents.list().find((a) => a.id === agentId)?.name ?? agentId;

  private agentList(): AgentInfo[] {
    return this.agents.list().map((agent) => {
      const known = this.store.getAgentModels(agent.id);
      const modelsError = this.discoveryErrors.get(agent.id);
      if (!known) return modelsError ? { ...agent, modelsError } : agent;
      const defaultModel = this.defaultModel(agent.id);
      return {
        ...agent,
        models: known.models,
        ...(defaultModel ? { defaultModel } : {}),
        // An empty list says the agent has none; a missing one, from an older cache, is unknown.
        ...(known.settings ? { settings: known.settings } : {}),
      };
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

  /**
   * Remembers the models and settings an agent offers, so new threads can offer them before
   * starting it. Only a fresh session tells the agent's own defaults, or that it offers no
   * model choice, which is remembered too so the UI stops asking.
   */
  private learnCatalog(
    agentId: string,
    model: ModelOption | undefined,
    settings: AgentSetting[],
    fresh: boolean,
  ): void {
    const before = this.store.getAgentModels(agentId);
    if (!fresh && !model && (!before || !settings.length)) return;
    const keep = !fresh && before;
    const next = {
      models: model ? model.choices : keep ? before.models : [],
      current: model ? (keep ? before.current : model.current) : keep ? before.current : "",
      // A continued session that leaves its settings out does not take them away.
      settings:
        keep && !settings.length
          ? (before.settings ?? [])
          : settings.map((s) => ({
              ...s,
              current: (keep && before.settings?.find((b) => b.id === s.id)?.current) || s.current,
            })),
    };
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
      case "usage_update": {
        if (!(update.size > 0 && update.used >= 0)) return;
        const before = this.store.getThread(threadId)?.usage;
        if (before?.used === update.used && before.size === update.size) return;
        this.updateThread(threadId, { usage: { used: update.used, size: update.size } });
        return;
      }
      case "available_commands_update": {
        const canCompact = update.availableCommands.some((c) => c.name === "compact");
        if (canCompact !== !!this.store.getThread(threadId)?.canCompact) {
          this.updateThread(threadId, { canCompact });
        }
        return;
      }
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
    // Agents may number their tool calls from scratch on every turn or session, so the turn
    // is part of the item's id: a later call never replaces an earlier turn's card.
    const id = `tool:${this.turnIds.get(threadId) ?? "late"}:${update.toolCallId}`;
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
