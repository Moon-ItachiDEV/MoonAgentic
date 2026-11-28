import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARALLEL,
  defaultTeam,
  MAX_PROJECT_MEMORY,
  ORIGIN_MARK,
  REPLY_MARK,
  routeFor,
  VERDICT_FENCE,
  type TeamPreset,
  teamPresets,
  threadGroup,
  utf8Bytes,
} from "@moonagentic/protocol";
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
  BRIDGE_MODE_ENV,
  BRIDGE_URL_ENV,
  type BridgeMode,
  COORDINATOR_TOOLS,
  MAX_ARTIFACT_TEXT,
  MEMORY_MODES,
  MESSAGE_MODES,
  THREAD_KINDS,
  THREAD_TOOLS,
  toolsForBridgeMode,
} from "./coordinator-tools.ts";
import type { Hub } from "./hub.ts";
import type { McpServerRecord } from "./mcp.ts";
import { coordinatorSettingsOf, isTeamPreset } from "./saved-shapes.ts";
import { fold, type Store } from "./store.ts";

/** Threads a coordinator may open while answering one message, so a mistake cannot flood. */
const MAX_OPENED_PER_TURN = 4;
/** Messages of a thread shown by default when reading it, max per page, and characters of each. */
const READ_MESSAGES = 8;
const MAX_READ_MESSAGES = 20;
const READ_CLIP = 1_500;
/** Threads returned by default and at most by `search_threads`, and snippets per thread. */
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 20;
const SEARCH_SNIPPETS_PER_THREAD = 3;

/**
 * How a thread's agent answers, so the user reads it at a glance: in French, the result first.
 * A review ends with a block the thread shows as a card (`VERDICT_FENCE`).
 */
export function replyGuide(kind: string | undefined): string {
  const lines = [
    "Réponds en français, en phrases simples. Commence par le résultat en une ou deux phrases, puis seulement le détail utile.",
  ];
  if (kind === "relecture")
    lines.push(
      `Pour une relecture, commence par ton verdict en une phrase, puis termine ta réponse par un bloc \`\`\`${VERDICT_FENCE} contenant ce JSON, en français, sans rien après : {"verdict": "prete | a-corriger", "bloquants": [{"texte": "le problème en une phrase", "ou": "fichier:ligne"}], "importants": [...], "remarques": [...], "verifs": [{"texte": "Pas de conflit avec main", "ok": true}]}. Les listes vides restent [].`,
    );
  return lines.join("\n");
}

