import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { DEFAULT_PARALLEL, threadGroup, threadPullRequest } from "@moonagentic/protocol";
import type {
  CustomAgentInput,
  AgentSetting,
  ClientMessage,
  Item,
  McpServerInput,
  PendingRequest,
  PermissionMode,
  Project,
  PullRequestInfo,
  ReviewFile,
  ServerMessage,
  Snapshot,
  Team,
  TeamMember,
  TeamSetup,
  CoordinatorSettings,
  WorkKind,
  TeamRole,
  Thread,
  ToolContent,
  Workspace,
} from "@moonagentic/protocol";
import type { Agents } from "./agents.ts";
import { cloneGithubRepo, githubRepos, githubStatus } from "./github.ts";
import {
  branchExists,
  commitAll,
  containsBranch,
  dropRefs,
  mergeBranch,
  nothingPast,
  unfinishedMerge,
  ensureWorktree,
  forkPoint,
  githubRemote,
  removeWorktree,
  worktreeStart,
  branchName,
  dropCheckpoints,
  isGitRepo,
  restoreCheckpoint,
  reviewChanges,
  samePath,
  saveCheckpoint,
  ship,
  type ShipResult,
} from "./git.ts";
import {
  calledSkills,
  findProjectCommands,
  findSkills,
  listFiles,
  mentionedFiles,
  promptLinks,
  searchFiles,
} from "./files.ts";
import { AgentCatalog, agentCommands } from "./catalog.ts";
import { historyBefore } from "./history.ts";
import { Planner } from "./planner.ts";
import {
  BRIDGE_BOOTSTRAP_ENV,
  BRIDGE_URL_ENV,
  COORDINATOR_TOOLS,
  MESSAGE_MODES,
  THREAD_KINDS,
} from "./coordinator-tools.ts";
import { localPullRequests, parsePullRequestUrl, type PullRequests } from "./pull-request.ts";
import { Scheduler } from "./scheduler.ts";
import { shipTarget, Teams, teamStatus } from "./team.ts";
import { mcpInfo, type McpServerRecord } from "./mcp.ts";
import { toolQuestions } from "./questions.ts";
import { AgentSession, describe, needsSignIn } from "./session.ts";
import type { Store } from "./store.ts";

export interface Client {
  send(message: ServerMessage): void;
  /** The thread whose timeline this client is showing. */
  openThreadId?: string;
}

type ToolItem = Extract<Item, { kind: "tool" }>;
type TextItem = Extract<Item, { kind: "agent" | "thought" }>;

/** How often streamed text is written down; viewers get each piece at once. */
const TEXT_FLUSH_MS = 250;

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

/** How long an agent may take to open its session before the turn gives up. */
const START_TIMEOUT_MS = 120_000;
/** An agent with nothing to do is stopped after this long; its session resumes next time. */
const IDLE_MS = 10 * 60_000;
/** Agents kept running at once; past it, the one left alone longest is stopped first. */
const MAX_LIVE_AGENTS = 8;

export interface HubOptions {
  /** Where threads with their own branch get their worktree. */
  worktreesDir: string;
  homeDir?: string;
  idleMs?: number;
  maxLiveAgents?: number;
  /** Where pull requests are read and merged; the user's own `gh` unless given. */
  pullRequests?: () => PullRequests | undefined;
  /** How often known pull requests are asked about again; 0 for never. */
  prWatchMs?: number;
}

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

/** The setting that lists the projects kept at the top. */
const PINNED_PROJECTS = "pinnedProjects";

/** The level a coordinator starts on, as agents name it. */
const LOW_EFFORT = /^(low|bas)$/i;

/** Told to a thread's agent before a coordinator's message, so it knows who speaks. */
const FROM_COORDINATOR =
  "Le message qui suit vient du coordinateur du projet : un agent qui répartit les demandes de l'utilisateur, pas l'utilisateur lui-même. Seule la partie « Message d'origine de l'utilisateur », quand elle est là, est de sa main.";

/** The coordinator's tools that change something: only while it answers the user. */
const WRITES = new Set(["open_thread", "start_team", "message_thread", "resolve_thread"]);
/** A permission asked for one of MoonAgentic's own tools, as agents name the tools of an MCP server. */
const OWN_TOOL = new RegExp(
  `^mcp__moonagentic__(${COORDINATOR_TOOLS.map((t) => t.name).join("|")})$`,
);

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

Après un outil, dis en une phrase ce que tu as fait. Reste bref : pas de plan, pas de récapitulatif. Réponds dans la langue de l'utilisateur.`;

/** A known, open pull request is asked about again this often. */
const PR_WATCH_MS = 60_000;
/** Characters kept of what an agent last said, for lists of threads. */
const SUMMARY_LIMIT = 160;

