import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_PARALLEL, defaultTeam, TEAM_PRESETS, threadGroup } from "@moonagentic/protocol";
import type {
  CoordinatorSettings,
  Item,
  PendingRequest,
  PermissionMode,
  ServerMessage,
  TeamSetup,
  Thread,
  WorkKind,
} from "@moonagentic/protocol";
import type { AgentCatalog } from "./catalog.ts";
import {
  BRIDGE_BOOTSTRAP_ENV,
  BRIDGE_URL_ENV,
  COORDINATOR_TOOLS,
  MESSAGE_MODES,
  THREAD_KINDS,
} from "./coordinator-tools.ts";
import type { Hub } from "./hub.ts";
import type { McpServerRecord } from "./mcp.ts";
import type { Store } from "./store.ts";

/** Threads a coordinator may open while answering one message, so a mistake cannot flood. */
const MAX_OPENED_PER_TURN = 4;
/** Messages of a thread shown to the coordinator that reads it, and characters of each. */
const READ_MESSAGES = 8;
const READ_CLIP = 1_500;

/** The user's own words, joined to the brief of a thread opened for them. */
const withOrigin = (brief: string, asked: string | undefined) =>
  asked
    ? `${brief}\n\n---\nMessage d'origine de l'utilisateur, transmis tel quel par MoonAgentic :\n\n${asked
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    : brief;

/** The user's messages joined to a brief, at most: the latest ones. */
const ASKED_MESSAGES = 6;
/** How long a coordinator's default team waits for the agents to give their models. */
const PRESET_DISCOVERY_MS = 20_000;
/** Told to a thread's agent before a coordinator's message, so it knows who speaks. */
const FROM_COORDINATOR =
  "Le message qui suit vient du coordinateur du projet : un agent qui répartit les demandes de l'utilisateur, pas l'utilisateur lui-même. Seule la partie « Message d'origine de l'utilisateur », quand elle est là, est de sa main.";

/** The coordinator's tools that change something: only while it answers the user. */
const WRITES = new Set(["open_thread", "start_team", "message_thread", "resolve_thread"]);
const BRIDGE = fileURLToPath(new URL("./coordinator-bridge.ts", import.meta.url));

/** What a coordinator is told before each message: its part, and how it acts. */
export const coordinatorPrompt = (project: string) =>
  `Tu es le coordinateur du projet « ${project} » dans MoonAgentic. L'utilisateur te parle de tout le projet ; chaque sujet de travail vit dans son propre fil, avec son agent et sa branche.

Ce que tu fais :
- Une question rapide ou un point d'avancement : tu réponds toi-même, en quelques phrases. Pour l'avancement, lis l'état réel avec list_threads, puis read_thread si on te demande le détail d'un fil. N'invente jamais un état.
- Un bug, une fonctionnalité, une relecture, toute tâche qui demande du travail : tu ne la fais pas toi-même et tu ne modifies aucun fichier. Tu ouvres un fil avec open_thread, avec un titre court et une consigne complète, car l'agent du fil ne voit pas cette conversation. Donne toujours kind : les réglages de l'utilisateur en déduisent l'agent. Si l'outil répond que le fil est en file, dis-le : il démarrera seul.
- Une tâche trop grosse pour un seul fil, avec plusieurs morceaux indépendants, ou quand l'utilisateur demande une équipe : start_team.
- Un sujet qui a déjà son fil : tu le relances avec message_thread plutôt que d'en ouvrir un second. Si son agent travaille, ton message attend la fin de son tour ; mode steer seulement pour une correction urgente, car il coupe le travail en cours.
- resolve_thread seulement quand l'utilisateur dit que le sujet est clos.

Si un outil échoue, dis-le tout de suite à l'utilisateur en une phrase, avec ce qu'il peut faire, au lieu de chercher longtemps un autre chemin. N'utilise pas le mode plan : tu ne codes pas, tu ouvres des fils.

Après un outil, dis en une phrase ce que tu as fait. Reste bref : pas de plan, pas de récapitulatif. Réponds dans la langue de l'utilisateur.`;

/** A coordinator's call that came with no token of this server's: answered 401. */
export class CoordinatorRefused extends Error {
  constructor() {
    super("Accès refusé.");
  }
}