/** The user's own words, joined to the brief of a thread opened for them, with how to answer. */
const withOrigin = (brief: string, asked: string | undefined, kind?: string) =>
  `${brief}${REPLY_MARK}${replyGuide(kind)}${
    asked
      ? `${ORIGIN_MARK}${asked
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`
      : ""
  }`;

/** The user's messages joined to a brief, at most: the latest ones. */
const ASKED_MESSAGES = 6;
/** How long a coordinator's default team waits for the agents to give their models. */
const PRESET_DISCOVERY_MS = 20_000;
/** Told to a thread's agent before a coordinator's message, so it knows who speaks. */
const FROM_COORDINATOR =
  "Le message qui suit vient du coordinateur du projet : un agent qui répartit les demandes de l'utilisateur, pas l'utilisateur lui-même. Seule la partie « Message d'origine de l'utilisateur », quand elle est là, est de sa main.";

/** Tools that change MoonAgentic state: only allowed while the calling thread is answering. */
const WRITES = new Set([
  "open_thread",
  "start_team",
  "message_thread",
  "resolve_thread",
  "save_memory",
  "publish_artifact",
  "open_pull_request",
]);
const BRIDGE = fileURLToPath(new URL("./coordinator-bridge.ts", import.meta.url));

type BridgeScope = { projectId: string; threadId: string; mode: BridgeMode };

const bridgeModeOf = (thread: Thread, outside: boolean): BridgeMode =>
  thread.kind === "coordinator"
    ? "coordinator"
    : outside
      ? "discussion"
      : thread.role && thread.role !== "lead" && thread.role !== "coder"
        ? "readonly"
        : "thread";

/** What a coordinator is told before each message: its part, and how it acts. */
export const coordinatorPrompt = (project: string) =>
  `Tu es le coordinateur du projet « ${project} » dans MoonAgentic. L'utilisateur te parle de tout le projet ; chaque sujet de travail vit dans son propre fil, avec son agent et sa branche.

Ce que tu fais :
- Une question rapide ou un point d'avancement : tu réponds toi-même, en quelques phrases. Pour l'avancement, lis l'état réel avec list_threads, puis read_thread si on te demande le détail d'un fil. Pour retrouver une décision ou un sujet passé, utilise search_threads. N'invente jamais un état.
- Pour la mémoire durable du projet (partagée entre tous les agents, fils et branches), utilise read_memory et save_memory pour noter les décisions, conventions ou pièges durables.
- Un bug, une fonctionnalité, une relecture, toute tâche qui demande du travail : tu ne la fais pas toi-même et tu ne modifies aucun fichier. Tu ouvres un fil avec open_thread, avec un titre court et une consigne claire, car l'agent du fil ne voit pas cette conversation. La consigne s'affiche dans le fil sous « Coordinateur » : écris-la en français, en deux à quatre phrases simples (ce qu'il faut faire, où, et ce qui est attendu), sans liste de commandes, sans titres ni notes internes, sans recopier le message de l'utilisateur (MoonAgentic le joint déjà). Donne toujours kind : les réglages de l'utilisateur en déduisent l'agent. Si l'outil répond que le fil est en file, dis-le : il démarrera seul.
- Une tâche trop grosse pour un seul fil, avec plusieurs morceaux indépendants, ou quand l'utilisateur demande une équipe : start_team.
- Un sujet qui a déjà son fil : tu le relances avec message_thread plutôt que d'en ouvrir un second. Si son agent travaille, ton message attend la fin de son tour ; mode steer seulement pour une correction urgente, car il coupe le travail en cours.
- resolve_thread seulement quand l'utilisateur dit que le sujet est clos.

Si un outil échoue, dis-le tout de suite à l'utilisateur en une phrase, avec ce qu'il peut faire, au lieu de chercher longtemps un autre chemin. N'utilise pas le mode plan : tu ne codes pas, tu ouvres des fils.

Après un outil, dis en une phrase ce que tu as fait : l'interface montre déjà le fil ouvert et son état juste en dessous, ne le décris pas. Reste bref : pas de plan, pas de récapitulatif, pas de liste des outils utilisés. Réponds dans la langue de l'utilisateur.

Comment écrire :
- Commence par la réponse en une ou deux phrases simples.
- Quand tu parles d'un fil, écris un lien vers lui : [son titre](fil:ID), avec l'id donné par list_threads. L'interface le montre comme un lien qui ouvre le fil.
- Une pull request : écris son adresse GitHub complète ; l'interface la montre en pastille avec son état.
- Pour un point sur plusieurs fils : un titre court en gras (par exemple **Prêt pour relecture**), puis une ligne par fil : le lien du fil, deux-points, ce qu'il en est en une phrase.
- Pas de tableau, pas de bloc de code, pas de titres #.`;

/** A bridge's call that came with no valid token of this server's: answered 401. */
export class CoordinatorRefused extends Error {
  constructor() {
    super("Accès refusé.");
  }
}

/** What coordinators need of the hub that runs the threads. */
/** Where the teams the user set up in the settings are kept. */
export const TEAM_PRESETS_SETTING = "teamPresets";

export interface CoordinatorHost extends Pick<
  Hub,
  | "createThread"
  | "startTeam"
  | "send"
  | "cancel"
  | "whenIdle"
  | "setArchived"
  | "discover"
  | "queueMessage"
> {
  catalog: AgentCatalog;
  broadcast(message: ServerMessage): void;
  /** Throws when the agent is not one this server can start. */
  checkAgent(agentId: string): void;
  /** Whether the project is being removed. */
  removing(projectId: string): boolean;
  /**
   * Whether the project is « Discussions »: conversations started outside any project, with
   * nothing in common but where they are kept. They share no memory and do not read each other.
   */
  outsideProjects(projectId: string): boolean;
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
  /**
   * Asks the user before a thread outside full access writes the project's shared memory,
   * with the same card as an agent's own requests. False when refused or cancelled.
   */
  confirmMemoryWrite(
    threadId: string,
    content: string,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Publishes an artifact for the thread at work, a card in its timeline; see `publish_artifact`. */
  publishArtifact(
    threadId: string,
    input: { title: string; content?: string; path?: string; artifactId?: string },
  ): Promise<unknown>;
  /**
   * Commits, pushes the branch of the thread at work and opens its pull request; see
   * `open_pull_request`. Outside full access the user agrees first.
   */
  openPullRequest(
    threadId: string,
    input: { title: string; body?: string; message?: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/**
 * The projects' coordinators and per-project MCP bridges: their settings, the bridge their
 * agents call tools through, the threads coordinators open, and the line waiting for a place.
 */
export class Coordinators {
  private readonly store: Store;
  private readonly host: CoordinatorHost;
  /** What each bridge may reach, by its token: one project and one role, kept in memory only. */
  private readonly tokens = new Map<string, BridgeScope>();
  /** What each bridge was started with: traded once for a token, then worth nothing. */
  private readonly bootstraps = new Map<string, BridgeScope>();
  /** Threads each coordinator opened while answering the current message. */
  private readonly openedThisTurn = new Map<string, number>();
  /** Where this server answers a bridge, once it listens. */
  url: string | undefined;

  constructor(store: Store, host: CoordinatorHost) {
    this.store = store;
    this.host = host;
  }

  /** The thread is deleted: nothing is kept for it. */
  forget(threadId: string): void {
    this.openedThisTurn.delete(threadId);
  }

  /** How coordinators route work, as set in the settings. */
  coordinatorSettings(): CoordinatorSettings {
    return coordinatorSettingsOf(this.store.getSetting<unknown>("coordinator", undefined));
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
    const members = defaultTeam(this.host.catalog.list(), this.savedPresets());
    return members && { ...members, coders: 2, permissionMode };
  }

  /** The teams the user set up in the settings, if ever. */
  private savedPresets(): TeamPreset[] | undefined {
    const saved = this.store.getSetting<unknown[] | null>(TEAM_PRESETS_SETTING, null, "array");
    return saved ? saved.filter(isTeamPreset) : undefined;
  }

  /** Forgets every access given to a coordinator's bridge so far. */
  dropCoordinatorAccess(threadId: string): void {
    for (const held of [this.tokens, this.bootstraps]) {
      for (const [token, scope] of held) if (scope.threadId === threadId) held.delete(token);
    }
  }

  /**
   * The MCP server given to a thread's agent. Its environment only holds what the bridge
   * trades, once, for its token: a command the agent runs later finds nothing to use.
   * Regular threads only receive read-only project context + shared memory tools, and what
   * opens the pull request of their own branch; read-only team roles only receive read tools;
   * only a project's coordinator can orchestrate threads. Each may publish artifacts. A conversation outside any project may only do that: there
   * is no project to share.
   */
  coordinatorServer(thread: Thread): McpServerRecord[] {
    if (!this.url) return [];
    this.dropCoordinatorAccess(thread.id);
    const mode = bridgeModeOf(thread, this.host.outsideProjects(thread.projectId));
    const bootstrap = randomBytes(32).toString("base64url");
    this.bootstraps.set(bootstrap, { projectId: thread.projectId, threadId: thread.id, mode });
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
            { name: BRIDGE_MODE_ENV, value: mode },
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
    const thread = scope && this.store.getThread(scope.threadId);
    // A locked project is out of sight, not stopped: its agents keep their tools, which
    // never reach beyond their own project anyway.
    if (!scope || !thread || thread.projectId !== scope.projectId) throw new CoordinatorRefused();
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

  /** What a bridge caller is shown of a thread: its real state, nothing made up. */
  private threadForCoordinator(
    t: Thread,
    all = this.store.listThreads(),
    currentThreadId?: string,
  ) {
    // A team shows what its members wait for, as the project's page does.
    const members = all.filter((m) => m.parentId === t.id);
    const asking = [t, ...members].some((m) => m.status === "waiting");
    const blocked = t.team?.tasks.find((task) => task.status === "blocked");
    return {
      id: t.id,
      title: t.title,
      ...(currentThreadId && t.id === currentThreadId ? { current: true } : {}),
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
      ...(t.queue?.length ? { queued_messages: t.queue.length } : {}),
      updated: new Date(t.updatedAt).toISOString(),
    };
  }

  /**
   * One tool call from a thread's or coordinator's bridge. The token fixes both its project
   * and its role: another project, a team's sub-member, a coordinator, or any tool outside
   * the thread's role is never reached. A lock changes nothing here: the project's agents
   * keep working behind it, and what they read stays in threads the lock hides.
   */
  async coordinatorCall(
    token: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const scope = this.tokens.get(token);
    const caller = scope && this.store.getThread(scope.threadId);
    if (!scope || !caller || caller.projectId !== scope.projectId) throw new CoordinatorRefused();
    const mode = bridgeModeOf(caller, this.host.outsideProjects(caller.projectId));
    if (mode !== scope.mode) throw new CoordinatorRefused();
    const allowed = toolsForBridgeMode(mode);
    if (!allowed.some((t) => t.name === tool)) {
      const coordinators = COORDINATOR_TOOLS.some((t) => t.name === tool);
      if (coordinators || THREAD_TOOLS.some((t) => t.name === tool)) {
        throw new Error(
          mode === "readonly"
            ? `L'outil « ${tool} » n'est pas autorisé en lecture seule.`
            : mode === "discussion"
              ? `L'outil « ${tool} » n'existe que dans un projet.`
              : coordinators
                ? `L'outil « ${tool} » est réservé au coordinateur.`
                : `L'outil « ${tool} » est réservé aux fils qui travaillent : ouvre un fil pour ça.`,
        );
      }
      throw new Error(`Outil inconnu : ${tool}`);
    }
    // State changes only happen while the calling thread is answering: a stray bridge does nothing.
    if (WRITES.has(tool) && !this.host.running(caller.id)) {
      throw new Error(
        mode === "coordinator"
          ? "Le coordinateur n'agit que pendant qu'il répond à l'utilisateur."
          : "Cet outil n'est utilisable que pendant une réponse en cours.",
      );
    }
    const coordinator = caller;
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
    const int = (key: string, min: number, max: number) => {
      const value = input[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`« ${key} » doit être un entier entre ${min} et ${max}.`);
      }
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
      case "publish_artifact": {
        const content = input.content;
        if (content !== undefined && content !== null && typeof content !== "string")
          throw new Error("« content » doit être un texte.");
        if (typeof content === "string" && content.length > MAX_ARTIFACT_TEXT)
          throw new Error(
            `« content » dépasse ${MAX_ARTIFACT_TEXT} caractères : écris la page dans un fichier et donne son path.`,
          );
        const file = str("path", 4096);
        const given = typeof content === "string" && content.trim() ? content : undefined;
        if (!given === !file) throw new Error("Donne soit « content », soit « path ».");
        const artifactId = str("artifact_id", 200);
        return this.host.publishArtifact(caller.id, {
          title: need("title", 120),
          ...(given ? { content: given } : {}),
          ...(file ? { path: file } : {}),
          ...(artifactId ? { artifactId } : {}),
        });
      }
      case "open_pull_request": {
        const body = str("body", 60_000);
        const message = str("commit_message", 2_000);
        return this.host.openPullRequest(
          caller.id,
          {
            title: need("title", 300),
            ...(body ? { body } : {}),
            ...(message ? { message } : {}),
          },
          signal,
        );
      }
      case "list_threads": {
        const all = this.store.listThreads();
        return mine().map((t) => this.threadForCoordinator(t, all, scope.threadId));
      }
      case "search_threads": {
        const query = need("query", 200);
        const limit = int("limit", 1, SEARCH_MAX_LIMIT) ?? SEARCH_DEFAULT_LIMIT;
        const includeCurrent = input.include_current === true;
        if (input.include_current !== undefined && typeof input.include_current !== "boolean") {
          throw new Error("« include_current » doit être un booléen.");
        }
        const excludeId = includeCurrent ? undefined : scope.threadId;
        const all = this.store.listThreads();
        const threads = mine().filter((t) => !excludeId || t.id !== excludeId);
        const byId = new Map(threads.map((t) => [t.id, t]));
        const grouped = new Map<
          string,
          { thread: Thread; matches: { from: "utilisateur" | "agent"; snippet: string }[] }
        >();
        // The store gives each thread its own few matches: a thread that names the words
        // often takes no other thread's place.
        for (const hit of this.store.searchProjectItems(
          scope.projectId,
          query,
          limit,
          SEARCH_SNIPPETS_PER_THREAD,
          excludeId,
        )) {
          const thread = byId.get(hit.threadId);
          if (!thread) continue;
          let entry = grouped.get(thread.id);
          if (!entry) {
            if (grouped.size >= limit) continue;
            entry = { thread, matches: [] };
            grouped.set(thread.id, entry);
          }
          if (entry.matches.length < SEARCH_SNIPPETS_PER_THREAD) {
            entry.matches.push({
              from: hit.kind === "agent" ? "agent" : "utilisateur",
              snippet: hit.snippet,
            });
          }
        }
        if (grouped.size < limit) {
          const terms = [...new Set(fold(query).trim().split(/\s+/).filter(Boolean))].slice(0, 6);
          const byRecent = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
          for (const thread of byRecent) {
            if (grouped.size >= limit) break;
            if (grouped.has(thread.id)) continue;
            const hay = fold(`${thread.title} ${thread.summary ?? ""}`);
            if (terms.length && terms.every((term) => hay.includes(term))) {
              grouped.set(thread.id, { thread, matches: [] });
            }
          }
        }
        return [...grouped.values()].map(({ thread, matches }) => {
          const info = this.threadForCoordinator(thread, all, scope.threadId);
          return {
            thread_id: thread.id,
            title: info.title,
            state: info.state,
            ...(info.current ? { current: true } : {}),
            ...(info.branch ? { branch: info.branch } : {}),
            updated: info.updated,
            matches,
          };
        });
      }
      case "read_thread": {
        const thread = one();
        const limit = int("limit", 1, MAX_READ_MESSAGES) ?? READ_MESSAGES;
        const offset = int("offset", 0, 100_000);
        const allMessages = this.host.items(thread.id).flatMap((i) =>
          (i.kind === "user" && !i.byTeam) || i.kind === "agent"
            ? [
                {
                  from: i.kind === "agent" ? "agent" : i.from ? "coordinateur" : "utilisateur",
                  text: i.text.length > READ_CLIP ? `${i.text.slice(0, READ_CLIP)}…` : i.text,
                },
              ]
            : [],
        );
        const start =
          offset !== undefined
            ? Math.min(offset, allMessages.length)
            : Math.max(0, allMessages.length - limit);
        const end = Math.min(allMessages.length, start + limit);
        const messages = allMessages.slice(start, end);
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
          ...this.threadForCoordinator(thread, undefined, scope.threadId),
          ...(asks.length ? { asks_permission_for: asks } : {}),
          total_messages: allMessages.length,
          ...(start > 0 || end < allMessages.length ? { showing_from: start } : {}),
          last_messages: messages,
        };
      }
      case "read_memory": {
        const record = this.store.getProjectMemory(scope.projectId);
        return record.text
          ? {
              memory: record.text,
              ...(record.updatedAt ? { updated: new Date(record.updatedAt).toISOString() } : {}),
              bytes: utf8Bytes(record.text),
              max_bytes: MAX_PROJECT_MEMORY,
            }
          : {
              memory: "",
              empty: true,
              bytes: 0,
              max_bytes: MAX_PROJECT_MEMORY,
            };
      }
      case "save_memory": {
        const saveMode = str("mode", 20) ?? "append";
        if (!(MEMORY_MODES as readonly string[]).includes(saveMode)) {
          throw new Error(`« mode » doit être l'un de : ${MEMORY_MODES.join(", ")}.`);
        }
        const raw = input.content;
        if (typeof raw !== "string") throw new Error("« content » doit être un texte.");
        const normalized = raw.replace(/\r\n/g, "\n").trim();
        if (saveMode === "append" && !normalized) {
          throw new Error("« content » est requis en mode append.");
        }
        const written = () => {
          const current = this.store.getProjectMemory(scope.projectId).text;
          const next =
            saveMode === "replace"
              ? normalized
              : current
                ? `${current}\n${normalized}`
                : normalized;
          if (utf8Bytes(next) > MAX_PROJECT_MEMORY) {
            throw new Error(
              `La mémoire du projet dépasserait ${MAX_PROJECT_MEMORY} octets : lis-la avec read_memory puis condense-la avec mode « replace ».`,
            );
          }
          return next;
        };
        // What cannot be saved is refused before the user is asked anything.
        written();
        // Outside full access the user agrees to what is written. Asked here rather than left
        // to the agent, which may call its tools without asking first; the coordinator acts
        // on its own, as for its other tools.
        if (mode !== "coordinator" && caller.permissionMode !== "full") {
          const agreed = await this.host.confirmMemoryWrite(
            caller.id,
            normalized,
            saveMode === "replace",
            signal,
          );
          if (!agreed) {
            throw new Error("L'utilisateur a refusé d'enregistrer dans la mémoire du projet.");
          }
        }
        // The memory may have changed while the user was deciding.
        const saved = this.store.setProjectMemory(scope.projectId, written());
        return {
          saved: true,
          empty: !saved.text,
          bytes: utf8Bytes(saved.text),
          max_bytes: MAX_PROJECT_MEMORY,
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
        const route = routeFor(
          this.coordinatorSettings(),
          scope.projectId,
          kind as WorkKind | undefined,
        );
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
          // The route's effort comes with its model, not with one asked by name.
          ...(!asked && route?.settings ? { settings: route.settings } : {}),
          permissionMode: coordinator.permissionMode,
          isolated: true,
          title,
          text: withOrigin(brief, this.askedSince(coordinator.id), kind),
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
                team: `Équipe par défaut (« ${
                  teamPresets(this.savedPresets(), this.host.catalog.list())[0]?.label ?? ""
                } ») : l'utilisateur n'en a pas encore lancé lui-même. Dis-le-lui en une phrase ; il pourra en choisir une autre avec /equipe, ou régler ses équipes dans les Réglages.`,
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
          // In the thread's own line, with what the user wrote: kept across a restart, and
          // the user sees it wait there.
          this.host.queueMessage(thread.id, text, "coordinator");
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
