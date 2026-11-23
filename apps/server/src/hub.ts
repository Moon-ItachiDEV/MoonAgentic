import { AttachmentRefused, Attachments } from "./attachments.ts";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { DEFAULT_MAX_TURNS, threadPullRequest } from "@moonagentic/protocol";
import type {
  CustomAgentInput,
  AgentSetting,
  ClientMessage,
  ImageRef,
  Item,
  McpServerInput,
  PendingQuestion,
  PendingRequest,
  QuestionAnswer,
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
  TeamRole,
  Thread,
  ToolContent,
  Workspace,
} from "@moonagentic/protocol";
import type { Agents } from "./agents.ts";
import { cloneGithubRepo, githubRepos, githubStatus, parseGithubRepo } from "./github.ts";
import { githubAccount, type LoginResult } from "./github-account.ts";
import { mergePlan, noteTool } from "./plan-steps.ts";
import { defaultParent, findClones, usualRoots } from "./local-clones.ts";
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
import { Coordinators } from "./coordinator.ts";
import { historyBefore } from "./history.ts";
import { Planner } from "./planner.ts";
import { COORDINATOR_TOOLS } from "./coordinator-tools.ts";
import { localPullRequests, parsePullRequestUrl, type PullRequests } from "./pull-request.ts";
import { Scheduler } from "./scheduler.ts";
import { shipTarget, Teams, teamStatus } from "./team.ts";
import { mcpServersFor, RESERVED_MCP_NAME } from "./mcp.ts";
import { type QuotaReader, Quotas } from "./quotas.ts";
import { formContent, formQuestions, toolQuestions, type FormQuestions } from "./questions.ts";
import { AgentSession, describe, needsSignIn } from "./session.ts";
import { AgentPool } from "./sessions.ts";
import { light, TimelineLog } from "./timeline.ts";
import { TurnLine } from "./turn-line.ts";
import type { Store } from "./store.ts";

export interface Client {
  send(message: ServerMessage): void;
  /** The threads whose timelines this client is showing: a coordinator's, and one beside it. */
  openThreadIds?: Set<string>;
}

/** The changed files a result names; the others are counted. */
const RESULT_FILES = 6;
/** How much of a thread's last answer its result carries. */
const RESULT_LIMIT = 400;

const watch = (client: Client, threadId: string): void => {
  (client.openThreadIds ??= new Set()).add(threadId);
};

type ToolItem = Extract<Item, { kind: "tool" }>;
type TextItem = Extract<Item, { kind: "agent" | "thought" }>;

/** How often streamed text is written down; viewers get each piece at once. */
const TEXT_FLUSH_MS = 250;
/**
 * The search's index is filled a short stretch at a time, with a pause in between, so the
 * server keeps answering while a long history is taken in.
 */
const INDEX_STRETCH_MS = 20;
const INDEX_PAUSE_MS = 50;

const titleFrom = (text: string, images = 0) => {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length > 60) return `${line.slice(0, 57).trimEnd()}…`;
  // A message of images alone has no words to name the conversation with.
  return line || (images > 1 ? "Images" : images ? "Image" : "Nouvelle discussion");
};

/** What an agent is told when the message is images alone: it needs some words to answer. */
const IMAGES_ONLY = "(Message sans texte : regarde l'image jointe.)";

const toolContent = (content: acp.ToolCallContent[] | null | undefined): ToolContent[] =>
  (content ?? []).flatMap((c): ToolContent[] => {
    if (c.type === "diff")
      return [{ type: "diff", path: c.path, oldText: c.oldText ?? null, newText: c.newText }];
    if (c.type === "content" && c.content.type === "text")
      return [{ type: "text", text: c.content.text }];
    return [];
  });

/** How long an agent may take to stop after « Arrêter » before its process is killed. */
const FORCE_STOP_MS = 10_000;
/** How long an agent may take to open its session before the turn gives up. */
const START_TIMEOUT_MS = 120_000;

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
  /** How long an agent may take to stop after « Arrêter » before it is killed. */
  forceStopMs?: number;
  /** How each agent's subscription quotas are read; none are read when left out. */
  quotaReaders?: Record<string, QuotaReader>;
  /** How often every quota is read again; 0 for only when asked or after a turn. */
  quotaEveryMs?: number;
  /** Where the images sent with messages are kept; beside the worktrees unless given. */
  attachmentsDir?: string;
}

/** The setting that lists the projects kept at the top. */
const PINNED_PROJECTS = "pinnedProjects";

/** The level a coordinator starts on, as agents name it. */
const LOW_EFFORT = /^(low|bas)$/i;

/**
 * A permission asked for one of MoonAgentic's own tools, as agents name the tools of an MCP
 * server: `mcp__moonagentic__list_threads` for Claude Code, `mcp_moonagentic_list_threads`
 * for Antigravity, which says it only in the call's title ("Run mcp_moonagentic_…").
 */
const OWN_TOOL = new RegExp(
  `^(?:Run )?mcp_{1,2}moonagentic_{1,2}(?:${COORDINATOR_TOOLS.map((t) => t.name).join("|")})$`,
);

/** A known, open pull request is asked about again this often. */
const PR_WATCH_MS = 60_000;
/** Characters kept of what an agent last said, for lists of threads. */
const SUMMARY_LIMIT = 160;