/** The first lines of a reply as one short line, without Markdown marks. */
export function summaryOf(reply: string): string {
  const flat = reply
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[*`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : flat;
}

const settingValues = (settings: AgentSetting[]) =>
  settings.length ? Object.fromEntries(settings.map((s) => [s.id, s.current])) : undefined;

/** Keeps a message's checkpoint from git's garbage collection, out of sight of branches. */
const checkpointRef = (threadId: string, itemId: string) =>
  `refs/moonagentic/${threadId}/${itemId.replace(/^user:/, "")}`;
/** Keeps the files of an archived thread, uncommitted ones included, until it comes back. */
const archiveRef = (threadId: string) => `refs/moonagentic/${threadId}/archive`;

/** The folder the agent works in: the worktree, or the project's folder inside it. */
const workFolder = (workspace: Workspace) =>
  workspace.subdir ? path.join(workspace.path, workspace.subdir) : workspace.path;

/** What a team's reviewer never does on its own, whatever its access: it reads, it does not change. */
const READ_ONLY_REFUSED = new Set(["edit", "delete", "move"]);

const TEAM_AT_WORK = "Cette équipe travaille encore : arrête-la d'abord.";

/** A step back under way, kept until it is done so a stop in the middle is finished later. */
type PendingRestore = { itemId: string; tree: string };

/** A coordinator's call that came with no token of this server's: answered 401. */
export class CoordinatorRefused extends Error {
  constructor() {
    super("Accès refusé.");
  }
}

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
  /** Projects being removed, which take no new thread meanwhile. */
  private readonly removingProjects = new Set<string>();
  /** The text each thread's agent is streaming, ahead of what is written down. */
  private readonly drafts = new Map<
    string,
    { item: TextItem; dirty: boolean; timer?: NodeJS.Timeout }
  >();
  /** Stops each idle agent when its time is up. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** When each running agent last finished a turn, to stop the one left alone longest. */
  private readonly lastUsed = new Map<string, number>();
  /** Agents being stopped for a pause: the thread's next agent starts once they are gone. */
  private readonly pausing = new Map<string, Promise<void>>();
  private readonly idleMs: number;
  private useSeq = 0;
  private closed = false;
  private readonly maxLiveAgents: number;

  /** The user's home folder, where agents keep their personal skills. */
  private readonly homeDir: string;
  private readonly pullRequests: () => PullRequests | undefined;
  /** What each coordinator's bridge may reach, by its token: one project, kept in memory only. */
  private readonly coordinatorTokens = new Map<string, { projectId: string; threadId: string }>();
  /** What each bridge was started with: traded once for a token, then worth nothing. */
  private readonly coordinatorBootstraps = new Map<
    string,
    { projectId: string; threadId: string }
  >();
  /** What the user last wrote to each coordinator, joined to the threads it opens for it. */
  private readonly lastAsked = new Map<string, string>();
  /** Messages a coordinator left for a thread at work, given when its turn ends. */
  private readonly queued = new Map<string, string[]>();
  /** The tool behind each call of a turn, by thread, for agents that name it. */
  private readonly toolNames = new Map<string, Map<string, string>>();
  /** Threads each coordinator opened while answering the current message. */
  private readonly openedThisTurn = new Map<string, number>();
  /** Where this server answers a coordinator's bridge, once it listens. */
  coordinatorUrl: string | undefined;
  /** True while known pull requests are being asked about, so rounds never pile up. */
  private watching = false;
  private readonly prTimer: NodeJS.Timeout | undefined;

  constructor(store: Store, agents: Agents, options: HubOptions) {
    this.store = store;
    this.agents = agents;
    this.worktreesDir = options.worktreesDir;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.maxLiveAgents = Math.max(1, options.maxLiveAgents ?? MAX_LIVE_AGENTS);
    this.homeDir = options.homeDir ?? os.homedir();
    this.pullRequests = options.pullRequests ?? localPullRequests;
    const watchMs = options.prWatchMs ?? PR_WATCH_MS;
    if (watchMs > 0) {
      this.prTimer = setInterval(() => void this.watchPullRequests(), watchMs);
      this.prTimer.unref();
    }
    this.catalog = new AgentCatalog(store, agents, (m) => this.broadcast(m), this.homeDir);
    this.planner = new Planner(store, (m) => this.broadcast(m));
    this.scheduler = new Scheduler(store, (m) => this.broadcast(m), {
      start: (s) =>
        this.createThread({
          projectId: s.projectId,
          agentId: s.agentId,
          permissionMode: s.permissionMode,
          model: s.model,
          isolated: s.isolated,
          title: s.title,
          text: s.text,
        }),
      running: (id) => this.turns.has(id),
    });
    this.teams = new Teams({
      thread: (id) => this.store.getThread(id),
      threads: () => this.store.listThreads(),
      createThread: (input) => this.createThread({ ...input, byTeam: true }),
      send: (id, text) => this.send(id, text, undefined, true),
      cancel: (id) => this.cancel(id),
      setTeam: (id, team) => {
        this.updateThread(id, { team });
        const lead = this.store.getThread(id);
        if (lead) this.planner.syncTeam(lead);
        // A team that stops working frees its place: its last turn was a member's, which
        // no coordinator opened, so the line is looked at from here.
        if (lead?.openedBy && !this.closed) this.drainLine(lead.openedBy);
      },
      mergeInto: (intoId, fromId, title) => this.mergeInto(intoId, fromId, title),
      ship: (id, message, title, body) => this.ship(id, message, true, undefined, title, body),
      contains: async (intoId, fromId) => {
        const into = this.store.getThread(intoId)?.workspace;
        const from = this.store.getThread(fromId)?.workspace;
        if (!into?.base || !from || !existsSync(into.path)) return false;
        return containsBranch(into.path, from.branch);
      },
      unfinishedMerge: async (id) => {
        const workspace = this.store.getThread(id)?.workspace;
        if (!workspace?.base || !existsSync(workspace.path)) return undefined;
        return unfinishedMerge(workspace.path);
      },
      changes: async (id) => {
        const workspace = this.store.getThread(id)?.workspace;
        if (!workspace?.base || !existsSync(workspace.path)) return { files: [] };
        return reviewChanges(workspace.path, workspace.base);
      },
      lastReply: (id) => this.lastReply(id),
    });
    store.recoverAfterRestart();
    this.teams.recover();
    this.recovered = this.finishRestores();
    // Tasks that were due while the server was off start once what was interrupted is put right.
    void this.recovered.then(() => {
      if (!this.closed) this.scheduler.start();
    });
  }

  /** The agents, their models and checks, the MCP servers and the favorites. */
  readonly catalog: AgentCatalog;
  /** Each project's planner. */
  readonly planner: Planner;
  /** The tasks planned for later. */
  readonly scheduler: Scheduler;
  /** Teams of agents, each run from its lead's thread. */
  readonly teams: Teams;

  /** Resolves once the steps back that a stop interrupted are finished. */
  readonly recovered: Promise<void>;

  connect(client: Client): () => void {
    this.clients.add(client);
    client.send({ type: "snapshot", snapshot: this.snapshot() });
    return () => this.clients.delete(client);
  }

  snapshot(): Snapshot {
    return {
      coordinator: this.coordinatorSettings(),
      favorites: this.catalog.favorites(),
      requests: this.pendingRequests(),
      mcpServers: this.catalog.mcpServers().map(mcpInfo),
      agents: this.catalog.list(),
      projects: this.store.listProjects().map((p) => this.withGit(p)),
      threads: this.store.listThreads(),
      plan: this.planner.list(),
      schedules: this.scheduler.list(),
    };
  }

  async handle(client: Client, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "project.create": {
        const id = this.createProject(message.name, message.path);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "project.clone": {
        const { dest, name, existing } = await cloneGithubRepo(message);
        const known = existing
          ? this.store.listProjects().find((p) => {
              try {
                return samePath(p.path, dest);
              } catch {
                return false; // a project whose folder is gone
              }
            })
          : undefined;
        const id = known?.id ?? this.createProject(name, dest);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "github.status":
        client.send({ type: "github", requestId: message.requestId, status: await githubStatus() });
        return;
      case "workspace.pr":
      case "workspace.mergePr":
      case "github.pr": {
        // Whoever asked waits for this reply, so a failure is sent to it rather than thrown.
        const asked =
          message.type === "workspace.pr"
            ? this.pullRequest(message.threadId)
            : message.type === "workspace.mergePr"
              ? this.mergePullRequest(message.threadId, message.number, message.head)
              : this.pullRequestAt(message.url);
        client.send(
          await asked.then(
            (pr) => ({ type: "pullRequest", requestId: message.requestId, ...(pr ? { pr } : {}) }),
            (error: unknown) => ({
              type: "pullRequest",
              requestId: message.requestId,
              error: describe(error),
            }),
          ),
        );
        return;
      }
      case "github.repos":
        client.send({
          type: "githubRepos",
          requestId: message.requestId,
          repos: await githubRepos(),
        });
        return;
      case "thread.create": {
        const id = this.createThread(message);
        client.openThreadId = id;
        client.send({ type: "created", requestId: message.requestId, id });
        client.send({ type: "items", threadId: id, items: this.items(id) });
        return;
      }
      case "thread.leave":
        if (client.openThreadId === message.threadId) delete client.openThreadId;
        return;
      case "thread.setUnread":
        this.requireThread(message.threadId);
        this.updateThread(message.threadId, { unread: message.unread });
        return;
      case "project.markRead":
        for (const t of this.store.listThreads()) {
          if (t.projectId === message.projectId && t.unread) {
            this.updateThread(t.id, { unread: false });
          }
        }
        return;
      case "thread.open":
        client.openThreadId = message.threadId;
        // Opened: read.
        if (this.store.getThread(message.threadId)?.unread) {
          this.updateThread(message.threadId, { unread: false });
        }
        client.send({
          type: "items",
          threadId: message.threadId,
          items: this.items(message.threadId),
        });
        return;
      case "thread.send": {
        // Written to by hand, a thread waiting in line starts now, its brief first.
        const held = this.store.getThread(message.threadId)?.held;
        this.send(
          message.threadId,
          held ? `${held}\n\n${message.text}` : message.text,
          this.leadContext(message.threadId) ??
            this.coordinatorContext(message.threadId, message.text),
        );
        // Only once it is sent: a refusal keeps the brief where it was.
        if (held) this.updateThread(message.threadId, { held: null });
        return;
      }
      case "coordinator.open": {
        const id = this.openCoordinator(message.projectId, message.agentId, message.model);
        client.openThreadId = id;
        client.send({ type: "created", requestId: message.requestId, id });
        client.send({ type: "items", threadId: id, items: this.items(id) });
        return;
      }
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
      case "thread.setArchived":
        await this.setArchived(message.threadId, message.archived);
        return;
      case "thread.delete":
        await this.deleteThread(message.threadId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "project.rename": {
        if (!this.store.getProject(message.projectId)) throw new Error("Ce projet n'existe plus.");
        this.store.renameProject(message.projectId, message.name);
        const project = this.store.getProject(message.projectId)!;
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
      case "project.setPinned": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        const others = this.store
          .getSetting<string[]>(PINNED_PROJECTS, [])
          // Projects removed since are dropped on the way.
          .filter((p) => p !== project.id && this.store.getProject(p));
        this.store.setSetting(PINNED_PROJECTS, message.pinned ? [...others, project.id] : others);
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
      case "project.remove":
        await this.removeProject(message.projectId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "coordinator.setRoute": {
        const settings = this.coordinatorSettings();
        const routes = { ...settings.routes };
        delete routes[message.kind];
        if (message.agentId) {
          // Refused now rather than at the first thread a coordinator opens with it.
          this.agents.launch(message.agentId);
          routes[message.kind] = {
            agentId: message.agentId,
            ...(message.model ? { model: message.model } : {}),
          };
        }
        this.setCoordinatorSettings({ ...settings, routes });
        return;
      }
      case "coordinator.setParallel":
        this.setCoordinatorSettings({
          ...this.coordinatorSettings(),
          parallel: message.parallel,
        });
        // More places: the threads already in line take them now.
        for (const t of this.store.listThreads()) {
          if (t.kind === "coordinator") this.drainLine(t.id);
        }
        return;
      case "team.start": {
        const id = this.startTeam(message);
        // Kept as the team a coordinator starts when it is asked for one.
        this.setCoordinatorSettings({
          ...this.coordinatorSettings(),
          team: {
            lead: message.lead,
            coder: message.coder,
            ...(message.reviewer ? { reviewer: message.reviewer } : {}),
            ...(message.tester ? { tester: message.tester } : {}),
            ...(message.merger ? { merger: message.merger } : {}),
            coders: message.coders,
            permissionMode: message.permissionMode,
            ...(message.autoShip === false ? { autoShip: false } : {}),
          } as TeamSetup,
        });
        client.openThreadId = id;
        client.send({ type: "created", requestId: message.requestId, id });
        client.send({ type: "items", threadId: id, items: this.items(id) });
        return;
      }
      case "team.stop":
        await this.teams.stop(message.threadId);
        return;
      case "team.ship":
        await this.teams.ship(message.threadId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "team.retry":
        await this.teams.retry(message.threadId, message.index);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "plan.add": {
        if (!this.store.getProject(message.projectId)) throw new Error("Projet introuvable.");
        const { id } = this.planner.add(message);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "plan.update":
        this.planner.update(message.id, message);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "plan.remove":
        this.planner.remove(message.id);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "schedule.add": {
        if (!this.store.getProject(message.projectId)) throw new Error("Projet introuvable.");
        // Checked now, so a missing agent is said at once rather than at the task's time.
        this.agents.launch(message.agentId);
        const { id } = this.scheduler.add(message);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "schedule.update":
        this.scheduler.update(message.id, message);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "schedule.remove":
        this.scheduler.remove(message.id);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "schedule.run": {
        const id = this.scheduler.runNow(message.id);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "thread.setPinned":
        this.requireThread(message.threadId);
        this.updateThread(message.threadId, { pinned: message.pinned });
        return;
      case "files.search": {
        const dir = this.folderOf(message.projectId, message.threadId);
        const files = searchFiles(await listFiles(dir), message.query);
        client.send({ type: "files", requestId: message.requestId, files });
        return;
      }
      case "composer.catalog": {
        const dir = this.folderOf(message.projectId, message.threadId);
        client.send({
          type: "catalog",
          requestId: message.requestId,
          skills: findSkills(dir, this.homeDir).map(({ file: _file, ...skill }) => skill),
          commands: findProjectCommands(dir),
        });
        return;
      }
      case "search":
        client.send({
          type: "searched",
          requestId: message.requestId,
          hits: (this.flushAll(), this.store.searchItems(message.query)),
        });
        return;
      case "favorites.toggle":
        this.catalog.toggleFavorite(message.agentId, message.model, message.starred);
        return;
      case "mcp.add": {
        const id = this.catalog.addMcpServer(message.server);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "mcp.setEnabled":
        this.catalog.setMcpEnabled(message.id, message.enabled);
        return;
      case "mcp.remove":
        this.catalog.removeMcpServer(message.id);
        return;
      case "workspace.review":
        // The panel waits for this reply, so a failure is sent to it rather than thrown.
        client.send(
          await this.review(message.threadId).then(
            ({ files, omitted }) => ({
              type: "review",
              threadId: message.threadId,
              files,
              ...(omitted ? { omitted } : {}),
            }),
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
        const result = await this.ship(
          message.threadId,
          message.message,
          message.pr,
          message.files,
        );
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
      case "agent.addCustom": {
        const id = this.catalog.addCustomAgent(message.agent);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "agent.removeCustom":
        this.catalog.removeCustomAgent(message.agentId);
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
    /** Otherwise taken from the first line of the text. */
    title?: string | undefined;
    parentId?: string | undefined;
    role?: TeamRole | undefined;
    /** Works in that thread's folder: a team's reviewer or tester. */
    worksIn?: string | undefined;
    team?: Team | undefined;
    /** The first message is the team engine's, not the user's. */
    byTeam?: boolean | undefined;
    /** The coordinator that opened it. */
    openedBy?: string | undefined;
    taskKey?: string | undefined;
    /** Kept in line: the text is given later, once its coordinator has a place free. */
    held?: boolean | undefined;
  }): string {
    const project = this.store.getProject(input.projectId);
    if (!project || this.removingProjects.has(project.id)) throw new Error("Projet introuvable.");
    this.agents.launch(input.agentId);
    const now = Date.now();
    const id = randomUUID();
    const title = titleFrom(input.title ?? input.text);
    // The worktree itself is made when the agent first starts, so creating stays instant.
    const workspace =
      input.isolated && !input.worksIn && this.withGit(project).git
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
      ...(input.openedBy ? { openedBy: input.openedBy } : {}),
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.held && input.text ? { held: input.text } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.worksIn ? { worksIn: input.worksIn } : {}),
      ...(input.team ? { team: input.team } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.addThread(thread);
    this.broadcast({ type: "thread", thread });
    // A team's merge thread starts with no message: its branch is filled first.
    if (input.text && !input.held) {
      if (input.openedBy) this.sendFromCoordinator(thread.id, input.text, input.byTeam);
      else this.send(thread.id, input.text, undefined, input.byTeam);
    }
    return thread.id;
  }

  /** Starts a team on the task; returns its lead's thread. */
  startTeam(input: {
    projectId: string;
    task: string;
    lead: { agentId: string; model?: string | undefined };
    coder: { agentId: string; model?: string | undefined };
    reviewer?: { agentId: string; model?: string | undefined } | undefined;
    tester?: { agentId: string; model?: string | undefined } | undefined;
    merger?: { agentId: string; model?: string | undefined } | undefined;
    coders: number;
    permissionMode: PermissionMode;
    autoShip?: boolean | undefined;
    openedBy?: string | undefined;
    taskKey?: string | undefined;
  }): string {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error("Projet introuvable.");
    // Coders work at once: each needs its own branch, or they would write over each other.
    if (!this.withGit(project).git) {
      throw new Error(
        "Une équipe a besoin d'un dépôt git : chaque codeur y travaille sur sa branche.",
      );
    }
    // Checked before anything starts, so a missing agent fails the whole team at once.
    const member = (m: { agentId: string; model?: string | undefined }): TeamMember => {
      this.agents.launch(m.agentId);
      return { agentId: m.agentId, ...(m.model ? { model: m.model } : {}) };
    };
    return this.teams.start({
      ...input,
      lead: member(input.lead),
      coder: member(input.coder),
      reviewer: input.reviewer && member(input.reviewer),
      tester: input.tester && member(input.tester),
      merger: input.merger && member(input.merger),
    });
  }

  /** How coordinators route work, as set in the settings. */
  coordinatorSettings(): CoordinatorSettings {
    return this.store.getSetting<CoordinatorSettings>("coordinator", { routes: {} });
  }

  private setCoordinatorSettings(settings: CoordinatorSettings): void {
    this.store.setSetting("coordinator", settings);
    this.broadcast({ type: "coordinatorSettings", settings });
  }

  /** The project's coordinator, made with this agent when the project has none yet. */
  openCoordinator(projectId: string, agentId: string, model?: string): string {
    const known = this.store
      .listThreads()
      .find((t) => t.projectId === projectId && t.kind === "coordinator");
    if (known) return known.id;
    const project = this.store.getProject(projectId);
    if (!project || this.removingProjects.has(projectId)) throw new Error("Projet introuvable.");
    this.agents.launch(agentId);
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
    this.broadcast({ type: "thread", thread });
    return thread.id;
  }

  /** For the user writing to a coordinator: its part, given before the message. */
  private coordinatorContext(threadId: string, text: string): string | undefined {
    const thread = this.store.getThread(threadId);
    if (thread?.kind !== "coordinator") return undefined;
    this.openedThisTurn.delete(threadId);
    this.lastAsked.set(threadId, text);
    return coordinatorPrompt(this.store.getProject(thread.projectId)?.name ?? "");
  }

  /** Forgets every access given to a coordinator's bridge so far. */
  private dropCoordinatorAccess(threadId: string): void {
    for (const held of [this.coordinatorTokens, this.coordinatorBootstraps]) {
      for (const [token, scope] of held) if (scope.threadId === threadId) held.delete(token);
    }
  }

  /**
   * The MCP server given to a coordinator's agent. Its environment only holds what the
   * bridge trades, once, for its token: a command the agent runs later finds nothing to use.
   */
  private coordinatorServer(thread: Thread): McpServerRecord[] {
    if (thread.kind !== "coordinator" || !this.coordinatorUrl) return [];
    this.dropCoordinatorAccess(thread.id);
    const bootstrap = randomBytes(32).toString("base64url");
    this.coordinatorBootstraps.set(bootstrap, { projectId: thread.projectId, threadId: thread.id });
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
            { name: BRIDGE_URL_ENV, value: this.coordinatorUrl },
            { name: BRIDGE_BOOTSTRAP_ENV, value: bootstrap },
          ],
        },
      },
    ];
  }

  /** The bridge's first call: what it was started with, once, for the token of its project. */
  coordinatorExchange(bootstrap: string): string {
    const scope = this.coordinatorBootstraps.get(bootstrap);
    if (!scope) throw new CoordinatorRefused();
    this.dropCoordinatorAccess(scope.threadId);
    const token = randomBytes(32).toString("base64url");
    this.coordinatorTokens.set(token, scope);
    return token;
  }

  /** A coordinator's words to a thread: marked as its own, and said to be an agent's. */
  private sendFromCoordinator(threadId: string, text: string, byTeam?: boolean): void {
    const lead = this.leadContext(threadId);
    this.send(
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
          (this.turns.has(t.id) ||
            (t.team && ["planning", "coding", "merging"].includes(t.team.phase))),
      ).length;
  }

  private parallel(): number {
    return this.coordinatorSettings().parallel ?? DEFAULT_PARALLEL;
  }

  /** Starts the threads waiting in line behind a coordinator, oldest first, while it has places free. */
  private drainLine(coordinatorId: string): void {
    const waiting = this.store
      .listThreads()
      .filter((t) => t.openedBy === coordinatorId && t.held && !t.archived)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const next of waiting) {
      if (this.atWork(coordinatorId) >= this.parallel()) return;
      const brief = next.held!;
      try {
        this.sendFromCoordinator(next.id, brief);
        this.updateThread(next.id, { held: null });
      } catch {
        // Busy for a moment, with a step back or a change of setting: it keeps its place
        // and its brief, and is tried again when the next place frees.
        continue;
      }
    }
  }

  /** Gives a thread whose turn just ended what a coordinator left for it meanwhile. */
  private sendQueued(threadId: string): void {
    const waiting = this.queued.get(threadId);
    if (!waiting?.length || this.turns.has(threadId)) return;
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
  async coordinatorCall(token: string, tool: string, args: unknown): Promise<unknown> {
    const scope = this.coordinatorTokens.get(token);
    const coordinator = scope && this.store.getThread(scope.threadId);
    if (!scope || coordinator?.kind !== "coordinator") throw new CoordinatorRefused();
    if (!COORDINATOR_TOOLS.some((t) => t.name === tool)) throw new Error(`Outil inconnu : ${tool}`);
    // It acts for the message it is answering: a bridge left behind changes nothing later.
    if (WRITES.has(tool) && !this.turns.has(coordinator.id))
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
        const messages = this.items(thread.id)
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
        const asks = this.pendingRequests()
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
        // Asked by name, else where the settings send this kind of work, else its own agent.
        const route = kind ? this.coordinatorSettings().routes[kind as WorkKind] : undefined;
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
        const id = this.createThread({
          projectId: scope.projectId,
          agentId,
          model,
          permissionMode: coordinator.permissionMode,
          isolated: true,
          title,
          text: withOrigin(brief, this.lastAsked.get(coordinator.id)),
          openedBy: coordinator.id,
          taskKey,
          // Past what it may run at once, the thread waits in line, in plain sight.
          held: this.atWork(coordinator.id) >= this.parallel(),
        });
        this.openedThisTurn.set(coordinator.id, opened + 1);
        this.putItem(coordinator.id, {
          id: `opened:${id}`,
          kind: "opened",
          threadId: id,
          title: this.requireThread(id).title,
          at: Date.now(),
        });
        const made = this.requireThread(id);
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
        const setup = this.coordinatorSettings().team;
        if (!setup)
          throw new Error(
            "Aucune équipe n'est réglée : l'utilisateur doit en lancer une lui-même une première fois (commande /equipe), elle servira ensuite de modèle. Dis-le-lui, ou ouvre un fil simple avec open_thread.",
          );
        const opened = this.openedThisTurn.get(coordinator.id) ?? 0;
        if (opened >= MAX_OPENED_PER_TURN)
          throw new Error(
            `Tu as déjà ouvert ${opened} fils pour ce message : demande à l'utilisateur avant d'en ouvrir d'autres.`,
          );
        const id = this.startTeam({
          ...setup,
          projectId: scope.projectId,
          task: withOrigin(task, this.lastAsked.get(coordinator.id)),
          openedBy: coordinator.id,
          taskKey,
        });
        this.openedThisTurn.set(coordinator.id, opened + 1);
        this.putItem(coordinator.id, {
          id: `opened:${id}`,
          kind: "opened",
          threadId: id,
          title: this.requireThread(id).title,
          at: Date.now(),
        });
        return { opened: this.threadForCoordinator(this.requireThread(id)) };
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
          this.updateThread(thread.id, { held: `${thread.held}\n\n${text}` });
          return { queued_for: thread.title, delivered: "au démarrage du fil en file" };
        }
        if (!this.turns.has(thread.id)) {
          this.sendFromCoordinator(thread.id, text);
          return { sent_to: thread.title };
        }
        if (mode === "queue") {
          this.queued.set(thread.id, [...(this.queued.get(thread.id) ?? []), text]);
          return { queued_for: thread.title, delivered: "à la fin du tour en cours" };
        }
        // A team's pieces are run by the server: cutting its lead would leave them adrift.
        if (thread.team) throw new Error("Une équipe ne se coupe pas : utilise le mode queue.");
        await this.cancel(thread.id);
        await this.whenIdle(thread.id);
        this.sendFromCoordinator(thread.id, text);
        return { sent_to: thread.title, interrupted: true };
      }
      case "resolve_thread": {
        const thread = one();
        await this.setArchived(thread.id, true);
        return { resolved: thread.title };
      }
      default:
        throw new Error(`Outil inconnu : ${tool}`);
    }
  }

  /**
   * For the user writing to a team's lead: the team's real state, given before the message.
   * The server runs the pieces, so the lead would otherwise know nothing past its plan.
   */
  private leadContext(threadId: string): string | undefined {
    const thread = this.store.getThread(threadId);
    if (thread?.role !== "lead" || !thread.team) return undefined;
    return teamStatus(thread.team, Date.now(), (id) => this.lastReply(id));
  }

  /** Everything the agent said in the thread's last turn. */
  private lastReply(threadId: string): string {
    const items = this.items(threadId);
    return items
      .slice(items.findLastIndex((i) => i.kind === "user") + 1)
      .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
      .join("\n");
  }

  /**
   * Sends the user's message to the thread's agent; `context` goes before it, unseen.
   * `byTeam` marks a message the team's engine wrote, which the app keeps out of sight.
   */
  send(
    threadId: string,
    text: string,
    context?: string,
    byTeam?: boolean,
    from?: "coordinator",
  ): void {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    const busy = this.busy.get(threadId);
    if (busy) throw new Error(busy);
    // A step back left over from a failure must never replay over the turns that follow.
    if (this.pendingRestores()[threadId]) this.setPendingRestore(threadId, undefined);
    const itemId = `user:${randomUUID()}`;
    this.putItem(threadId, {
      id: itemId,
      kind: "user",
      text,
      ...(byTeam ? { byTeam: true as const } : {}),
      ...(from ? { from } : {}),
      at: Date.now(),
    });
    this.updateThread(threadId, { status: "running", error: null });
    this.turnIds.set(threadId, randomUUID());
    this.cancelled.delete(threadId);
    this.clearIdle(threadId);
    const turn = this.runTurn(thread, text, itemId, context).finally(() => {
      const cancelled = this.cancelled.has(threadId);
      this.turns.delete(threadId);
      this.turnIds.delete(threadId);
      this.cancelled.delete(threadId);
      this.toolNames.delete(threadId);
      this.flushText(threadId);
      this.leftIdle(threadId);
      if (!this.closed) {
        const summary = summaryOf(this.lastReply(threadId));
        const now = this.store.getThread(threadId);
        if (summary && now && now.summary !== summary) this.updateThread(threadId, { summary });
        // Answered with no window on it: unread, until it is opened. A team's members are
        // read through their lead, and a coordinator on its project's page.
        const seen = [...this.clients].some((c) => c.openThreadId === threadId);
        if (summary && now && !seen && !cancelled && !now.parentId && now.kind !== "coordinator") {
          this.updateThread(threadId, { unread: true });
        }
      }
      // Last, so the team can give the thread its next message. A server stopping leaves
      // its teams as they are, for the next start to find them cut short.
      try {
        if (!this.closed) this.teams.turnEnded(threadId, cancelled);
      } catch (error) {
        console.error("Équipe :", error);
      }
      // A turn the user stopped starts nothing by itself: what waits goes after the next one.
      if (!this.closed && !cancelled) this.sendQueued(threadId);
      // A place is free: the next thread in line behind the same coordinator starts.
      const openedBy = this.closed ? undefined : this.store.getThread(threadId)?.openedBy;
      if (openedBy) this.drainLine(openedBy);
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
    const thread = this.requireLiveThread(threadId);
    // Many agents mishandle a settings change in the middle of a prompt.
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer de modèle.");
    // A message sent meanwhile waits: the agent never gets a prompt in the middle of it.
    await this.exclusive(threadId, "Attends la fin du changement de modèle.", async () => {
      const session = await this.sessions.get(threadId)?.catch(() => undefined);
      const choices = session?.model?.choices ?? this.store.getAgentModels(thread.agentId)?.models;
      if (!choices?.some((c) => c.id === model)) throw new Error("Modèle inconnu.");
      if (session?.model) {
        await session.setModel(model);
        // A new model can bring other effort levels, for the picker too.
        this.catalog.learn(thread.agentId, session.model, session.settings, false);
      }
      const settings = session && settingValues(session.settings);
      this.updateThread(threadId, {
        model: session?.model?.current ?? model,
        ...(settings ? { settings } : {}),
      });
    });
  }

  /** Changes one of the agent's settings, such as its mode, between turns. */
  async setSetting(threadId: string, settingId: string, value: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer ce réglage.");
    await this.exclusive(threadId, "Attends la fin du changement de réglage.", async () => {
      const session = await this.sessions.get(threadId)?.catch(() => undefined);
      const offered = session?.settings ?? this.store.getAgentModels(thread.agentId)?.settings;
      const setting = offered?.find((s) => s.id === settingId);
      if (!setting?.choices.some((c) => c.id === value)) throw new Error("Réglage inconnu.");
      if (session) {
        await session.setSetting(settingId, value);
        this.catalog.learn(thread.agentId, session.model, session.settings, false);
      }
      // One change can move others, so a running agent's own values win.
      const settings = (session && settingValues(session.settings)) ?? {
        ...this.requireThread(threadId).settings,
        [settingId]: value,
      };
      this.updateThread(threadId, { settings });
    });
  }

  /** The thread's changes since its branch started, for review before shipping. */
  async review(threadId: string): Promise<{ files: ReviewFile[]; omitted?: number }> {
    const workspace = this.requireLiveThread(threadId).workspace;
    if (!workspace?.base) return { files: [] };
    return reviewChanges(workspace.path, workspace.base);
  }

  /**
   * Commits the thread's changes (only `files` when given), pushes its branch and opens a
   * pull request if asked.
   */
  async ship(
    threadId: string,
    message: string,
    pr: boolean,
    files?: string[],
    /** The pull request's title; otherwise the thread's. */
    title?: string,
    body?: string,
  ): Promise<ShipResult> {
    const thread = this.requireLiveThread(threadId);
    const workspace = thread.workspace;
    if (!workspace?.base)
      throw new Error("Ce fil travaille dans le dossier du projet, sans branche à lui.");
    return this.exclusive(threadId, "Attends la fin de l'envoi de la branche.", async () => {
      const result = await ship(workspace.path, {
        branch: workspace.branch,
        message,
        pr,
        title: title ?? thread.title,
        ...(body ? { body } : {}),
        ...(files ? { files } : {}),
        ...(workspace.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
      });
      // A link to open a pull request never replaces one that is already open.
      if (result.url && !(workspace.prOpened && !result.prOpened)) {
        this.updateThread(threadId, {
          workspace: { ...workspace, prUrl: result.url, prOpened: result.prOpened },
        });
      }
      return result;
    }).then((result) => {
      // Its pull request shows on the lists at once, without waiting for the next round.
      if (result.prOpened && !this.closed) {
        const asked = this.pullRequest(threadId).catch(() => undefined);
        this.steps.add(asked);
        void asked.finally(() => this.steps.delete(asked));
      }
      return result;
    });
  }

  /** Where a thread's branch is pushed, and what can ask GitHub about it; nothing without both. */
  private async branchOnGithub(
    threadId: string,
  ): Promise<{ github: PullRequests; repo: string; branch: string } | undefined> {
    const thread = this.requireThread(threadId);
    const workspace = thread.workspace;
    if (!workspace?.base) return undefined;
    // An archived thread has no folder of its own left: its project has the same remotes.
    const dir = existsSync(workspace.path)
      ? workspace.path
      : this.store.getProject(thread.projectId)?.path;
    const repo = dir ? await githubRemote(dir) : undefined;
    const github = repo ? this.pullRequests() : undefined;
    return repo && github ? { github, repo, branch: workspace.branch } : undefined;
  }

  /** The pull request of the thread's branch as GitHub describes it now, whoever opened it. */
  async pullRequest(threadId: string): Promise<PullRequestInfo | undefined> {
    const on = await this.branchOnGithub(threadId);
    const pr = await on?.github.find(on.repo, on.branch);
    if (on) await this.notePullRequest(threadId, pr);
    return pr;
  }

  /**
   * Keeps what lists of threads show of the pull request. One that has just been merged
   * resolves its thread, when its folder holds nothing more than what was merged.
   */
  private async notePullRequest(threadId: string, info: PullRequestInfo | undefined) {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const pr = info && threadPullRequest(info);
    // A team's pull request is its merge thread's, or its only coder's: the lead shows it,
    // and is the one resolved, which puts the whole team away.
    const parent = thread.parentId ? this.store.getThread(thread.parentId) : undefined;
    const lead = parent?.team && shipTarget(parent.team) === threadId ? parent : undefined;
    if (lead && JSON.stringify(pr) !== JSON.stringify(lead.pr)) {
      this.updateThread(lead.id, { pr: pr ?? null });
    }
    if (JSON.stringify(pr) === JSON.stringify(thread.pr)) return;
    // Merged since it was last seen open; or merged before it was ever asked about, when
    // MoonAgentic opened it itself.
    const merged =
      pr?.state === "merged" &&
      (thread.pr ? thread.pr.state !== "merged" : !!thread.workspace?.prOpened);
    this.updateThread(threadId, { pr: pr ?? null });
    if (!merged || !info) return;
    // A member that is not its team's branch is never resolved on its own.
    if (thread.parentId && !lead) return;
    const target = lead ?? thread;
    if (target.archived || thread.archived) return;
    const atWork = (id: string) => this.turns.has(id) || this.busy.has(id);
    if (atWork(threadId) || atWork(target.id) || this.teams.isActive(target.id)) return;
    const path = thread.workspace?.path;
    if (!path || !existsSync(path) || !(await nothingPast(path, info.head))) return;
    await this.setArchived(target.id, true).catch((error) =>
      console.error("Résolution après merge :", error),
    );
  }

  /**
   * Asks GitHub again about the pull requests already known and not yet closed, one thread
   * at a time: never about every branch, which would be slow and spend the user's quota.
   */
  async watchPullRequests(): Promise<void> {
    if (this.watching || this.closed) return;
    this.watching = true;
    try {
      for (const thread of this.store.listThreads()) {
        if (this.closed) return;
        const known = thread.pr
          ? thread.pr.state === "open" || thread.pr.state === "draft"
          : !!thread.workspace?.prOpened;
        if (!known || thread.archived || !thread.workspace?.base) continue;
        await this.pullRequest(thread.id).catch(() => undefined);
      }
    } finally {
      this.watching = false;
    }
  }

  /**
   * Merges the pull request of the thread's branch, when it is still the one the user saw:
   * same number, same last commit. Returns it as it is afterwards.
   */
  async mergePullRequest(
    threadId: string,
    number: number,
    head: string,
  ): Promise<PullRequestInfo | undefined> {
    const on = await this.branchOnGithub(threadId);
    if (!on) throw new Error("GitHub CLI (gh) est requis pour merger depuis MoonAgentic.");
    const pr = await on.github.find(on.repo, on.branch);
    if (!pr || pr.number !== number)
      throw new Error("Cette pull request n'est plus celle de la branche du fil.");
    if (pr.state !== "open") {
      throw new Error(
        pr.state === "draft"
          ? "Cette pull request est un brouillon : marque-la prête sur GitHub d'abord."
          : "Cette pull request n'est plus ouverte.",
      );
    }
    if (pr.head !== head)
      throw new Error("La branche a reçu de nouveaux commits : relis l'état avant de merger.");
    if (pr.conflicts) throw new Error("Cette pull request a des conflits avec sa branche de base.");
    await on.github.merge(on.repo, number, head);
    const after = await on.github.find(on.repo, String(number));
    await this.notePullRequest(threadId, after);
    return after;
  }

  /** The pull request at this github.com address, for a link that shows its state. */
  async pullRequestAt(url: string): Promise<PullRequestInfo | undefined> {
    const at = parsePullRequestUrl(url);
    if (!at) throw new Error("Ce n'est pas l'adresse d'une pull request GitHub.");
    return this.pullRequests()?.find(at.repo, String(at.number));
  }

  /**
   * Puts the thread's files back as they were just before this message, and removes the
   * message and everything after it. The agent then starts over from what is left.
   */
  async restore(threadId: string, itemId: string): Promise<void> {
    const workspace = this.requireLiveThread(threadId).workspace;
    const item = this.store.getItem(threadId, itemId);
    const tree = item?.kind === "user" ? item.checkpoint : undefined;
    if (!workspace || !tree) throw new Error("Ce message n'a pas de point de retour.");
    await this.exclusive(threadId, "Attends la fin du retour en arrière.", async () => {
      // The agent stops first, so nothing it started holds a file about to change (Windows).
      await this.forgetSession(threadId);
      // Files and messages go back together: written down first, a step back that a stop
      // cuts in half is finished when the server starts again.
      this.setPendingRestore(threadId, { itemId, tree });
      try {
        await this.finishRestore(threadId, workspace, { itemId, tree });
      } catch (error) {
        // A failure the user sees is theirs to retry: it is not replayed at the next start.
        this.setPendingRestore(threadId, undefined);
        throw error;
      }
    });
  }

  private pendingRestores(): Record<string, PendingRestore> {
    return this.store.getSetting<Record<string, PendingRestore>>("pendingRestores", {});
  }

  private setPendingRestore(threadId: string, restore: PendingRestore | undefined): void {
    const { [threadId]: _done, ...others } = this.pendingRestores();
    this.store.setSetting("pendingRestores", restore ? { ...others, [threadId]: restore } : others);
  }

  /** Finishes the steps back that were under way when the server stopped. */
  private async finishRestores(): Promise<void> {
    for (const [threadId, restore] of Object.entries(this.pendingRestores())) {
      const workspace = this.store.getThread(threadId)?.workspace;
      if (!workspace) {
        this.setPendingRestore(threadId, undefined);
        continue;
      }
      await this.exclusive(threadId, "Attends la fin du retour en arrière.", () =>
        this.finishRestore(threadId, workspace, restore),
      ).catch(() => undefined);
    }
  }

  private async finishRestore(
    threadId: string,
    workspace: Workspace,
    { itemId, tree }: PendingRestore,
  ): Promise<void> {
    this.flushText(threadId);
    await restoreCheckpoint(workspace.path, tree);
    // The messages, the thread and the note of the step back change together, or not at all.
    const { removed, thread } = this.store.transaction(() => {
      const removed = this.store.removeItemsFrom(threadId, itemId);
      // Going back before a hand-off goes back to the agent of that time, on its defaults.
      const handoff = removed.find((i) => i.kind === "handoff");
      const thread = this.store.updateThread(threadId, {
        status: "idle",
        usage: undefined,
        error: null,
        ...(handoff
          ? {
              agentId: handoff.from,
              model: undefined,
              settings: undefined,
              canCompact: undefined,
              commands: undefined,
            }
          : {}),
      });
      this.setPendingRestore(threadId, undefined);
      return { removed, thread };
    });
    this.broadcast({ type: "thread", thread });
    this.sendToViewers(threadId, {
      type: "items",
      threadId,
      items: this.items(threadId),
    });
    // A ref left behind only keeps an old tree alive, so failing here is harmless.
    await dropCheckpoints(
      workspace.path,
      removed.flatMap((i) =>
        i.kind === "user" && i.checkpoint ? [checkpointRef(threadId, i.id)] : [],
      ),
    ).catch(() => undefined);
  }

  /**
   * Puts a thread away: its agent stops and its worktree goes, after its files, uncommitted
   * ones included, are kept in git. Bringing it back puts the worktree and the files back.
   */
  async setArchived(threadId: string, archived: boolean): Promise<void> {
    if (archived && this.requireThread(threadId).kind === "coordinator")
      throw new Error(
        "Le coordinateur ne se résout pas : supprime sa conversation pour repartir de zéro.",
      );
    if (archived && this.teams.isActive(threadId)) throw new Error(TEAM_AT_WORK);
    // A team goes to the archive whole, and comes back whole: never its lead alone.
    const members = this.teamMembers(threadId);
    const order = archived ? [...members, threadId] : [threadId, ...members.reverse()];
    for (const id of order) await this.setOneArchived(id, archived);
  }

  /**
   * The threads of the team this thread leads, those working in a coder's folder first:
   * they leave it before it goes.
   */
  private teamMembers(leadId: string): string[] {
    return this.store
      .listThreads()
      .filter((t) => t.parentId === leadId)
      .sort((a, b) => Number(!a.worksIn) - Number(!b.worksIn))
      .map((t) => t.id);
  }

  private async setOneArchived(threadId: string, archived: boolean): Promise<void> {
    const thread = this.requireThread(threadId);
    if (!!thread.archived === archived) return;
    const project = this.store.getProject(thread.projectId);
    await this.exclusive(threadId, "Attends que le fil soit rangé.", async () => {
      if (!archived) {
        // Its folder comes back first: if that fails, the thread stays in the archive as it was.
        if (thread.workspace?.base && project) await this.prepareWorkspace(threadId, project);
        this.updateThread(threadId, { archived: false });
        return;
      }
      await this.releaseFolder(threadId);
      await this.forgetSession(threadId);
      const workspace = thread.workspace;
      if (workspace?.base && project && this.isOurWorktree(workspace.path)) {
        if (existsSync(workspace.path)) {
          // Written down before the folder goes: a stop in between loses nothing.
          const archivedTree = await saveCheckpoint(workspace.path, archiveRef(threadId));
          this.updateThread(threadId, { workspace: { ...workspace, archivedTree } });
          try {
            await removeWorktree(project.path, workspace.path);
          } catch (error) {
            // The folder stays in use: the thread stays out of the archive, its files as they are.
            this.updateThread(threadId, { workspace });
            throw error;
          }
        }
      }
      this.updateThread(threadId, { archived: true, status: "idle" });
    });
  }

  /**
   * Deletes the thread, its timeline and its worktree. Its branch stays in the repository,
   * with the commits on it, so no committed work is lost.
   */
  async deleteThread(threadId: string): Promise<void> {
    this.requireThread(threadId);
    // A team is deleted whole: its members' threads would be left without their lead.
    const members = this.teamMembers(threadId);
    if ([threadId, ...members].some((id) => this.turns.has(id)))
      throw new Error(
        members.length
          ? "Arrête d'abord les agents de cette équipe."
          : "Arrête d'abord l'agent de ce fil.",
      );
    if (this.teams.isActive(threadId)) throw new Error(TEAM_AT_WORK);
    for (const id of [...members, threadId]) await this.deleteOneThread(id);
  }

  private async deleteOneThread(threadId: string): Promise<void> {
    const thread = this.requireThread(threadId);
    await this.exclusive(threadId, "Attends la fin de la suppression.", async () => {
      await this.releaseFolder(threadId);
      await this.forgetSession(threadId);
      this.settlePermissions(threadId);
      const project = this.store.getProject(thread.projectId);
      const workspace = thread.workspace;
      if (workspace && project) {
        if (this.isOurWorktree(workspace.path)) await removeWorktree(project.path, workspace.path);
        await dropRefs(project.path, `refs/moonagentic/${threadId}/`).catch(() => undefined);
      }
      this.setPendingRestore(threadId, undefined);
      clearTimeout(this.drafts.get(threadId)?.timer);
      this.drafts.delete(threadId);
      this.queued.delete(threadId);
      this.lastAsked.delete(threadId);
      this.openedThisTurn.delete(threadId);
      this.store.deleteThread(threadId);
      this.broadcast({ type: "threadRemoved", threadId });
      this.planner.threadDeleted(threadId);
      this.scheduler.threadDeleted(threadId);
    });
  }

  /** Removes the project and its threads from MoonAgentic; its folder is left as it is. */
  async removeProject(projectId: string): Promise<void> {
    if (!this.store.getProject(projectId)) throw new Error("Projet introuvable.");
    if (this.removingProjects.has(projectId))
      throw new Error("Ce projet est déjà en cours de retrait.");
    const threads = this.store.listThreads().filter((t) => t.projectId === projectId);
    if (
      threads.some((t) => this.turns.has(t.id) || this.busy.has(t.id) || this.teams.isActive(t.id))
    ) {
      throw new Error("Un fil de ce projet travaille encore : arrête-le d'abord.");
    }
    // No new thread, message or step starts in the project while it goes, and closing waits.
    const reason = "Attends la fin du retrait du projet.";
    this.removingProjects.add(projectId);
    for (const thread of threads) this.busy.set(thread.id, reason);
    const step = (async () => {
      // A team's reviewers and testers go before the coders whose folder they work in.
      const order = [...threads].sort((a, b) => Number(!a.worksIn) - Number(!b.worksIn));
      for (const thread of order) {
        this.busy.delete(thread.id);
        await this.deleteOneThread(thread.id);
      }
      this.store.deleteProject(projectId);
      this.gitProjects.delete(projectId);
      this.broadcast({ type: "projectRemoved", projectId });
    })();
    this.steps.add(step);
    try {
      await step;
    } finally {
      this.steps.delete(step);
      this.removingProjects.delete(projectId);
      for (const thread of threads)
        if (this.busy.get(thread.id) === reason) this.busy.delete(thread.id);
    }
  }

  /** Only folders MoonAgentic made for a thread are ever removed. */
  private isOurWorktree(dir: string): boolean {
    const inside = path.relative(this.worktreesDir, dir);
    return !!inside && !inside.startsWith("..") && !path.isAbsolute(inside);
  }

  /** Hands the thread to another agent between turns; it gets the conversation so far. */
  async switchAgent(threadId: string, agentId: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
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
        commands: undefined,
        status: "idle",
        error: null,
      });
      // Switching again before any message only changes where the last hand-off leads.
      this.flushText(threadId);
      const last = this.store.lastItem(threadId);
      if (last?.kind === "handoff" && last.from === agentId) {
        this.store.removeItemsFrom(threadId, last.id);
        this.sendToViewers(threadId, {
          type: "items",
          threadId,
          items: this.items(threadId),
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

  /** How many agents run for threads right now, starting ones included. */
  get liveAgents(): number {
    // Those being paused still run until their process is gone.
    return this.sessions.size + this.pausing.size;
  }

  /** Whether the thread's agent has nothing under way and can be stopped. */
  private canPause(threadId: string): boolean {
    return (
      this.sessions.has(threadId) &&
      !this.turns.has(threadId) &&
      !this.busy.has(threadId) &&
      !this.starting.has(threadId) &&
      ![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)
    );
  }

  private clearIdle(threadId: string): void {
    clearTimeout(this.idleTimers.get(threadId));
    this.idleTimers.delete(threadId);
  }

  /** A turn has ended: the agent waits, and is stopped if nothing comes. */
  private leftIdle(threadId: string): void {
    this.clearIdle(threadId);
    if (this.closed || !this.sessions.has(threadId)) {
      this.lastUsed.delete(threadId);
      return;
    }
    // A counter rather than the time: two turns ending in the same millisecond keep an order.
    this.lastUsed.set(threadId, ++this.useSeq);
    const timer = setTimeout(() => {
      this.idleTimers.delete(threadId);
      this.pause(threadId);
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(threadId, timer);
  }

  /**
   * Stops the thread's agent but keeps its session: the next message resumes it, or gives a
   * new one the conversation so far.
   */
  private pause(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session || !this.canPause(threadId)) {
      // Busy right now: tried again once it has been left alone as long again.
      if (session && !this.turns.has(threadId)) this.leftIdle(threadId);
      return;
    }
    // A message sent meanwhile is not refused: its agent starts once this one is gone.
    this.sessions.delete(threadId);
    this.lastUsed.delete(threadId);
    this.clearIdle(threadId);
    const closing: Promise<void> = session
      .then((s) => s.close())
      .catch(() => undefined)
      .finally(() => {
        if (this.pausing.get(threadId) === closing) this.pausing.delete(threadId);
        this.steps.delete(closing);
      });
    this.pausing.set(threadId, closing);
    this.steps.add(closing);
  }

  /** Before an agent starts, stops the ones left alone longest while too many run. */
  private makeRoom(threadId: string): void {
    let live = this.sessions.size;
    if (live < this.maxLiveAgents) return;
    const idle = [...this.lastUsed]
      .filter(([id]) => id !== threadId && this.canPause(id))
      .sort((a, b) => a[1] - b[1]);
    for (const [id] of idle) {
      if (live < this.maxLiveAgents) break;
      // The agent leaves the count at once; its process stops in the background.
      this.pause(id);
      live -= 1;
    }
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

  /**
   * Stops the agents working in the thread's folder, a team's reviewer and tester, before
   * the folder goes: Windows will not remove a folder a process works in. They keep their
   * session, to pick up if the folder comes back.
   */
  private async releaseFolder(threadId: string): Promise<void> {
    const borrowers = this.store.listThreads().filter((t) => t.worksIn === threadId);
    const busy = borrowers.find((t) => this.turns.has(t.id) || this.busy.has(t.id));
    if (busy) throw new Error(`« ${busy.title} » travaille dans ce dossier : arrête-le d'abord.`);
    await Promise.all(
      borrowers.map(async (t) => {
        const session = this.sessions.get(t.id);
        this.sessions.delete(t.id);
        this.clearIdle(t.id);
        this.lastUsed.delete(t.id);
        await session?.then((s) => s.close()).catch(() => undefined);
        await this.pausing.get(t.id);
      }),
    );
  }

  /** Stops the thread's agent and forgets its session, so the next turn starts a new one. */
  private async forgetSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    this.clearIdle(threadId);
    this.lastUsed.delete(threadId);
    // Its bridge stops with it: what it held opens nothing any more.
    this.dropCoordinatorAccess(threadId);
    await session?.then((s) => s.close()).catch(() => undefined);
    // An agent being paused is gone too before its files change (Windows holds them open).
    await this.pausing.get(threadId);
    this.store.setSessionId(threadId, null);
  }

  /** Every permission request still waiting for the user, oldest first. */
  private pendingRequests(): PendingRequest[] {
    return [...this.pendingPermissions].flatMap(([itemId, pending]): PendingRequest[] => {
      const item = this.store.getItem(pending.threadId, itemId);
      if (item?.kind !== "permission" || item.outcome !== null) return [];
      return [
        {
          threadId: pending.threadId,
          itemId,
          title: item.title,
          options: item.options,
          at: item.at,
        },
      ];
    });
  }

  private broadcastRequests(): void {
    this.broadcast({ type: "requests", requests: this.pendingRequests() });
  }

  setPermissionMode(threadId: string, permissionMode: PermissionMode): void {
    const thread = this.requireThread(threadId);
    this.updateThread(threadId, { permissionMode });
    // A team's lead speaks for its team: its agents, and those it starts later, follow.
    if (thread.role !== "lead" || !thread.team) return;
    this.teams.setPermissionMode(threadId, permissionMode);
    for (const member of this.store.listThreads()) {
      if (member.parentId === threadId && member.permissionMode !== permissionMode)
        this.updateThread(member.id, { permissionMode });
    }
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
    this.broadcastRequests();
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.updateThread(threadId, { status: "running" });
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  /** Lists the agent's models before its first thread, from the project's folder if given. */
  discover(agentId: string, projectId?: string): Promise<void> {
    const project = projectId ? this.store.getProject(projectId) : undefined;
    if (projectId && !project) return Promise.reject(new Error("Projet introuvable."));
    return this.catalog.discover(agentId, project?.path);
  }

  addCustomAgent(input: CustomAgentInput): string {
    return this.catalog.addCustomAgent(input);
  }

  removeCustomAgent(agentId: string): void {
    this.catalog.removeCustomAgent(agentId);
  }

  addMcpServer(input: McpServerInput): string {
    return this.catalog.addMcpServer(input);
  }

  toggleFavorite(agentId: string, model: string, starred: boolean): void {
    this.catalog.toggleFavorite(agentId, model, starred);
  }

  /** Stops every agent and resolves once their turns have ended. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.prTimer);
    this.scheduler.close();
    this.teams.close();
    // A review starting reads the changes first; it must not reach the store once closed.
    await this.teams.settled();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await this.recovered;
    for (const threadId of new Set([...this.pendingPermissions.values()].map((p) => p.threadId))) {
      this.settlePermissions(threadId);
    }
    await this.catalog.close();
    // An agent still starting is stopped now rather than waited for, and its turn ends
    // as stopped, not as failed.
    for (const [threadId, stop] of this.starting) {
      this.cancelled.add(threadId);
      stop.abort();
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((s) => s.then((session) => session.close()).catch(() => undefined)),
    );
    await Promise.all(this.turns.values());
    await Promise.all([...this.steps].map((step) => step.catch(() => undefined)));
    // A turn that ended meanwhile armed no timer (closed), but leaves nothing behind either.
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.lastUsed.clear();
    // Text an agent sent after its turn ended is still written down.
    for (const threadId of this.drafts.keys()) this.flushText(threadId);
  }

  private async runTurn(
    thread: Thread,
    text: string,
    itemId: string,
    context?: string,
  ): Promise<void> {
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
          ? historyBefore(this.items(thread.id), itemId, this.catalog.name)
          : undefined;
      const prompt = context ? `${context}\n\n${text}` : text;
      const stopReason = await session.prompt(prompt, history, this.linksFor(session, text));
      const error =
        stopReason === "refusal"
          ? "L'agent a refusé de continuer."
          : stopReason === "max_tokens"
            ? "L'agent a atteint sa limite de réponse."
            : stopReason === "max_turn_requests"
              ? "L'agent a atteint son nombre maximal d'étapes pour ce tour. Envoie « continue » pour qu'il reprenne."
              : null;
      this.updateThread(thread.id, error ? { status: "error", error } : { status: "idle" });
    } catch (error) {
      this.settlePermissions(thread.id);
      if (needsSignIn(error)) this.catalog.recordCheck(thread.agentId, { ok: false, error });
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

  /** The files a message mentions with `@` and the skills it calls with `$`, for the agent. */
  private linksFor(session: AgentSession, text: string) {
    const files = mentionedFiles(text, session.cwd).map((f) => ({ abs: f.abs, name: f.rel }));
    const skills = text.includes("$")
      ? calledSkills(text, findSkills(session.cwd, this.homeDir)).map((s) => ({
          abs: s.file,
          name: `$${s.name}`,
          description: s.description,
        }))
      : [];
    return promptLinks([...files, ...skills], !!session.promptCapabilities.embeddedContext);
  }

  /** The folder a thread works in, or its project's folder for a thread to come. */
  private folderOf(projectId: string, threadId?: string): string {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Projet introuvable.");
    if (!threadId) return project.path;
    const thread = this.requireThread(threadId);
    if (thread.projectId !== projectId) throw new Error("Ce fil n'est pas dans ce projet.");
    if (thread.worksIn) {
      try {
        return this.borrowedFolder(thread.worksIn);
      } catch {
        return project.path;
      }
    }
    // Until its worktree exists, a thread's files are the project's.
    const workspace = thread.workspace;
    return workspace?.base && existsSync(workspace.path) ? workFolder(workspace) : project.path;
  }

  private session(thread: Thread): Promise<AgentSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const project = this.store.getProject(thread.projectId);
    if (!project) return Promise.reject(new Error("Projet introuvable."));
    this.makeRoom(thread.id);
    const stop = new AbortController();
    this.starting.set(thread.id, stop);
    // Only the session it started may take itself out: one paused earlier may exit late.
    const owns = () => this.sessions.get(thread.id) === started;
    const paused = this.pausing.get(thread.id) ?? Promise.resolve();
    const started: Promise<AgentSession> = paused
      .then(() => this.prepareWorkspace(thread.id, project))
      .then((cwd) => this.startSession(thread, cwd, stop.signal, owns))
      .finally(() => {
        if (this.starting.get(thread.id) === stop) this.starting.delete(thread.id);
      });
    this.sessions.set(thread.id, started);
    started.then(
      (s) => this.store.setSessionId(thread.id, s.sessionId),
      () => {
        if (owns()) this.sessions.delete(thread.id);
      },
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

  /**
   * Commits what a team's piece left on its branch, then merges that branch onto the team's
   * merge thread. Returns the files left in conflict.
   */
  private async mergeInto(intoId: string, fromId: string, title: string): Promise<string[]> {
    const into = this.requireLiveThread(intoId);
    const from = this.requireThread(fromId);
    const project = this.store.getProject(into.projectId);
    if (!project) throw new Error("Projet introuvable.");
    const source = from.workspace;
    if (!source?.base || !existsSync(source.path)) {
      throw new Error(`La copie de travail de « ${from.title} » n'est plus là : ramène son fil.`);
    }
    // Neither thread takes a message, a step back, a push or an archive meanwhile.
    const reason = "Attends la fin de la fusion de l'équipe.";
    return this.exclusive(fromId, reason, () =>
      this.exclusive(intoId, reason, async () => {
        await commitAll(source.path, title);
        await this.prepareWorkspace(intoId, project);
        const target = this.store.getThread(intoId)!.workspace!;
        return mergeBranch(target.path, source.branch, `Fusion : ${title}`);
      }),
    );
  }

  /** The folder of the thread a reviewer or a tester works in, while it is there. */
  private borrowedFolder(threadId: string): string {
    const owner = this.store.getThread(threadId);
    const workspace = owner?.workspace;
    if (!owner) throw new Error("Le fil dont ce fil utilise le dossier n'existe plus.");
    if (!workspace?.base || !existsSync(workspace.path)) {
      throw new Error(`Le dossier de « ${owner.title} » n'existe plus : ramène ce fil d'abord.`);
    }
    return workFolder(workspace);
  }

  /** Makes the thread's worktree on first use; returns the folder the agent works in. */
  private async prepareWorkspace(threadId: string, project: Project): Promise<string> {
    const worksIn = this.store.getThread(threadId)?.worksIn;
    if (worksIn) return this.borrowedFolder(worksIn);
    let workspace = this.store.getThread(threadId)?.workspace;
    if (!workspace) return project.path;
    if (!workspace.base) {
      // Where the branch starts is written down before git makes anything, so a stop in
      // between is finished next time. A branch made before that rule keeps its own start.
      const start = await worktreeStart(project.path);
      if (await branchExists(project.path, workspace.branch)) {
        start.base = await forkPoint(project.path, workspace.branch);
      }
      workspace = { ...workspace, ...start };
      this.updateThread(threadId, { workspace });
    }
    // Made, or made again when its folder went missing, from the branch and its commits.
    await ensureWorktree(project.path, workspace.path, workspace.branch, workspace.base!);
    if (workspace.archivedTree) {
      // Back from the archive: the files it had, uncommitted ones included.
      await restoreCheckpoint(workspace.path, workspace.archivedTree);
      const { archivedTree: _restored, ...rest } = workspace;
      this.updateThread(threadId, { workspace: rest });
      await dropCheckpoints(workspace.path, [archiveRef(threadId)]).catch(() => undefined);
    }
    return workFolder(workspace);
  }

  private withGit(project: Project): Project {
    let git = this.gitProjects.get(project.id);
    if (git === undefined) {
      git = isGitRepo(project.path);
      this.gitProjects.set(project.id, git);
    }
    const pinned = this.store.getSetting<string[]>(PINNED_PROJECTS, []).includes(project.id);
    return git || pinned
      ? { ...project, ...(git ? { git } : {}), ...(pinned ? { pinned } : {}) }
      : project;
  }

  private async startSession(
    thread: Thread,
    cwd: string,
    stop: AbortSignal,
    /** Whether this start is still the thread's current agent. */
    owns: () => boolean,
  ): Promise<AgentSession> {
    // Until the thread's own model and settings are applied, the agent's are not news.
    let ready = false;
    const session = await AgentSession.start({
      launch: this.agents.launch(thread.agentId),
      cwd,
      previousSessionId: this.store.getSessionId(thread.id),
      mcpServers: [...this.catalog.mcpServers(), ...this.coordinatorServer(thread)],
      signal: AbortSignal.any([stop, AbortSignal.timeout(START_TIMEOUT_MS)]),
      handlers: {
        onUpdate: (update) => this.applyUpdate(thread.id, update),
        requestPermission: (request, signal) => this.requestPermission(thread.id, request, signal),
        onExit: (reason) => {
          if (!owns()) return;
          this.sessions.delete(thread.id);
          // An idle agent that quits on its own leaves no timer or place in the queue.
          this.clearIdle(thread.id);
          this.lastUsed.delete(thread.id);
          this.settlePermissions(thread.id);
          if (reason && this.turns.has(thread.id)) {
            this.updateThread(thread.id, { status: "error", error: reason });
          }
        },
        onConfig: ({ model, settings }) => {
          if (!ready) return;
          this.catalog.learn(thread.agentId, model, settings, false);
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
    this.catalog.recordCheck(thread.agentId, { ok: true, version: session.agentVersion });
    try {
      this.catalog.learn(thread.agentId, session.model, session.settings, session.fresh);
      const model = session.model;
      if (model) {
        // A continued session already runs the model it was left on.
        const wanted =
          this.store.getThread(thread.id)?.model ??
          (session.fresh ? this.catalog.defaultModel(thread.agentId) : undefined);
        if (wanted && wanted !== model.current && model.choices.some((c) => c.id === wanted)) {
          await session.setModel(wanted);
        }
        this.updateThread(thread.id, { model: session.model?.current ?? model.current });
      }
      // After the model, which can change the effort levels on offer.
      await this.applySettings(thread.id, session);
      this.catalog.learn(thread.agentId, session.model, session.settings, false);
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
    const thread = this.store.getThread(threadId);
    const wanted = thread?.settings ?? {};
    for (const setting of session.settings) {
      const chosen = Object.hasOwn(wanted, setting.id) ? wanted[setting.id] : undefined;
      // A coordinator routes and answers briefly: it starts on the agent's low effort, and
      // keeps whatever the user sets afterwards.
      const value =
        chosen ??
        (thread?.kind === "coordinator" && setting.kind === "effort"
          ? setting.choices.find((c) => LOW_EFFORT.test(c.id))?.id
          : undefined);
      if (value && value !== setting.current && setting.choices.some((c) => c.id === value)) {
        await session.setSetting(setting.id, value);
      }
    }
    const values = settingValues(session.settings);
    if (values) this.updateThread(threadId, { settings: values });
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
        this.noteToolName(threadId, update);
        this.upsertTool(threadId, update);
        return;
      case "usage_update": {
        if (!(update.size > 0 && update.used >= 0)) return;
        const before = this.store.getThread(threadId)?.usage;
        // An update without a cost, such as after compacting, keeps the one known.
        const cost =
          update.cost &&
          Number.isFinite(update.cost.amount) &&
          update.cost.amount >= 0 &&
          update.cost.currency
            ? { amount: update.cost.amount, currency: update.cost.currency }
            : before?.cost;
        const usage = { used: update.used, size: update.size, ...(cost ? { cost } : {}) };
        if (JSON.stringify(before) === JSON.stringify(usage)) return;
        this.updateThread(threadId, { usage });
        return;
      }
      case "available_commands_update": {
        const commands = agentCommands(update);
        const canCompact = commands.some((c) => c.name === "compact");
        const thread = this.store.getThread(threadId);
        if (!thread) return;
        if (
          canCompact !== !!thread.canCompact ||
          JSON.stringify(commands) !== JSON.stringify(thread.commands ?? [])
        ) {
          this.updateThread(threadId, { canCompact, commands });
        }
        this.catalog.rememberCommands(thread.agentId, commands);
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

  /**
   * Adds streamed text to the agent's last message or thought. Viewers get it at once; the
   * database gets it in batches, and whenever anything reads the timeline or another item
   * comes.
   */
  private appendText(threadId: string, kind: TextItem["kind"], text: string): void {
    let draft = this.drafts.get(threadId);
    if (draft?.item.kind !== kind) {
      this.flushText(threadId);
      const last = this.store.lastItem(threadId);
      if (last?.kind !== kind) {
        const item: TextItem = { id: `${kind}:${randomUUID()}`, kind, text, at: Date.now() };
        this.putItem(threadId, item);
        this.drafts.set(threadId, { item, dirty: false });
        return;
      }
      draft = { item: last, dirty: false };
      this.drafts.set(threadId, draft);
    }
    draft.item = { ...draft.item, text: draft.item.text + text };
    draft.dirty = true;
    this.sendToViewers(threadId, { type: "append", threadId, itemId: draft.item.id, text });
    draft.timer ??= setTimeout(() => this.flushText(threadId, false), TEXT_FLUSH_MS);
  }

  /** Writes down the thread's streamed text; `end` also closes it, so the next text starts anew. */
  private flushText(threadId: string, end = true): void {
    const draft = this.drafts.get(threadId);
    if (!draft) return;
    clearTimeout(draft.timer);
    draft.timer = undefined;
    if (draft.dirty && this.store.getThread(threadId)) this.store.putItem(threadId, draft.item);
    draft.dirty = false;
    if (end) this.drafts.delete(threadId);
  }

  private flushAll(): void {
    for (const threadId of this.drafts.keys()) this.flushText(threadId, false);
  }

  /** The thread's timeline, streamed text included. */
  private items(threadId: string): Item[] {
    // Written down, but kept open: the agent may still be adding to it.
    this.flushText(threadId, false);
    return this.store.listItems(threadId);
  }

  private upsertTool(threadId: string, update: acp.ToolCall | acp.ToolCallUpdate): void {
    // Agents may number their tool calls from scratch on every turn or session, so the turn
    // is part of the item's id: a later call never replaces an earlier turn's card.
    const id = `tool:${this.turnIds.get(threadId) ?? "late"}:${update.toolCallId}`;
    const existing = this.store.getItem(threadId, id) as ToolItem | undefined;
    const content = update.content ? toolContent(update.content) : undefined;
    const questions = toolQuestions(update.rawInput) ?? existing?.questions;
    this.putItem(threadId, {
      id,
      kind: "tool",
      title: update.title ?? existing?.title ?? "Outil",
      toolKind: update.kind ?? existing?.toolKind ?? "other",
      status: update.status ?? existing?.status ?? "pending",
      content: content ?? existing?.content ?? [],
      ...(questions ? { questions } : {}),
      at: existing?.at ?? Date.now(),
    });
  }

  /** Keeps the name an agent gives the tool of a call, when it says it (Claude Code does). */
  private noteToolName(
    threadId: string,
    call: { toolCallId: string; _meta?: Record<string, unknown> | null },
  ): void {
    const meta = call._meta?.claudeCode;
    const name =
      typeof meta === "object" && meta !== null ? (meta as { toolName?: unknown }).toolName : null;
    if (typeof name !== "string") return;
    const names = this.toolNames.get(threadId) ?? new Map<string, string>();
    names.set(call.toolCallId, name);
    this.toolNames.set(threadId, names);
  }

  private requestPermission(
    threadId: string,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const thread = this.requireThread(threadId);
    if (request.toolCall.title) this.upsertTool(threadId, request.toolCall);
    // A reviewer only reads and runs checks: even with full access, a change waits on the user.
    // Nor does a coordinator change files: it routes, and the threads it opens do the work.
    const edits =
      (thread.role === "reviewer" || thread.kind === "coordinator") &&
      READ_ONLY_REFUSED.has(request.toolCall.kind ?? "");
    // MoonAgentic's own tools are the coordinator's work, already limited by the server:
    // asking the user before each one would make it useless.
    this.noteToolName(threadId, request.toolCall);
    const own =
      thread.kind === "coordinator" &&
      OWN_TOOL.test(this.toolNames.get(threadId)?.get(request.toolCall.toolCallId) ?? "");
    if ((thread.permissionMode === "full" && !edits) || own) {
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
      this.broadcastRequests();
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
    this.broadcastRequests();
  }

  /** A thread that can still change: not put away in the archive. */
  private requireLiveThread(threadId: string): Thread {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("Ce fil est résolu : rouvre-le pour continuer.");
    return thread;
  }

  private requireThread(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Fil introuvable.");
    return thread;
  }

  private putItem(threadId: string, item: Item): void {
    // Another item ends the text being streamed, which keeps its place before it.
    if (this.drafts.get(threadId)?.item.id !== item.id) this.flushText(threadId);
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