/** What coordinators need of the hub that runs the threads. */
export interface CoordinatorHost extends Pick<
  Hub,
  "createThread" | "startTeam" | "send" | "cancel" | "whenIdle" | "setArchived" | "discover"
> {
  catalog: AgentCatalog;
  broadcast(message: ServerMessage): void;
  /** Throws when the agent is not one this server can start. */
  checkAgent(agentId: string): void;
  /** Whether the project is being removed. */
  removing(projectId: string): boolean;
  /** Whether a turn is running on the thread. */
  running(threadId: string): boolean;
  /** A team's real state, for a message to its lead. */
  leadContext(threadId: string): string | undefined;
  updateThread(threadId: string, patch: Parameters<Store["updateThread"]>[1]): void;
  items(threadId: string): Item[];
  putItem(threadId: string, item: Item): void;
  requireThread(threadId: string): Thread;
  pendingRequests(): PendingRequest[];
  /**
   * Asks the user once before a supervised coordinator launches a saved full-access team.
   * Resolves to `"full"`, `"supervised"`, or `null` if refused/cancelled.
   */
  confirmTeamPermission(
    coordinatorId: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<PermissionMode | null>;
}

/**
 * The projects' coordinators: their settings, the bridge their agents call tools through,
 * the threads they open, and the line of those waiting for a place.
 */
export class Coordinators {
  private readonly store: Store;
  private readonly host: CoordinatorHost;
  /** What each coordinator's bridge may reach, by its token: one project, kept in memory only. */
  private readonly tokens = new Map<string, { projectId: string; threadId: string }>();
  /** What each bridge was started with: traded once for a token, then worth nothing. */
  private readonly bootstraps = new Map<string, { projectId: string; threadId: string }>();
  /** Messages a coordinator left for a thread at work, given when its turn ends. */
  private readonly queued = new Map<string, string[]>();
  /** Threads each coordinator opened while answering the current message. */
  private readonly openedThisTurn = new Map<string, number>();
  /** Where this server answers a coordinator's bridge, once it listens. */
  url: string | undefined;

  constructor(store: Store, host: CoordinatorHost) {
    this.store = store;
    this.host = host;
  }

  /** Whether a coordinator left messages for the thread, still to be given. */
  hasQueued(threadId: string): boolean {
    return !!this.queued.get(threadId)?.length;
  }

  /** The thread is deleted: nothing is kept for it. */
  forget(threadId: string): void {
    this.queued.delete(threadId);
    this.openedThisTurn.delete(threadId);
  }

  /** How coordinators route work, as set in the settings. */
  coordinatorSettings(): CoordinatorSettings {
    return this.store.getSetting<CoordinatorSettings>("coordinator", { routes: {} });
  }

  /**
   * The agent and model the user has just given, by hand, to a thread a coordinator opened:
   * the next threads coordinators open start with them, until a kind of work says otherwise.
   */
  keepChoice(threadId: string): void {
    const thread = this.store.getThread(threadId);
    if (!thread?.openedBy || thread.parentId) return;
    const settings = this.coordinatorSettings();
    const now = settings.routes.default;
    if (now?.agentId === thread.agentId && now.model === thread.model) return;
    this.setCoordinatorSettings({
      ...settings,
      routes: {
        ...settings.routes,
        default: { agentId: thread.agentId, ...(thread.model ? { model: thread.model } : {}) },
      },
    });
  }

  setCoordinatorSettings(settings: CoordinatorSettings): void {
    this.store.setSetting("coordinator", settings);
    this.host.broadcast({ type: "coordinatorSettings", settings });
  }

  /** The project's coordinator, made with this agent when the project has none yet. */
  openCoordinator(projectId: string, agentId: string, model?: string): string {
    const known = this.store
      .listThreads()
      .find((t) => t.projectId === projectId && t.kind === "coordinator");
    if (known) return known.id;
    const project = this.store.getProject(projectId);
    if (!project || this.host.removing(projectId)) throw new Error("Projet introuvable.");
    this.host.checkAgent(agentId);
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      projectId,
      title: `Coordinateur · ${project.name}`,
      agentId,
      status: "idle",
      // It reads and routes; anything it would change still asks first.
      permissionMode: "supervised",
      ...(model ? { model } : {}),
      kind: "coordinator",
      createdAt: now,
      updatedAt: now,
    };
    this.store.addThread(thread);
    this.host.broadcast({ type: "thread", thread });
    return thread.id;
  }

  /** For the user writing to a coordinator: its part, given before the message. */
  coordinatorContext(threadId: string): string | undefined {
    const thread = this.store.getThread(threadId);
    if (thread?.kind !== "coordinator") return undefined;
    this.openedThisTurn.delete(threadId);
    return coordinatorPrompt(this.store.getProject(thread.projectId)?.name ?? "");
  }

  /**
   * What the user asked the coordinator since it last opened a thread: every message, not
   * only the last one, since a "continue" after a stop is not the request itself.
   */
  private askedSince(coordinatorId: string): string | undefined {
    const items = this.store.listItems(coordinatorId);
    const asked: string[] = [];
    let i = items.findLastIndex((item) => item.kind === "user");
    for (; i >= 0; i--) {
      const item = items[i]!;
      // A thread opened before the message being answered closes what came before it.
      if (item.kind === "opened" && asked.length) break;
      if (item.kind === "user" && !item.from && !item.byTeam) asked.unshift(item.text);
    }
    if (!asked.length) return undefined;
    return asked.slice(-ASKED_MESSAGES).join("\n\n");
  }

  /** The first preset's team on the agents at hand, their models asked for if need be. */
  private async presetTeam(
    projectId: string,
    permissionMode: PermissionMode,
  ): Promise<TeamSetup | undefined> {
    const unknown = this.host.catalog
      .list()
      .filter((a) => a.available && !a.models && !a.modelsError);
    await Promise.race([
      Promise.all(unknown.map((a) => this.host.discover(a.id, projectId).catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, PRESET_DISCOVERY_MS)),
    ]);
    const members = defaultTeam(this.host.catalog.list());
    return members && { ...members, coders: 2, permissionMode };
  }

  /** Forgets every access given to a coordinator's bridge so far. */
  dropCoordinatorAccess(threadId: string): void {
    for (const held of [this.tokens, this.bootstraps]) {
      for (const [token, scope] of held) if (scope.threadId === threadId) held.delete(token);
    }
  }

  /**
   * The MCP server given to a coordinator's agent. Its environment only holds what the
   * bridge trades, once, for its token: a command the agent runs later finds nothing to use.
   */
  coordinatorServer(thread: Thread): McpServerRecord[] {
    if (thread.kind !== "coordinator" || !this.url) return [];
    this.dropCoordinatorAccess(thread.id);
    const bootstrap = randomBytes(32).toString("base64url");
    this.bootstraps.set(bootstrap, { projectId: thread.projectId, threadId: thread.id });
    return [
      {
        id: "moonagentic",
        name: "moonagentic",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [BRIDGE],
          env: [
            { name: BRIDGE_URL_ENV, value: this.url },
            { name: BRIDGE_BOOTSTRAP_ENV, value: bootstrap },
            // In the desktop app, this program is Electron, which acts as Node only when told:
            // said here too, for agents that start MCP servers with only the variables given.
            ...(process.env.ELECTRON_RUN_AS_NODE
              ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
              : []),
          ],
        },
      },
    ];
  }

  /** The bridge's first call: what it was started with, once, for the token of its project. */
  coordinatorExchange(bootstrap: string): string {
    const scope = this.bootstraps.get(bootstrap);
    if (!scope) throw new CoordinatorRefused();
    this.dropCoordinatorAccess(scope.threadId);
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, scope);
    return token;
  }

  /** A coordinator's words to a thread: marked as its own, and said to be an agent's. */
  sendFromCoordinator(threadId: string, text: string, byTeam?: boolean): void {
    const lead = this.host.leadContext(threadId);
    this.host.send(
      threadId,
      text,
      lead ? `${FROM_COORDINATOR}\n\n${lead}` : FROM_COORDINATOR,
      byTeam,
      "coordinator",
    );
  }

  /** Threads a coordinator opened that are at work now: a turn under way, or a team running. */
  private atWork(coordinatorId: string): number {
    return this.store
      .listThreads()
      .filter(
        (t) =>
          t.openedBy === coordinatorId &&
          !t.archived &&
          (this.host.running(t.id) ||
            (t.team && ["planning", "coding", "merging"].includes(t.team.phase))),
      ).length;
  }

  private parallel(): number {
    return this.coordinatorSettings().parallel ?? DEFAULT_PARALLEL;
  }

  /** Starts the threads waiting in line behind a coordinator, oldest first, while it has places free. */
  drainLine(coordinatorId: string): void {
    const waiting = this.store
      .listThreads()
      .filter((t) => t.openedBy === coordinatorId && t.held && !t.archived)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const next of waiting) {
      if (this.atWork(coordinatorId) >= this.parallel()) return;
      const brief = next.held!;
      try {
        this.sendFromCoordinator(next.id, brief);
        this.host.updateThread(next.id, { held: null });
      } catch {
        // Busy for a moment, with a step back or a change of setting: it keeps its place
        // and its brief, and is tried again when the next place frees.
        continue;
      }
    }
  }

  /** Gives a thread whose turn just ended what a coordinator left for it meanwhile. */
  sendQueued(threadId: string): void {
    const waiting = this.queued.get(threadId);
    if (!waiting?.length || this.host.running(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.archived) {
      this.queued.delete(threadId);
      return;
    }
    try {
      this.sendFromCoordinator(threadId, waiting.join("\n\n"));
      this.queued.delete(threadId);
    } catch {
      // Still busy, with a team or a step back: kept for the end of the next turn.
    }
  }

  /** What a coordinator is shown of a thread: its real state, nothing made up. */
  private threadForCoordinator(t: Thread, all = this.store.listThreads()) {
    // A team shows what its members wait for, as the project's page does.
    const members = all.filter((m) => m.parentId === t.id);
    const asking = [t, ...members].some((m) => m.status === "waiting");
    const blocked = t.team?.tasks.find((task) => task.status === "blocked");
    return {
      id: t.id,
      title: t.title,
      state: t.held
        ? "en file"
        : { waiting: "en attente", running: "en cours", idle: "inactif", resolved: "résolu" }[
            threadGroup(t, members)
          ],
      agent: t.agentId,
      ...(t.model ? { model: t.model } : {}),
      ...(asking ? { waits_on: "une réponse de l'utilisateur" } : {}),
      ...(t.error ? { error: t.error } : {}),
      ...(t.team
        ? {
            team: {
              phase: t.team.phase,
              pieces: t.team.tasks.map((task) => `${task.title} : ${task.status}`),
              ...(blocked?.note ? { blocked_because: blocked.note } : {}),
            },
          }
        : {}),
      ...(t.pr
        ? {
            pull_request: {
              number: t.pr.number,
              url: t.pr.url,
              state: t.pr.state,
              checks: t.pr.checks,
              ...(t.pr.conflicts ? { conflicts: true } : {}),
            },
          }
        : {}),
      ...(t.workspace?.base ? { branch: t.workspace.branch } : {}),
      ...(t.summary ? { last_said: t.summary } : {}),
      ...(this.queued.get(t.id)?.length ? { queued_messages: this.queued.get(t.id)!.length } : {}),
      updated: new Date(t.updatedAt).toISOString(),
    };
  }

  /**
   * One tool call of a coordinator, from its bridge. The token says which project it may
   * touch: a thread of another project, a team's member or a coordinator is never reached.
   */
  async coordinatorCall(
    token: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const scope = this.tokens.get(token);
    const coordinator = scope && this.store.getThread(scope.threadId);
    if (!scope || coordinator?.kind !== "coordinator") throw new CoordinatorRefused();
    if (!COORDINATOR_TOOLS.some((t) => t.name === tool)) throw new Error(`Outil inconnu : ${tool}`);
    // It acts for the message it is answering: a bridge left behind changes nothing later.
    if (WRITES.has(tool) && !this.host.running(coordinator.id))
      throw new Error("Le coordinateur n'agit que pendant qu'il répond à l'utilisateur.");
    const input =
      typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    const str = (key: string, max: number) => {
      const value = input[key];
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value !== "string" || value.length > max)
        throw new Error(`« ${key} » doit être un texte d'au plus ${max} caractères.`);
      return value.trim() || undefined;
    };
    const need = (key: string, max: number) => {
      const value = str(key, max);
      if (!value) throw new Error(`« ${key} » est requis.`);
      return value;
    };
    const mine = () =>
      this.store
        .listThreads()
        .filter((t) => t.projectId === scope.projectId && !t.parentId && t.kind !== "coordinator");
    const one = () => {
      const id = need("thread_id", 200);
      const thread = mine().find((t) => t.id === id);
      if (!thread) throw new Error("Ce fil n'existe pas dans ce projet.");
      return thread;
    };
    switch (tool) {
      case "list_threads": {
        const all = this.store.listThreads();
        return mine().map((t) => this.threadForCoordinator(t, all));
      }
      case "read_thread": {
        const thread = one();
        const messages = this.host
          .items(thread.id)
          .flatMap((i) =>
            (i.kind === "user" && !i.byTeam) || i.kind === "agent"
              ? [
                  {
                    from: i.kind === "agent" ? "agent" : i.from ? "coordinateur" : "utilisateur",
                    text: i.text.length > READ_CLIP ? `${i.text.slice(0, READ_CLIP)}…` : i.text,
                  },
                ]
              : [],
          )
          .slice(-READ_MESSAGES);
        const team = new Set([
          thread.id,
          ...this.store
            .listThreads()
            .filter((m) => m.parentId === thread.id)
            .map((m) => m.id),
        ]);
        const asks = this.host
          .pendingRequests()
          .filter((r) => team.has(r.threadId))
          .map((r) => r.title);
        return {
          ...this.threadForCoordinator(thread),
          ...(asks.length ? { asks_permission_for: asks } : {}),
          last_messages: messages,
        };
      }
      case "open_thread": {
        const taskKey = need("task_key", 80).toLowerCase();
        const title = need("title", 120);
        const brief = need("brief", 20_000);
        const kind = str("kind", 40);
        if (kind && !(THREAD_KINDS as readonly string[]).includes(kind))
          throw new Error(`« kind » doit être l'un de : ${THREAD_KINDS.join(", ")}.`);
        // A retry, or the same subject asked twice: the thread already open, not a second one.
        const known = mine().find(
          (t) => t.openedBy === coordinator.id && t.taskKey === taskKey && !t.archived,
        );
        if (known) return { already_open: true, opened: this.threadForCoordinator(known) };
        const opened = this.openedThisTurn.get(coordinator.id) ?? 0;
        if (opened >= MAX_OPENED_PER_TURN)
          throw new Error(
            `Tu as déjà ouvert ${opened} fils pour ce message : demande à l'utilisateur avant d'en ouvrir d'autres.`,
          );
        // Asked by name, else where the settings send this kind of work, else where they
        // send any work, else its own agent.
        const routes = this.coordinatorSettings().routes;
        const route = (kind ? routes[kind as WorkKind] : undefined) ?? routes.default;
        const asked = str("agent", 200);
        const agentId = asked ?? route?.agentId ?? coordinator.agentId;
        const model =
          str("model", 200) ??
          (asked
            ? asked === coordinator.agentId
              ? coordinator.model
              : undefined
            : route
              ? route.model
              : coordinator.model);
        const id = this.host.createThread({
          projectId: scope.projectId,
          agentId,
          model,
          permissionMode: coordinator.permissionMode,
          isolated: true,
          title,
          text: withOrigin(brief, this.askedSince(coordinator.id)),
          openedBy: coordinator.id,
          taskKey,
          // Past what it may run at once, the thread waits in line, in plain sight.
          held: this.atWork(coordinator.id) >= this.parallel(),
        });
        this.openedThisTurn.set(coordinator.id, opened + 1);
        this.host.putItem(coordinator.id, {
          id: `opened:${id}`,
          kind: "opened",
          threadId: id,
          title: this.host.requireThread(id).title,
          at: Date.now(),
        });
        const made = this.host.requireThread(id);
        return {
          opened: this.threadForCoordinator(made),
          ...(made.held
            ? { in_line: `Il démarre dès qu'un des ${this.parallel()} fils en cours se termine.` }
            : {}),
        };
      }
      case "start_team": {
        const taskKey = need("task_key", 80).toLowerCase();
        const task = need("task", 20_000);
        const known = mine().find(
          (t) => t.openedBy === coordinator.id && t.taskKey === taskKey && !t.archived,
        );
        if (known) return { already_open: true, opened: this.threadForCoordinator(known) };
        const saved = this.coordinatorSettings().team;
        // Never set up by hand: the first preset, on the agents at hand, rather than failing.
        const setup = saved ?? (await this.presetTeam(scope.projectId, coordinator.permissionMode));
        if (!setup)
          throw new Error(
            "Aucun agent n'est prêt pour former une équipe. Dis-le tout de suite à l'utilisateur, en une phrase, sans réessayer.",
          );
        const opened = this.openedThisTurn.get(coordinator.id) ?? 0;
        if (opened >= MAX_OPENED_PER_TURN)
          throw new Error(
            `Tu as déjà ouvert ${opened} fils pour ce message : demande à l'utilisateur avant d'en ouvrir d'autres.`,
          );
        // A supervised coordinator never escalates silently to full access: when the saved team
        // runs in full access, ask the user once (full, supervised, or cancel). Once the
        // coordinator itself is in full access, it launches autonomously 24/7.
        let permissionMode: PermissionMode = setup.permissionMode;
        if (coordinator.permissionMode !== "full" && setup.permissionMode === "full") {
          const chosen = await this.host.confirmTeamPermission(coordinator.id, task, signal);
          if (!chosen) {
            throw new Error("L'utilisateur a refusé de lancer l'équipe en accès complet.");
          }
          permissionMode = chosen;
        }
        const id = this.host.startTeam({
          ...setup,
          permissionMode,
          projectId: scope.projectId,
          task: withOrigin(task, this.askedSince(coordinator.id)),
          openedBy: coordinator.id,
          taskKey,
        });
        this.openedThisTurn.set(coordinator.id, opened + 1);
        this.host.putItem(coordinator.id, {
          id: `opened:${id}`,
          kind: "opened",
          threadId: id,
          title: this.host.requireThread(id).title,
          at: Date.now(),
        });
        return {
          opened: this.threadForCoordinator(this.host.requireThread(id)),
          ...(saved
            ? {}
            : {
                team: `Équipe par défaut (« ${TEAM_PRESETS[0]!.label} ») : l'utilisateur n'en a pas encore réglé. Dis-le-lui en une phrase ; il pourra en choisir une autre avec /equipe.`,
              }),
        };
      }
      case "message_thread": {
        const thread = one();
        const text = need("text", 20_000);
        const mode = str("mode", 20) ?? "queue";
        if (!(MESSAGE_MODES as readonly string[]).includes(mode))
          throw new Error(`« mode » doit être l'un de : ${MESSAGE_MODES.join(", ")}.`);
        if (thread.archived) throw new Error("Ce fil est résolu : l'utilisateur doit le rouvrir.");
        // In line, it has not started: the message joins its brief, and its place is kept.
        if (thread.held) {
          this.host.updateThread(thread.id, { held: `${thread.held}\n\n${text}` });
          return { queued_for: thread.title, delivered: "au démarrage du fil en file" };
        }
        if (!this.host.running(thread.id)) {
          this.sendFromCoordinator(thread.id, text);
          return { sent_to: thread.title };
        }
        if (mode === "queue") {
          this.queued.set(thread.id, [...(this.queued.get(thread.id) ?? []), text]);
          return { queued_for: thread.title, delivered: "à la fin du tour en cours" };
        }
        // A team's pieces are run by the server: cutting its lead would leave them adrift.
        if (thread.team) throw new Error("Une équipe ne se coupe pas : utilise le mode queue.");
        await this.host.cancel(thread.id);
        await this.host.whenIdle(thread.id);
        this.sendFromCoordinator(thread.id, text);
        return { sent_to: thread.title, interrupted: true };
      }
      case "resolve_thread": {
        const thread = one();
        await this.host.setArchived(thread.id, true);
        return { resolved: thread.title };
      }
      default:
        throw new Error(`Outil inconnu : ${tool}`);
    }
  }
}