/** The first lines of a reply as one short line, without Markdown marks. */
export function summaryOf(reply: string, limit = SUMMARY_LIMIT): string {
  const flat = reply
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[*`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
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

/**
 * What a coordinator may do on its own when granted full access: only strictly read-only
 * inspection (`read`, `search`, `think`). Commands (`execute`), file edits, network fetches
 * and unknown/unspecified (`other`) tools wait on the user.
 */
export const COORDINATOR_ALLOWED = new Set(["read", "search", "think"]);
/**
 * What a team's reviewer may do on its own in full access: read-only inspection plus shell
 * commands (`execute`), since agents such as Codex inspect files and git diffs via the shell.
 * File edits, deletes, moves, network fetches and unknown (`other`) tools still wait on the user.
 */
export const REVIEWER_ALLOWED = new Set(["read", "search", "think", "execute"]);

const TEAM_AT_WORK = "Cette équipe travaille encore : arrête-la d'abord.";

/** A step back under way, kept until it is done so a stop in the middle is finished later. */
type PendingRestore = { itemId: string; tree: string };

/** Owns threads and their agent sessions, and keeps every connected client in sync. */
export class Hub {
  private readonly store: Store;
  private readonly agents: Agents;
  private readonly clients = new Set<Client>();
  /** The agents running for threads. */
  private readonly pool: AgentPool;
  private readonly turns = new Map<string, Promise<void>>();
  /** Threads whose running turn the user asked to stop. */
  private readonly cancelled = new Set<string>();
  /** Turns started by a coordinator, a team or a planned task that wait for a place. */
  private readonly line = new TurnLine();
  /** Kills the agent of each thread asked to stop, if its turn has not ended in time. */
  private readonly forceStops = new Map<string, NodeJS.Timeout>();
  private readonly forceStopMs: number;
  /** Steps under way (a push, a step back, a hand-off), awaited before the server stops. */
  private readonly steps = new Set<Promise<unknown>>();
  /** Identifies the running turn, so a turn's plan and text stay separate from the next. */
  private readonly turnIds = new Map<string, string>();
  private readonly pendingPermissions = new Map<
    string,
    { threadId: string; resolve: (r: acp.RequestPermissionResponse) => void }
  >();
  /**
   * Questions an agent holds its turn on, by item: each also waits in `pendingPermissions`,
   * so whatever cancels a permission request (a stop, the agent ending) cancels it too.
   */
  /** What the user said with a refusal, by thread: their next message, once the turn is over. */
  private readonly followUps = new Map<string, string>();
  private readonly pendingForms = new Map<
    string,
    { form: FormQuestions; answer: (r: acp.CreateElicitationResponse) => void }
  >();

  /** Where threads with their own branch get their worktree. */
  private readonly worktreesDir: string;
  /** The images sent with messages. */
  readonly attachments: Attachments;
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
  /** Names this run of the server: a screen's mark from another run means nothing here. */
  private readonly epoch = randomUUID();
  /** What changed in each timeline since the server started. */
  private readonly logs = new Map<string, TimelineLog>();
  private readonly drafts = new Map<
    string,
    { item: TextItem; dirty: boolean; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;

  /** The user's home folder, where agents keep their personal skills. */
  private readonly homeDir: string;
  private readonly pullRequests: () => PullRequests | undefined;
  /** The tool behind each call of a turn, by thread, for agents that name it. */
  private readonly toolNames = new Map<string, Map<string, string>>();
  /** The projects' coordinators. */
  readonly coordinators: Coordinators;
  /** Where this server answers a coordinator's bridge, once it listens. */
  get coordinatorUrl(): string | undefined {
    return this.coordinators.url;
  }
  set coordinatorUrl(url: string | undefined) {
    this.coordinators.url = url;
  }
  /** True while known pull requests are being asked about, so rounds never pile up. */
  private watching = false;
  private readonly prTimer: NodeJS.Timeout | undefined;

  constructor(store: Store, agents: Agents, options: HubOptions) {
    this.store = store;
    this.agents = agents;
    this.worktreesDir = options.worktreesDir;
    this.attachments = new Attachments(
      options.attachmentsDir ?? path.join(path.dirname(options.worktreesDir), "attachments"),
    );
    this.forceStopMs = options.forceStopMs ?? FORCE_STOP_MS;
    this.pool = new AgentPool({
      idleMs: options.idleMs,
      maxLiveAgents: options.maxLiveAgents,
      busy: (id) =>
        this.turns.has(id) ||
        this.busy.has(id) ||
        [...this.pendingPermissions.values()].some((p) => p.threadId === id),
      running: (id) => this.turns.has(id),
      closed: () => this.closed,
      steps: this.steps,
    });
    this.homeDir = options.homeDir ?? os.homedir();
    this.pullRequests = options.pullRequests ?? localPullRequests;
    const watchMs = options.prWatchMs ?? PR_WATCH_MS;
    if (watchMs > 0) {
      this.prTimer = setInterval(() => void this.watchPullRequests(), watchMs);
      this.prTimer.unref();
    }
    this.catalog = new AgentCatalog(store, agents, (m) => this.broadcast(m), this.homeDir);
    this.planner = new Planner(store, (m) => this.broadcast(m));
    this.quotas = new Quotas({
      readers: options.quotaReaders ?? {},
      available: () =>
        this.catalog
          .list()
          .filter((a) => a.available)
          .map((a) => a.id),
      broadcast: (m) => this.broadcast(m),
      active: () => this.clients.size > 0,
    });
    this.quotas.start(options.quotaEveryMs);
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
          auto: true,
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
        const before = this.store.getThread(id)?.team?.phase;
        this.updateThread(id, { team });
        const lead = this.store.getThread(id);
        if (lead && team && team.phase !== before && !this.closed) this.reportTeam(lead, team);
        if (lead) this.planner.syncTeam(lead);
        // A team that stops working frees its place: its last turn was a member's, which
        // no coordinator opened, so the line is looked at from here.
        if (lead?.openedBy && !this.closed) this.coordinators.drainLine(lead.openedBy);
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
    this.coordinators = new Coordinators(store, {
      catalog: this.catalog,
      broadcast: (m) => this.broadcast(m),
      checkAgent: (id) => void this.agents.launch(id),
      removing: (id) => this.removingProjects.has(id),
      running: (id) => this.turns.has(id),
      leadContext: (id) => this.leadContext(id),
      updateThread: (id, patch) => this.updateThread(id, patch),
      items: (id) => this.items(id),
      putItem: (id, item) => this.putItem(id, item),
      requireThread: (id) => this.requireThread(id),
      pendingRequests: () => this.pendingRequests(),
      createThread: (input) => this.createThread(input),
      startTeam: (input) => this.startTeam(input),
      send: (...args) => this.send(...args),
      cancel: (id) => this.cancel(id),
      whenIdle: (id) => this.whenIdle(id),
      setArchived: (id, archived) => this.setArchived(id, archived),
      discover: (agentId, projectId) => this.discover(agentId, projectId),
      confirmTeamPermission: (coordinatorId, task, signal) =>
        this.confirmTeamPermission(coordinatorId, task, signal),
    });
    store.recoverAfterRestart();
    // Messages the index does not have yet: all of them, the first time after an update.
    this.indexSearchSoon();
    this.teams.recover();
    this.recovered = this.finishRestores();
    // Tasks that were due while the server was off start once what was interrupted is put right.
    void this.recovered.then(() => {
      if (this.closed) return;
      this.scheduler.start();
      // Threads left in line when the server stopped start once places are free: until
      // now, only the end of another turn of their coordinator made them move.
      for (const t of this.store.listThreads()) {
        if (t.kind === "coordinator" && !t.archived) this.coordinators.drainLine(t.id);
      }
    });
  }

  /** The agents, their models and checks, the MCP servers and the favorites. */
  readonly catalog: AgentCatalog;
  /** Each project's planner. */
  readonly planner: Planner;
  /** What each agent's subscription has left. */
  readonly quotas: Quotas;
  /** The tasks planned for later. */
  readonly scheduler: Scheduler;
  /** Teams of agents, each run from its lead's thread. */
  readonly teams: Teams;

  /** Resolves once the steps back that a stop interrupted are finished. */
  readonly recovered: Promise<void>;

  connect(client: Client): () => void {
    this.clients.add(client);
    this.quotas.onClientConnect();
    client.send({ type: "snapshot", snapshot: this.snapshot() });
    return () => this.clients.delete(client);
  }

  snapshot(): Snapshot {
    const mcpSecretsError = this.catalog.mcpSecretsError();
    return {
      coordinator: this.coordinators.coordinatorSettings(),
      favorites: this.catalog.favorites(),
      requests: this.pendingRequests(),
      questions: this.pendingQuestions(),
      mcpServers: this.catalog.mcpServerInfos(),
      ...(mcpSecretsError ? { mcpSecretsError } : {}),
      agents: this.catalog.list(),
      projects: this.store.listProjects().map((p) => this.withGit(p)),
      threads: this.store.listThreads(),
      quotas: this.quotas.list(),
      plan: this.planner.list(),
      schedules: this.scheduler.list(),
    };
  }

  async handle(client: Client, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "ping":
        client.send({ type: "pong" });
        return;
      case "project.create": {
        const id = this.createProject(message.name, message.path);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "project.clone": {
        // A project already cloned from this repository opens instead of a second copy.
        const wanted = parseGithubRepo(message.repo);
        const twin =
          wanted &&
          (await findClones([], this.store.listProjects())).find(
            (c) => c.repo?.toLowerCase() === `${wanted.owner}/${wanted.name}`.toLowerCase(),
          );
        if (twin?.projectId) {
          client.send({ type: "created", requestId: message.requestId, id: twin.projectId });
          return;
        }
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
      case "quotas.refresh":
        await this.quotas.asked(message.agentId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "github.status":
        client.send({ type: "github", requestId: message.requestId, status: await githubStatus() });
        return;
      case "github.login": {
        const account = githubAccount();
        if (!account) throw new Error("La connexion GitHub n'est pas disponible ici.");
        const device = await account.startLogin();
        client.send({ type: "githubDevice", requestId: message.requestId, device });
        return;
      }
      case "github.loginCancel":
        githubAccount()?.cancelLogin();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "github.logout":
        await githubAccount()?.logout();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "local.clones":
        client.send({
          type: "localClones",
          requestId: message.requestId,
          ...(await this.localClones()),
        });
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
        watch(client, id);
        client.send({ type: "created", requestId: message.requestId, id });
        client.send(this.opening(id));
        return;
      }
      case "thread.leave":
        client.openThreadIds?.delete(message.threadId);
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
        watch(client, message.threadId);
        // Opened: read.
        if (this.store.getThread(message.threadId)?.unread) {
          this.updateThread(message.threadId, { unread: false });
        }
        client.send(
          this.changesSince(message.threadId, message.since) ?? this.opening(message.threadId),
        );
        return;
      case "thread.page": {
        this.requireThread(message.threadId);
        const page = this.store.pageItems(message.threadId, message.before, message.reach);
        client.send({
          type: "page",
          requestId: message.requestId,
          threadId: message.threadId,
          before: message.before,
          items: page.items.map(light),
          first: page.first,
          earlier: page.earlier,
        });
        return;
      }
      case "thread.read":
        this.requireThread(message.threadId);
        client.send({
          type: "timeline",
          requestId: message.requestId,
          threadId: message.threadId,
          items: this.items(message.threadId).map(light),
        });
        return;
      case "thread.send": {
        // Written to by hand, a thread waiting in line starts now, its brief first.
        const held = this.store.getThread(message.threadId)?.held;
        this.send(
          message.threadId,
          held ? `${held}\n\n${message.text}` : message.text,
          this.leadContext(message.threadId) ??
            this.coordinators.coordinatorContext(message.threadId),
          undefined,
          undefined,
          undefined,
          message.attachments,
        );
        // Only once it is sent: a refusal keeps the brief where it was.
        if (held) this.updateThread(message.threadId, { held: null });
        return;
      }
      case "coordinator.open": {
        const id = this.openCoordinator(message.projectId, message.agentId, message.model);
        watch(client, id);
        client.send({ type: "created", requestId: message.requestId, id });
        client.send(this.opening(id));
        return;
      }
      case "thread.cancel":
        await this.cancel(message.threadId);
        return;
      case "item.get": {
        this.requireThread(message.threadId);
        const item = this.store.getItem(message.threadId, message.itemId);
        if (!item) throw new Error("Cet élément n'est plus dans le fil.");
        client.send({
          type: "fullItem",
          requestId: message.requestId,
          threadId: message.threadId,
          item,
        });
        return;
      }
      case "thread.restore":
        await this.restore(message.threadId, message.itemId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.switchAgent":
        await this.switchAgent(message.threadId, message.agentId);
        this.coordinators.keepChoice(message.threadId);
        return;
      case "thread.setPermissionMode":
        this.setPermissionMode(message.threadId, message.permissionMode);
        return;
      case "thread.setModel":
        await this.setModel(message.threadId, message.model);
        this.coordinators.keepChoice(message.threadId);
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
        const settings = this.coordinators.coordinatorSettings();
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
        this.coordinators.setCoordinatorSettings({ ...settings, routes });
        return;
      }
      case "coordinator.setParallel":
        this.coordinators.setCoordinatorSettings({
          ...this.coordinators.coordinatorSettings(),
          parallel: message.parallel,
        });
        // More places: the threads already in line take them now.
        for (const t of this.store.listThreads()) {
          if (t.kind === "coordinator") this.coordinators.drainLine(t.id);
        }
        return;
      case "server.setMaxTurns":
        this.coordinators.setCoordinatorSettings({
          ...this.coordinators.coordinatorSettings(),
          maxTurns: message.maxTurns,
        });
        // More places: the turns already in line take them now.
        this.admit();
        return;
      case "team.start": {
        const id = this.startTeam(message);
        // Kept as the team a coordinator starts when it is asked for one.
        this.coordinators.setCoordinatorSettings({
          ...this.coordinators.coordinatorSettings(),
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
        watch(client, id);
        client.send({ type: "created", requestId: message.requestId, id });
        client.send(this.opening(id));
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
        const id = await this.catalog.addMcpServer(message.server);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "mcp.setEnabled":
        this.catalog.setMcpEnabled(message.id, message.enabled);
        return;
      case "mcp.setScope":
        this.catalog.setMcpScope(message.id, message.projectIds, message.allRoles);
        return;
      case "mcp.remove":
        await this.catalog.removeMcpServer(message.id);
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
        this.respondToPermission(
          message.threadId,
          message.itemId,
          message.optionId,
          message.followUp,
        );
        return;
      case "question.respond":
        this.respondToQuestion(message.threadId, message.itemId, message.answers);
        return;
    }
  }

  createProject(name: string, rawPath: string): string {
    const resolved = path.resolve(rawPath.replace(/^~(?=$|[\\/])/, os.homedir()));
    // A folder already in MoonAgentic opens as it is, so no project is ever there twice.
    const known = this.store.listProjects().find((p) => {
      try {
        return samePath(p.path, resolved);
      } catch {
        return false; // a project whose folder is gone
      }
    });
    if (known) return known.id;
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
    /** Started by the server itself, a planned task: waits for a place when all are taken. */
    auto?: boolean | undefined;
    /** The images sent with the first message. */
    attachments?: string[] | undefined;
  }): string {
    const project = this.store.getProject(input.projectId);
    if (!project || this.removingProjects.has(project.id)) throw new Error("Projet introuvable.");
    this.agents.launch(input.agentId);
    const now = Date.now();
    const id = randomUUID();
    const title = titleFrom(input.title ?? input.text, input.attachments?.length);
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
    if ((input.text || input.attachments?.length) && !input.held) {
      if (input.openedBy)
        this.coordinators.sendFromCoordinator(thread.id, input.text, input.byTeam);
      else {
        try {
          this.send(
            thread.id,
            input.text,
            undefined,
            input.byTeam,
            undefined,
            input.auto,
            input.attachments,
          );
        } catch (error) {
          // An image that is no longer there: no empty conversation is left behind for it.
          if (!(error instanceof AttachmentRefused)) throw error;
          this.store.deleteThread(thread.id);
          this.broadcast({ type: "threadRemoved", threadId: thread.id });
          throw error;
        }
      }
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
    return this.coordinators.coordinatorSettings();
  }

  /** The project's coordinator, made with this agent when the project has none yet. */
  openCoordinator(projectId: string, agentId: string, model?: string): string {
    return this.coordinators.openCoordinator(projectId, agentId, model);
  }

  /** The bridge's first call: what it was started with, once, for the token of its project. */
  coordinatorExchange(bootstrap: string): string {
    return this.coordinators.coordinatorExchange(bootstrap);
  }

  /** One tool call of a coordinator, from its bridge. */
  coordinatorCall(
    token: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.coordinators.coordinatorCall(token, tool, args, signal);
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

  /** Turns the whole server may run at once. */
  private maxTurns(): number {
    return this.coordinators.coordinatorSettings().maxTurns ?? DEFAULT_MAX_TURNS;
  }

  /** Turns at work now: not those in line, nor those waiting for the user's answer. */
  private turnsAtWork(): number {
    let n = 0;
    for (const id of this.turns.keys()) {
      if (!this.line.has(id) && this.store.getThread(id)?.status !== "waiting") n += 1;
    }
    return n;
  }

  /** Lets the turns in line through, first come first served, while places are free. */
  private admit(): void {
    while (this.line.size && this.turnsAtWork() < this.maxTurns()) this.line.next();
  }

  /**
   * Sends the user's message to the thread's agent; `context` goes before it, unseen.
   * `byTeam` marks a message the team's engine wrote, which the app keeps out of sight.
   * A message the user did not write themselves (a team's, a coordinator's, or `auto` for
   * a planned task) waits for a place when the server runs as many turns as it may.
   */
  send(
    threadId: string,
    text: string,
    context?: string,
    byTeam?: boolean,
    from?: "coordinator",
    auto?: boolean,
    /** The images joined to the message, already sent to the server. */
    attachments?: readonly string[],
  ): void {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    const busy = this.busy.get(threadId);
    if (busy) throw new Error(busy);
    // From here the images are the thread's own; one that is missing stops the message.
    const images = attachments?.length ? this.attachments.bind(threadId, attachments) : [];
    // A step back left over from a failure must never replay over the turns that follow.
    if (this.pendingRestores()[threadId]) this.setPendingRestore(threadId, undefined);
    const itemId = `user:${randomUUID()}`;
    this.putItem(threadId, {
      id: itemId,
      kind: "user",
      text,
      ...(images.length ? { images } : {}),
      ...(byTeam ? { byTeam: true as const } : {}),
      ...(from ? { from } : {}),
      at: Date.now(),
    });
    this.updateThread(threadId, { status: "running", error: null });
    this.turnIds.set(threadId, randomUUID());
    this.cancelled.delete(threadId);
    this.pool.clearIdle(threadId);
    const queued = !!(byTeam || from || auto);
    const turn = this.runTurn(thread, text, itemId, context, queued, images).finally(() => {
      const cancelled = this.cancelled.has(threadId);
      this.turns.delete(threadId);
      // What was said in this turn can be searched for without waiting on a search.
      this.indexSearchSoon();
      // A place is free for the first turn in line.
      if (!this.closed) this.admit();
      this.turnIds.delete(threadId);
      this.cancelled.delete(threadId);
      this.toolNames.delete(threadId);
      this.flushText(threadId);
      // An agent killed in a quiet stretch could not say it was over.
      if (this.store.getThread(threadId)?.quietSince) {
        this.updateThread(threadId, { quietSince: null });
      }
      this.pool.leftIdle(threadId);
      if (!this.closed) {
        // What the turn used shows in the agent's figures soon after.
        const agentId = this.store.getThread(threadId)?.agentId;
        if (agentId) this.quotas.afterTurn(agentId);
        const summary = summaryOf(this.lastReply(threadId));
        const now = this.store.getThread(threadId);
        if (summary && now && now.summary !== summary) this.updateThread(threadId, { summary });
        // Answered with no window on it: unread, until it is opened. A team's members are
        // read through their lead, and a coordinator on its project's page.
        const seen = [...this.clients].some((c) => c.openThreadIds?.has(threadId));
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
      // What the user said with a refusal is their next message, now that the agent can
      // take one. A turn they stopped starts nothing, so the words go with it.
      const followUp = this.followUps.get(threadId);
      this.followUps.delete(threadId);
      if (followUp && !this.closed && !cancelled && !this.turns.has(threadId)) {
        try {
          this.send(threadId, followUp);
        } catch (error) {
          console.error("Message après un refus :", error);
        }
      }
      // A turn the user stopped starts nothing by itself: what waits goes after the next one.
      if (!this.closed && !cancelled) this.coordinators.sendQueued(threadId);
      // A place is free: the next thread in line behind the same coordinator starts.
      const openedBy = this.closed ? undefined : this.store.getThread(threadId)?.openedBy;
      if (openedBy) this.coordinators.drainLine(openedBy);
      if (openedBy && !cancelled) void this.reportResult(threadId);
    });
    this.turns.set(threadId, turn);
  }

  /**
   * Tells, in the coordinator's conversation, what a thread it opened has just finished:
   * the thread's own last words and the files changed on its branch. Nothing is written
   * for it, and the coordinator's agent does not run. Only for work the coordinator sent,
   * once nothing more is on its way: an answer to the user's own message is theirs already.
   */
  private async reportResult(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread?.openedBy || thread.archived || thread.status !== "idle") return;
    if (thread.team || this.coordinators.hasQueued(threadId)) return;
    if (!this.store.getThread(thread.openedBy)) return;
    const asked = this.items(threadId).findLast((i) => i.kind === "user");
    if (asked?.kind !== "user" || asked.from !== "coordinator") return;
    // Its conclusion: what it said last, after its tools, not how it set out.
    const last = this.items(threadId).findLast((i) => i.kind === "agent" || i.kind === "user");
    const summary = last?.kind === "agent" ? summaryOf(last.text, RESULT_LIMIT) : "";
    if (!summary) return;
    const changed = await this.review(threadId).catch(() => undefined);
    // Meanwhile the thread may have started again, or gone with its coordinator.
    if (this.closed || this.turns.has(threadId) || !this.store.getThread(thread.openedBy)) return;
    const files = changed?.files.map((f) => f.path) ?? [];
    const more = Math.max(0, files.length - RESULT_FILES) + (changed?.omitted ?? 0);
    this.putItem(thread.openedBy, {
      id: `result:${threadId}:${asked.id}`,
      kind: "result",
      threadId,
      title: thread.title,
      summary,
      files: files.slice(0, RESULT_FILES),
      ...(more ? { moreFiles: more } : {}),
      at: Date.now(),
    });
  }

  /** The same for a team the coordinator started, once it is done or has failed. */
  private reportTeam(lead: Thread, team: Team): void {
    if (!lead.openedBy || !this.store.getThread(lead.openedBy)) return;
    if (team.phase !== "done" && team.phase !== "failed") return;
    const n = team.tasks.length;
    this.putItem(lead.openedBy, {
      id: `result:${lead.id}:${team.phase}`,
      kind: "result",
      threadId: lead.id,
      title: lead.title,
      summary:
        team.phase === "done"
          ? `Équipe terminée : ${n} morceau${n > 1 ? "x" : ""} fusionné${n > 1 ? "s" : ""}.`
          : `Équipe en échec${team.error ? ` : ${team.error}` : "."}`,
      files: [],
      ...(team.phase === "failed" ? { failed: true } : {}),
      at: Date.now(),
    });
  }

  /** Resolves once the thread has no turn running. */
  async whenIdle(threadId: string): Promise<void> {
    await this.turns.get(threadId);
  }

  async cancel(threadId: string): Promise<void> {
    // An agent only cancels a prompt it already has: one that is still starting never sees
    // the request, so the turn remembers it and stops before sending its prompt.
    const turn = this.turns.get(threadId);
    if (turn) this.cancelled.add(threadId);
    // Still in line: it leaves it, and its turn ends there.
    this.line.leave(threadId);
    this.pool.abortStart(threadId);
    this.settlePermissions(threadId);
    // Armed first: an agent frozen enough may not even read the request.
    if (turn) this.forceStopAfter(threadId, turn);
    const session = await this.pool.get(threadId)?.catch(() => undefined);
    await session?.cancel();
  }

  /**
   * Kills the thread's agent if the turn asked to stop has not ended in time: its turn then
   * ends as stopped, which frees its place in its coordinator's line. Its session is kept,
   * for the next message to resume.
   */
  private forceStopAfter(threadId: string, turn: Promise<void>): void {
    if (this.forceStops.has(threadId)) return;
    const timer = setTimeout(() => {
      this.forceStops.delete(threadId);
      if (this.closed || this.turns.get(threadId) !== turn) return;
      console.warn(`L'agent du fil ${threadId} ne s'arrêtait pas : arrêté de force.`);
      void this.pool.stop(threadId);
    }, this.forceStopMs);
    timer.unref();
    this.forceStops.set(threadId, timer);
    const done = () => {
      clearTimeout(timer);
      if (this.forceStops.get(threadId) === timer) this.forceStops.delete(threadId);
    };
    turn.then(done, done);
  }

  /** Switches the thread's model between turns: now if its agent is running, otherwise when it next starts. */
  async setModel(threadId: string, model: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    // Many agents mishandle a settings change in the middle of a prompt.
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer de modèle.");
    // A message sent meanwhile waits: the agent never gets a prompt in the middle of it.
    await this.exclusive(threadId, "Attends la fin du changement de modèle.", async () => {
      const session = await this.pool.get(threadId)?.catch(() => undefined);
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
      const session = await this.pool.get(threadId)?.catch(() => undefined);
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
    // The images of the messages taken out go too: the composer got them back to send again.
    this.attachments.remove(
      threadId,
      removed.flatMap((i) => (i.kind === "user" ? (i.images ?? []).map((image) => image.id) : [])),
    );
    this.broadcast({ type: "thread", thread });
    this.timelineCut(threadId);
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
      this.logs.delete(threadId);
      this.coordinators.forget(threadId);
      this.attachments.forget(threadId);
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
      this.catalog.projectRemoved(projectId);
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
        this.timelineCut(threadId);
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
    return this.pool.live;
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
    await Promise.all(borrowers.map((t) => this.pool.stop(t.id)));
  }

  /** Stops the thread's agent and forgets its session, so the next turn starts a new one. */
  private async forgetSession(threadId: string): Promise<void> {
    const stopped = this.pool.stop(threadId);
    // Its bridge stops with it: what it held opens nothing any more.
    this.coordinators.dropCoordinatorAccess(threadId);
    await stopped;
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

  /** Every question an agent holds its turn on, oldest first. */
  private pendingQuestions(): PendingQuestion[] {
    return [...this.pendingForms.keys()].flatMap((itemId): PendingQuestion[] => {
      const threadId = this.pendingPermissions.get(itemId)?.threadId;
      const item = threadId ? this.store.getItem(threadId, itemId) : undefined;
      if (!threadId || item?.kind !== "tool" || item.form !== "open" || !item.questions) return [];
      return [{ threadId, itemId, questions: item.questions, at: item.at }];
    });
  }

  private broadcastRequests(): void {
    this.broadcast({ type: "requests", requests: this.pendingRequests() });
    this.broadcast({ type: "questions", questions: this.pendingQuestions() });
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

  /**
   * Answers a permission request. `followUp`, the user's own words with a refusal, goes
   * to the agent as their next message as soon as the turn that asked is over.
   */
  respondToPermission(threadId: string, itemId: string, optionId: string, followUp?: string): void {
    const pending = this.pendingPermissions.get(itemId);
    const item = this.store.getItem(threadId, itemId);
    if (!pending || pending.threadId !== threadId || item?.kind !== "permission") {
      throw new Error("Cette demande n'attend plus de réponse.");
    }
    if (!item.options.some((o) => o.optionId === optionId)) throw new Error("Choix inconnu.");
    this.pendingPermissions.delete(itemId);
    if (followUp?.trim() && this.turns.has(threadId)) this.followUps.set(threadId, followUp.trim());
    this.putItem(threadId, { ...item, outcome: optionId });
    this.broadcastRequests();
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.updateThread(threadId, { status: "running" });
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  /** Answers a question the agent holds its turn on; the turn goes on with it. */
  respondToQuestion(threadId: string, itemId: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingPermissions.get(itemId);
    const asked = this.pendingForms.get(itemId);
    const item = this.store.getItem(threadId, itemId);
    if (!pending || !asked || pending.threadId !== threadId || item?.kind !== "tool") {
      throw new Error("Cette question n'attend plus de réponse.");
    }
    const content = formContent(asked.form, answers);
    if (asked.form.fields.some((f) => !(f.key in content) && !(f.custom && f.custom in content))) {
      throw new Error("Réponds à chaque question.");
    }
    this.pendingPermissions.delete(itemId);
    this.pendingForms.delete(itemId);
    this.putItem(threadId, {
      ...item,
      form: "answered",
      status: "completed",
      answers: asked.form.fields.map((f) =>
        [content[f.key] ?? [], f.custom ? (content[f.custom] ?? []) : []].flat().join(", "),
      ),
    });
    this.broadcastRequests();
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.updateThread(threadId, { status: "running" });
    }
    asked.answer({ action: "accept", content });
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

  addMcpServer(input: McpServerInput): Promise<string> {
    return this.catalog.addMcpServer(input);
  }

  toggleFavorite(agentId: string, model: string, starred: boolean): void {
    this.catalog.toggleFavorite(agentId, model, starred);
  }

  /** Brings the search's index up to date in the background, a stretch at a time. */
  private indexSearchSoon(): void {
    if (this.indexTimer || this.closed) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      if (this.closed) return;
      try {
        if (this.store.indexSearch(INDEX_STRETCH_MS)) this.indexSearchSoon();
      } catch (error) {
        // The search fills its index itself before it answers: nothing is lost here.
        console.warn("Index de recherche :", error);
      }
    }, INDEX_PAUSE_MS);
    this.indexTimer.unref();
  }

  /** Stops every agent and resolves once their turns have ended. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.indexTimer);
    clearInterval(this.prTimer);
    this.quotas.close();
    this.scheduler.close();
    this.teams.close();
    // A review starting reads the changes first; it must not reach the store once closed.
    await this.teams.settled();
    this.pool.clearTimers();
    for (const timer of this.forceStops.values()) clearTimeout(timer);
    this.forceStops.clear();
    await this.recovered;
    for (const threadId of new Set([...this.pendingPermissions.values()].map((p) => p.threadId))) {
      this.settlePermissions(threadId);
    }
    await this.catalog.close();
    // An agent still starting is stopped now rather than waited for, and its turn ends
    // as stopped, not as failed.
    // A turn in line is stopped too, as one whose agent was starting.
    for (const threadId of this.line.threads()) {
      this.cancelled.add(threadId);
      this.line.leave(threadId);
    }
    for (const threadId of this.pool.startingThreads()) {
      this.cancelled.add(threadId);
      this.pool.abortStart(threadId);
    }
    await this.pool.closeAll();
    await Promise.all(this.turns.values());
    await Promise.all([...this.steps].map((step) => step.catch(() => undefined)));
    // A turn that ended meanwhile armed no timer (closed), but leaves nothing behind either.
    this.pool.clear();
    // Text an agent sent after its turn ended is still written down.
    for (const threadId of this.drafts.keys()) this.flushText(threadId);
  }

  private async runTurn(
    thread: Thread,
    text: string,
    itemId: string,
    context?: string,
    /** Waits for a place when the server runs as many turns as it may. */
    queued?: boolean,
    images: readonly ImageRef[] = [],
  ): Promise<void> {
    try {
      // Behind those already in line, so none is overtaken.
      if (queued && (this.line.size > 0 || this.turnsAtWork() >= this.maxTurns())) {
        this.updateThread(thread.id, { inLine: true });
        await this.line.wait(thread.id);
        if (this.store.getThread(thread.id)) this.updateThread(thread.id, { inLine: null });
        if (this.cancelled.has(thread.id)) {
          this.updateThread(thread.id, { status: "idle" });
          return;
        }
      }
      const continuing = this.pool.has(thread.id);
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
          ? historyBefore(
              this.items(thread.id),
              itemId,
              this.catalog.name,
              (id) => this.attachments.find(thread.id, id)?.file,
            )
          : undefined;
      const said = text.trim() || !images.length ? text : IMAGES_ONLY;
      const prompt = context ? `${context}\n\n${said}` : said;
      const stopReason = await session.prompt(prompt, history, [
        ...this.linksFor(session, text),
        ...this.attachments.blocks(thread.id, images, !!session.promptCapabilities.image),
      ]);
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
    const existing = this.pool.get(thread.id);
    if (existing) return existing;
    const project = this.store.getProject(thread.projectId);
    if (!project) return Promise.reject(new Error("Projet introuvable."));
    const started = this.pool.open(thread.id, (signal, owns) =>
      this.prepareWorkspace(thread.id, project).then((cwd) =>
        this.startSession(thread, cwd, signal, owns),
      ),
    );
    started.then(
      (s) => this.store.setSessionId(thread.id, s.sessionId),
      () => undefined,
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
    const coordinatorMcp = this.coordinators.coordinatorServer(thread);
    const catalogMcp = mcpServersFor(await this.catalog.mcpServers(), thread);
    const userMcp =
      thread.kind === "coordinator"
        ? catalogMcp.filter((s) => s.name.trim().toLowerCase() !== RESERVED_MCP_NAME)
        : catalogMcp;
    const session = await AgentSession.start({
      launch: this.agents.launch(thread.agentId),
      cwd,
      previousSessionId: this.store.getSessionId(thread.id),
      mcpServers: [...userMcp, ...coordinatorMcp],
      signal: AbortSignal.any([stop, AbortSignal.timeout(START_TIMEOUT_MS)]),
      handlers: {
        onUpdate: (update) => this.applyUpdate(thread.id, update),
        onQuiet: (since) => {
          if (this.closed || !this.store.getThread(thread.id)) return;
          this.updateThread(thread.id, { quietSince: since ?? null });
        },
        requestPermission: (request, signal) => this.requestPermission(thread.id, request, signal),
        elicit: (request, signal) => this.requestForm(thread.id, request, signal),
        onExit: (reason) => {
          if (!owns()) return;
          this.pool.exited(thread.id);
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
      case "plan": {
        const id = `plan:${this.turnIds.get(threadId) ?? "late"}`;
        const before = this.store.getItem(threadId, id);
        const now = Date.now();
        this.putItem(threadId, {
          id,
          kind: "plan",
          entries: mergePlan(
            before?.kind === "plan" ? before.entries : undefined,
            update.entries.map((e) => ({ content: e.content, status: e.status })),
            now,
          ),
          at: before?.at ?? now,
        });
        return;
      }
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
    const rev = this.log(threadId).touch(draft.item.id);
    this.sendToViewers(threadId, { type: "append", threadId, itemId: draft.item.id, text, rev });
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

  private log(threadId: string): TimelineLog {
    let log = this.logs.get(threadId);
    if (!log) this.logs.set(threadId, (log = new TimelineLog()));
    return log;
  }

  /**
   * The thread as a screen gets it on opening: the end of its timeline, a page of it, with
   * large tool results left here until asked for, and the mark to come back with.
   */
  private opening(threadId: string): ServerMessage {
    // Written down, but kept open: the agent may still be adding to it.
    this.flushText(threadId, false);
    const page = this.store.pageItems(threadId);
    return {
      type: "items",
      threadId,
      items: page.items.map(light),
      first: page.first,
      earlier: page.earlier,
      epoch: this.epoch,
      rev: this.log(threadId).rev,
    };
  }

  /**
   * What a screen that held the thread up to `since` is missing: the items changed since,
   * those it holds or that came after. Nothing when it is no longer known, after a restart,
   * a step back or too many changes: the screen is then sent the timeline's end again.
   */
  private changesSince(
    threadId: string,
    since: { epoch: string; rev: number; first: number } | undefined,
  ): ServerMessage | undefined {
    if (since?.epoch !== this.epoch) return undefined;
    const log = this.log(threadId);
    const ids = log.since(since.rev);
    if (!ids) return undefined;
    this.flushText(threadId, false);
    const items = ids
      .map((id) => this.store.getItemAt(threadId, id))
      .filter((found) => found !== undefined && found.seq >= since.first)
      .map((found) => ({ item: light(found!.item), seq: found!.seq }))
      .sort((a, b) => a.seq - b.seq);
    return { type: "changes", threadId, items, rev: log.rev };
  }

  /** Items were removed from the timeline: every screen showing it gets its end again. */
  private timelineCut(threadId: string): void {
    this.log(threadId).reset();
    this.sendToViewers(threadId, this.opening(threadId));
  }

  private upsertTool(threadId: string, update: acp.ToolCall | acp.ToolCallUpdate): void {
    // Agents may number their tool calls from scratch on every turn or session, so the turn
    // is part of the item's id: a later call never replaces an earlier turn's card.
    const id = `tool:${this.turnIds.get(threadId) ?? "late"}:${update.toolCallId}`;
    const existing = this.store.getItem(threadId, id) as ToolItem | undefined;
    const content = update.content ? toolContent(update.content) : undefined;
    const questions = toolQuestions(update.rawInput) ?? existing?.questions;
    // A new call joins the step of the agent's plan it is on.
    if (!existing && update.title) {
      const planId = `plan:${this.turnIds.get(threadId) ?? "late"}`;
      const plan = this.store.getItem(threadId, planId);
      const entries = plan?.kind === "plan" ? noteTool(plan.entries, update.title) : undefined;
      if (plan?.kind === "plan" && entries) this.putItem(threadId, { ...plan, entries });
    }
    this.putItem(threadId, {
      id,
      kind: "tool",
      title: update.title ?? existing?.title ?? "Outil",
      toolKind: update.kind ?? existing?.toolKind ?? "other",
      status: update.status ?? existing?.status ?? "pending",
      content: content ?? existing?.content ?? [],
      ...(questions ? { questions } : {}),
      // A question the agent holds its turn on keeps what the form asked and its answer.
      ...(existing?.form
        ? {
            form: existing.form,
            questions: existing.questions ?? questions ?? [],
            ...(existing.answers ? { answers: existing.answers } : {}),
          }
        : {}),
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
    // A coordinator only reads and routes; a team reviewer may also run read-only shell checks
    // (Codex reads files via execute), while file edits, fetches and unknown tools wait on the user.
    const allowed =
      thread.kind === "coordinator"
        ? COORDINATOR_ALLOWED
        : thread.role === "reviewer"
          ? REVIEWER_ALLOWED
          : undefined;
    const readOnlyDenied = !!allowed && !allowed.has(request.toolCall.kind ?? "");
    // MoonAgentic's own tools are the coordinator's work, already limited by the server:
    // asking the user before each one would make it useless.
    this.noteToolName(threadId, request.toolCall);
    // An agent that does not name the tool is taken at its title, for a call of no known kind:
    // never a change of files nor a command.
    const named = this.toolNames.get(threadId)?.get(request.toolCall.toolCallId);
    const own =
      thread.kind === "coordinator" &&
      !!this.coordinatorUrl &&
      (named !== undefined
        ? OWN_TOOL.test(named)
        : OWN_TOOL.test(request.toolCall.title ?? "") &&
          (!request.toolCall.kind || request.toolCall.kind === "other"));
    if ((thread.permissionMode === "full" && !readOnlyDenied) || own) {
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
    // Waiting for the user takes no place: the next turn in line may start.
    this.admit();
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, { threadId, resolve });
      this.broadcastRequests();
      signal.addEventListener("abort", () => this.settlePermission(id), { once: true });
    });
  }

  /**
   * A question the agent asks with a form and holds its turn on (Claude Code's own questions).
   * It waits above the composer like a permission request; a form that is not made of
   * choices, or asked where nobody answers (a team's member), is declined at once.
   */
  private requestForm(
    threadId: string,
    request: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> {
    const thread = this.requireThread(threadId);
    const asked = request as { mode?: unknown; requestedSchema?: unknown; toolCallId?: unknown };
    const form =
      asked.mode === "form" ? formQuestions(request.message, asked.requestedSchema) : undefined;
    if (!form || thread.parentId || signal.aborted) return Promise.resolve({ action: "decline" });
    // The question is the tool call's own card when the agent names it, else a card of its own.
    const call =
      typeof asked.toolCallId === "string"
        ? `tool:${this.turnIds.get(threadId) ?? "late"}:${asked.toolCallId}`
        : undefined;
    const existing = call
      ? (this.store.getItem(threadId, call) as ToolItem | undefined)
      : undefined;
    const id = existing?.kind === "tool" && call ? call : `tool:ask:${randomUUID()}`;
    this.putItem(threadId, {
      id,
      kind: "tool",
      title: existing?.title ?? "Question",
      toolKind: existing?.toolKind ?? "other",
      status: "pending",
      content: existing?.content ?? [],
      questions: form.questions,
      form: "open",
      at: existing?.at ?? Date.now(),
    });
    this.updateThread(threadId, { status: "waiting" });
    // Waiting for the user takes no place: the next turn in line may start.
    this.admit();
    return new Promise((resolve) => {
      this.pendingForms.set(id, { form, answer: resolve });
      // Cancelled as a permission request is: by a stop, or by the agent ending.
      this.pendingPermissions.set(id, { threadId, resolve: () => resolve({ action: "cancel" }) });
      this.broadcastRequests();
      signal.addEventListener("abort", () => this.settlePermission(id), { once: true });
    });
  }

  /**
   * Asks the user once before a supervised coordinator launches a saved full-access team.
   * Reuses the same permission card and « À traiter » queue as agent permissions.
   */
  private confirmTeamPermission(
    coordinatorId: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<PermissionMode | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const preview = summaryOf(task, 80);
    const id = `permission:${randomUUID()}`;
    this.putItem(coordinatorId, {
      id,
      kind: "permission",
      title: preview
        ? `Lancer l'équipe en accès complet : ${preview}`
        : "Lancer l'équipe en accès complet",
      options: [
        { optionId: "full", name: "Autoriser en accès complet", kind: "allow_once" },
        { optionId: "supervised", name: "Lancer en supervisé", kind: "allow_once" },
        { optionId: "reject", name: "Refuser", kind: "reject_once" },
      ],
      outcome: null,
      at: Date.now(),
    });
    this.updateThread(coordinatorId, { status: "waiting" });
    this.admit();
    return new Promise<PermissionMode | null>((resolve) => {
      const onAbort = () => {
        this.settlePermission(id);
        if (
          this.store.getThread(coordinatorId)?.status === "waiting" &&
          ![...this.pendingPermissions.values()].some((p) => p.threadId === coordinatorId)
        ) {
          this.updateThread(coordinatorId, {
            status: this.turns.has(coordinatorId) ? "running" : "idle",
          });
        }
      };
      const done = (response: acp.RequestPermissionResponse) => {
        signal?.removeEventListener("abort", onAbort);
        if (response.outcome.outcome !== "selected") return resolve(null);
        if (response.outcome.optionId === "full") return resolve("full");
        if (response.outcome.optionId === "supervised") return resolve("supervised");
        resolve(null);
      };
      this.pendingPermissions.set(id, { threadId: coordinatorId, resolve: done });
      this.broadcastRequests();
      signal?.addEventListener("abort", onAbort, { once: true });
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
    if (this.pendingForms.delete(itemId) && item?.kind === "tool")
      this.putItem(pending.threadId, { ...item, form: "cancelled", status: "failed" });
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
    const seq = this.store.putItem(threadId, item);
    const rev = this.log(threadId).touch(item.id);
    this.sendToViewers(threadId, { type: "item", threadId, item: light(item), seq, rev });
  }

  private updateThread(threadId: string, patch: Parameters<Store["updateThread"]>[1]): void {
    this.broadcast({ type: "thread", thread: this.store.updateThread(threadId, patch) });
  }

  private sendToViewers(threadId: string, message: ServerMessage): void {
    for (const client of this.clients)
      if (client.openThreadIds?.has(threadId)) client.send(message);
  }

  /** Tells every client how a sign-in to GitHub started from MoonAgentic ended. */
  githubLoginEnded(result: LoginResult): void {
    this.broadcast({ type: "githubLogin", ...result });
  }

  /**
   * Where new projects go, and the git folders already on this machine: the projects', those
   * around them, and those in the home folder two levels down.
   */
  private async localClones() {
    const projects = this.store.listProjects();
    const parent = defaultParent(projects, this.homeDir);
    const roots = [
      { dir: parent, depth: 1 },
      ...projects.map((p) => ({ dir: path.dirname(p.path), depth: 1 })),
      ...usualRoots(this.homeDir),
    ];
    return { parent, clones: await findClones(roots, projects) };
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }
}

export { CoordinatorRefused, coordinatorPrompt } from "./coordinator.ts";
