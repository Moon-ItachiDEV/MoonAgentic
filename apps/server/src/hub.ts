import { AttachmentRefused, Attachments } from "./attachments.ts";
import { ArtifactLinks, artifactUrl, findArtifacts } from "./artifacts.ts";
import type { AgentProcessRef, DiagnosticsMonitor } from "./diagnostics.ts";
import { COMPUTER_ACTOR, ProjectLocks } from "./locks.ts";
import {
  linkClaude,
  readSetup,
  removeCommand,
  removeSkill,
  saveCommand,
  saveRules,
  saveSkill,
} from "./project-setup.ts";
import { Push, type PushSend } from "./push.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_STOPPED,
  DEFAULT_MAX_TURNS,
  GOAL_MORE_TURNS,
  GOAL_TURNS,
  MAX_QUEUED_MESSAGES,
  PR_WATCH_TRIES,
  RESUME_TEXT,
  threadPullRequest,
} from "@moonagentic/protocol";
import type {
  CustomAgentInput,
  Defaults,
  TeamPreset,
  AgentSetting,
  ClientMessage,
  ImageRef,
  Item,
  Mascot,
  McpServerInput,
  PendingQuestion,
  PendingRequest,
  QuestionAnswer,
  PermissionMode,
  Project,
  PullRequestInfo,
  PullRequestRemark,
  QueuedMessage,
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
import { goalContext, goalMessage, goalVerdict } from "./goal.ts";
import { nextFix, remarksMessage } from "./pr-watch.ts";
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
  fetchPullRequest,
  forkPoint,
  githubRemote,
  removeWorktree,
  deleteBranch,
  worktreeStart,
  branchName,
  dropCheckpoints,
  gitCommonDir,
  gitRootCommonDir,
  isGitRepo,
  isSameOrInside,
  pathsOverlap,
  restoreCheckpoint,
  reviewChanges,
  samePath,
  saveCheckpoint,
  ship,
  type MergeForecast,
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
import { type BranchOwner, deleteMergedBranches, projectBranches } from "./branches.ts";
import { AgentCatalog, agentCommands } from "./catalog.ts";
import { Coordinators, TEAM_PRESETS_SETTING } from "./coordinator.ts";
import { historyBefore } from "./history.ts";
import { cardText, Planner } from "./planner.ts";
import { COORDINATOR_TOOLS } from "./coordinator-tools.ts";
import { localPullRequests, parsePullRequestUrl, type PullRequests } from "./pull-request.ts";
import { Scheduler } from "./scheduler.ts";
import { diffText, shipTarget, Teams, teamStatus } from "./team.ts";
import { PrReviews, REVIEW_DIFF_LIMIT, reviewPrompt, reviewStatus } from "./pr-review.ts";
import { mcpServersFor, RESERVED_MCP_NAME } from "./mcp.ts";
import { type QuotaReader, Quotas } from "./quotas.ts";
import { formContent, formQuestions, toolQuestions, type FormQuestions } from "./questions.ts";
import { AgentSession, describe, needsSignIn, SettingTimeout } from "./session.ts";
import { AgentPool } from "./sessions.ts";
import { light, TimelineLog } from "./timeline.ts";
import { TurnLine } from "./turn-line.ts";
import { sweepWorktrees } from "./worktree-sweep.ts";
import type { Store } from "./store.ts";
import {
  forecastFor,
  listedWorktreeFile,
  readWorktreeFile,
  rejectReviewFile,
  syncWorkspace,
  worktreeFiles,
} from "./workspace.ts";

export interface Client {
  send(message: ServerMessage): void;
  /** The paired device that opened it; none for the computer itself. */
  deviceId?: string;
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

/** How the ACP connection says the agent's process went away. */
const CONNECTION_CLOSED = /\bconnection closed\b/i;

/** A thread's error when its agent stopped mid-turn: plain words first, the detail after. */
const stoppedError = (detail: string): string => {
  const rest = detail.trim();
  return rest ? `${AGENT_STOPPED}\n${rest}` : AGENT_STOPPED;
};

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

const ONLY_ON_COMPUTER = "Seul l'ordinateur où tourne MoonAgentic peut faire ça.";
/** Lock code creation, change, and reset are reserved to the computer running MoonAgentic. */
const COMPUTER_ONLY_MESSAGES = new Set<ClientMessage["type"]>(["lock.setPin", "lock.reset"]);

export interface HubOptions {
  /** MoonAgentic's own private data folder (`~/.moonagentic`), refused as a project path. */
  dataDir?: string;
  /** Where threads with their own branch get their worktree. */
  worktreesDir: string;
  /** How Web Push messages are sent; to push services over the network when not given. */
  pushSend?: PushSend;
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
/** The user's defaults for a new thread, the same on every device. */
const DEFAULTS = "defaults";
/** Each project's icon and tint, as set in its settings. */
const PROJECT_LOOKS = "projectLooks";
type ProjectLook = Pick<Project, "icon" | "color">;

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
const REVIEW_AT_WORK = "Cette revue est en cours : arrête-la d'abord.";

/** A step back under way, kept until it is done so a stop in the middle is finished later. */
type PendingRestore = { itemId: string; tree: string };

/** Owns threads and their agent sessions, and keeps every connected client in sync. */
/**
 * How long closing waits in all, within the 15 s the server gives itself to stop
 * (server.ts): what is left after it is cut short.
 */
const CLOSE_LIMIT_MS = 11_000;
/** How often the worktrees no thread holds any more are looked for. */
const SWEEP_EVERY_MS = 24 * 60 * 60_000;

/** Resolves once `work` settles, or after `ms` at most; a failure of `work` is not passed on. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

export class Hub {
  private readonly store: Store;
  private readonly agents: Agents;
  private readonly clients = new Set<Client>();
  /** The agents running for threads. */
  private readonly pool: AgentPool;
  private readonly turns = new Map<string, Promise<void>>();
  /** Threads whose running turn the user asked to stop. */
  private readonly cancelled = new Set<string>();
  /** Threads whose turn was stopped so that a message that waits goes at once. */
  private readonly sendAfterStop = new Set<string>();
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
  /** Threads whose turn fixes their pull request: their branch is pushed once it ends. */
  private readonly prFixing = new Set<string>();
  private readonly pendingForms = new Map<
    string,
    { form: FormQuestions; answer: (r: acp.CreateElicitationResponse) => void }
  >();

  /** MoonAgentic's own private data folder, when passed by the server. */
  private readonly dataDir: string | undefined;
  /** Where threads with their own branch get their worktree. */
  private readonly worktreesDir: string;
  /** The images sent with messages. */
  readonly attachments: Attachments;
  /** The notifications sent to phones while MoonAgentic is closed. */
  readonly push: Push;
  /** The projects locked with /lock, and the code that opens them. */
  readonly locks: ProjectLocks;
  /** The project of each thread looked at while some are locked: a thread never moves. */
  private readonly threadProjects = new Map<string, string>();
  /** The addresses artifacts are shown from, each for one thread's folder. */
  readonly artifactLinks = new ArtifactLinks((id) => {
    const thread = this.store.getThread(id);
    // A locked project's files are not shown either, even from an address given before.
    return thread && !thread.archived && !this.locks.isLocked(thread.projectId)
      ? thread.workspace
      : undefined;
  });
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
  /** Optional runtime crash & performance monitor attached by the server. */
  private diagnostics: DiagnosticsMonitor | undefined;
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
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(store: Store, agents: Agents, options: HubOptions) {
    this.store = store;
    this.locks = new ProjectLocks(store);
    this.agents = agents;
    this.dataDir = options.dataDir;
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
    this.push = new Push(store, {
      ...(options.pushSend ? { send: options.pushSend } : {}),
      onError: (error) => console.error("Notifications push :", error),
      // A locked project's thread titles stay on this computer.
      quiet: (projectId) => this.locks.isLocked(projectId),
    });
    this.push.know(store.listThreads());
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
    this.reviews = new PrReviews({
      thread: (id) => this.store.getThread(id),
      threads: () => this.store.listThreads(),
      createThread: (input) => this.createThread({ ...input, byTeam: true }),
      send: (id, text) => this.send(id, text, undefined, true),
      cancel: (id) => this.cancel(id),
      setReview: (id, prReview) => this.updateThread(id, { prReview }),
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
      queueMessage: (...args) => this.queueMessage(...args),
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
    this.reviews.recover();
    // Once the threads say what they really are: a turn the last stop cut short is over,
    // and its card must not stay at work.
    this.planner.syncThreads();
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
      // A goal at work when the server stopped goes on where it was, a turn further.
      for (const t of this.store.listThreads()) {
        if (t.goal?.state === "active") this.continueGoal(t.id);
      }
      this.sweepSoon();
    });
  }

  /**
   * Removes the worktrees no thread holds any more, now and then once a day: a server left
   * on for months would otherwise fill its disk with them.
   */
  private sweepSoon(): void {
    const sweep = () => {
      if (this.closed) return;
      const step = sweepWorktrees(this.worktreesDir, () => this.heldWorktrees())
        .then((removed) => {
          if (removed.length)
            console.log(`Copies de travail sans fil retirées : ${removed.join(", ")}`);
        })
        .catch((error: unknown) => console.error("Nettoyage des copies de travail :", error));
      this.steps.add(step);
      void step.finally(() => this.steps.delete(step));
    };
    sweep();
    this.sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
    this.sweepTimer.unref();
  }

  /** The folders of the worktrees folder that a thread holds, archived ones included. */
  private heldWorktrees(): string[] {
    const held: string[] = [];
    for (const thread of this.store.listThreads()) {
      const dir = thread.workspace?.path;
      if (!dir || !this.isOurWorktree(dir)) continue;
      held.push(path.relative(this.worktreesDir, dir).split(/[\\/]/)[0]!);
    }
    return held;
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
  /** Reviews of pull requests by several agents, each run from its own thread. */
  readonly reviews: PrReviews;

  /** Resolves once the steps back that a stop interrupted are finished. */
  readonly recovered: Promise<void>;

  connect(client: Client): () => void {
    // Everything sent to it goes through what /lock lets out, replies as much as news.
    const send = client.send.bind(client);
    client.send = (message) => {
      const shown = this.shown(message);
      if (shown) send(shown);
    };
    this.clients.add(client);
    this.quotas.onClientConnect();
    client.send({ type: "snapshot", snapshot: this.snapshot(!!client.deviceId) });
    return () => this.clients.delete(client);
  }

  snapshot(pairedDevice = false): Snapshot {
    const mcpSecretsError = this.catalog.mcpSecretsError();
    const defaults = this.store.getSetting<Defaults | null>(DEFAULTS, null);
    const presets = this.store.getSetting<TeamPreset[] | null>(TEAM_PRESETS_SETTING, null);
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
      ...(this.locks.hasPin() ? { lockPin: true } : {}),
      ...(pairedDevice ? { pairedDevice: true } : {}),
      ...(defaults ? { defaults } : {}),
      ...(presets ? { teamPresets: presets } : {}),
    };
  }

  private projectOfThread(threadId: string): string | undefined {
    let projectId = this.threadProjects.get(threadId);
    if (projectId === undefined) {
      projectId = this.store.getThread(threadId)?.projectId;
      if (projectId) this.threadProjects.set(threadId, projectId);
    }
    return projectId;
  }

  /** Whether the thread is of a locked project: its images are not sent either. */
  lockedThread(threadId: string): boolean {
    return this.locks.isLocked(this.projectOfThread(threadId));
  }

  /**
   * What a window may see of a message while projects are locked: nothing of a locked
   * project's threads, timelines, requests, cards, plans, files or search hits. Null when
   * nothing of it is left.
   */
  private shown(message: ServerMessage): ServerMessage | null {
    if (!this.locks.any()) return message;
    const locked = (projectId: string) => this.locks.isLocked(projectId);
    const free = (threadId: string) => !this.lockedThread(threadId);
    switch (message.type) {
      case "snapshot": {
        const s = message.snapshot;
        return {
          ...message,
          snapshot: {
            ...s,
            threads: s.threads.filter((t) => !locked(t.projectId)),
            requests: s.requests.filter((r) => free(r.threadId)),
            questions: s.questions.filter((q) => free(q.threadId)),
            plan: s.plan.filter((c) => !locked(c.projectId)),
            schedules: s.schedules.filter((p) => !locked(p.projectId)),
          },
        };
      }
      case "thread":
        return locked(message.thread.projectId) ? null : message;
      case "requests":
        return { ...message, requests: message.requests.filter((r) => free(r.threadId)) };
      case "questions":
        return { ...message, questions: message.questions.filter((q) => free(q.threadId)) };
      case "planTask":
        return locked(message.task.projectId) ? null : message;
      case "schedule":
        return locked(message.schedule.projectId) ? null : message;
      case "artifacts":
        return { ...message, artifacts: message.artifacts.filter((a) => !locked(a.projectId)) };
      case "searched":
        return { ...message, hits: message.hits.filter((h) => free(h.threadId)) };
      case "projectBranches":
      case "branchesDeleted":
        return locked(message.projectId) ? null : message;
      default:
        // Whatever names a thread: its timeline, its review, its files, its pull request.
        return "threadId" in message && typeof message.threadId === "string"
          ? free(message.threadId)
            ? message
            : null
          : message;
    }
  }

  /**
   * Refuses whatever touches a locked project, but the code that opens it. True when the
   * message is to be left without a word: a window opening again, after a reconnection, a
   * thread it showed before the lock.
   */
  private refuseLocked(message: ClientMessage): boolean {
    if (!this.locks.any() || message.type.startsWith("lock.")) return false;
    if (message.type === "ping" || message.type === "thread.leave") return false;
    if (message.type === "thread.open") return this.lockedThread(message.threadId);
    const lockedError = () => {
      throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
    };
    if (message.type === "mcp.add") {
      if (message.server.projectIds?.some((p) => this.locks.isLocked(p))) lockedError();
      return false;
    }
    if (message.type === "mcp.setScope") {
      const current = this.catalog.mcpServerInfos().find((s) => s.id === message.id);
      if (
        current?.projectIds?.some((p) => this.locks.isLocked(p)) ||
        message.projectIds?.some((p) => this.locks.isLocked(p))
      ) {
        lockedError();
      }
      return false;
    }
    if (message.type === "mcp.setEnabled" || message.type === "mcp.remove") {
      const current = this.catalog.mcpServerInfos().find((s) => s.id === message.id);
      if (current?.projectIds?.some((p) => this.locks.isLocked(p))) lockedError();
      return false;
    }
    const projects: (string | undefined)[] = [];
    if ("projectId" in message && typeof message.projectId === "string") {
      projects.push(message.projectId);
    }
    if ("threadId" in message && typeof message.threadId === "string") {
      projects.push(this.projectOfThread(message.threadId));
    }
    if ("id" in message && typeof message.id === "string") {
      if (message.type.startsWith("plan.")) {
        projects.push(this.store.getPlanTask(message.id)?.projectId);
      } else if (message.type.startsWith("schedule.")) {
        projects.push(this.store.getSchedule(message.id)?.projectId);
      }
    }
    if (projects.some((p) => this.locks.isLocked(p))) lockedError();
    return false;
  }

  /** Every window gets the whole state again, as /lock now lets it out. */
  private sendSnapshots(): void {
    const owner = this.snapshot(false);
    let paired: Snapshot | undefined;
    for (const client of this.clients) {
      const snapshot = client.deviceId ? (paired ??= { ...owner, pairedDevice: true }) : owner;
      client.send({ type: "snapshot", snapshot });
    }
  }

  async handle(client: Client, message: ClientMessage): Promise<void> {
    if (client.deviceId && COMPUTER_ONLY_MESSAGES.has(message.type)) {
      throw new Error(ONLY_ON_COMPUTER);
    }
    if (this.refuseLocked(message)) return;
    switch (message.type) {
      case "ping":
        client.send({ type: "pong" });
        return;
      case "project.create": {
        const id = this.createProject(message.name, message.path);
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
      case "project.discussions": {
        const id = this.discussionsProject();
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
          if (this.locks.isLocked(twin.projectId)) {
            throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
          }
          client.send({ type: "created", requestId: message.requestId, id: twin.projectId });
          return;
        }
        const folderName = message.name?.trim() || wanted?.name || "";
        if (folderName && !/[\\/]/.test(folderName) && folderName !== "." && folderName !== "..") {
          const parent = path.resolve(message.parent.replace(/^~(?=$|[\\/])/, os.homedir()));
          this.assertProjectPathAllowed(path.join(parent, folderName));
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
        if (known && this.locks.isLocked(known.id)) {
          throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
        }
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
      case "workspace.prRemarks": {
        const reply = await this.pullRequestRemarks(message.threadId).then(
          (found) => ({
            type: "prRemarks" as const,
            requestId: message.requestId,
            remarks: found?.remarks ?? [],
            ...(found ? { number: found.pr.number } : {}),
          }),
          (error: unknown) => ({
            type: "prRemarks" as const,
            requestId: message.requestId,
            remarks: [],
            error: describe(error),
          }),
        );
        client.send(reply);
        return;
      }
      case "workspace.sendRemarks":
        await this.sendRemarks(message.threadId, message.ids);
        client.send({ type: "done", requestId: message.requestId });
        return;
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
      case "thread.send":
        this.sendByUser(message.threadId, message.text, message.attachments);
        return;
      case "thread.queue":
        this.queueMessage(message.threadId, message.text);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.queueEdit":
        this.editQueued(message.threadId, message.id, message.text);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.queueSend":
        this.sendQueuedNow(message.threadId, message.id);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.goal":
        this.setGoal(message.threadId, message.text, message.maxTurns);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.watchPr":
        this.watchPr(message.threadId, message.on);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "thread.goalControl":
        this.controlGoal(message.threadId, message.action);
        client.send({ type: "done", requestId: message.requestId });
        return;
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
      case "thread.resume":
        this.resume(message.threadId);
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
      case "defaults.set": {
        const current = this.store.getSetting<Defaults | null>(DEFAULTS, null);
        const defaults: Defaults = {
          permissionMode: message.permissionMode ?? current?.permissionMode ?? "supervised",
          isolated: message.isolated ?? current?.isolated ?? true,
        };
        this.store.setSetting(DEFAULTS, defaults);
        this.broadcast({ type: "defaults", defaults });
        return;
      }
      case "teamPresets.set":
        this.store.setSetting(TEAM_PRESETS_SETTING, message.presets);
        this.broadcast({ type: "teamPresets", presets: message.presets });
        return;
      case "project.setLook": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        const looks = Object.fromEntries(
          Object.entries(this.store.getSetting<Record<string, ProjectLook>>(PROJECT_LOOKS, {}))
            // Projects removed since are dropped on the way.
            .filter(([p]) => p !== project.id && this.store.getProject(p)),
        );
        const look: ProjectLook = {
          ...(message.icon ? { icon: message.icon } : {}),
          ...(message.color ? { color: message.color } : {}),
        };
        this.store.setSetting(
          PROJECT_LOOKS,
          look.icon || look.color ? { ...looks, [project.id]: look } : looks,
        );
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
      case "project.setup":
      case "project.saveRules":
      case "project.linkClaude":
      case "project.saveCommand":
      case "project.removeCommand":
      case "project.saveSkill":
      case "project.removeSkill": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        if (this.locks.isLocked(project.id)) {
          throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
        }
        const dir = project.path;
        switch (message.type) {
          case "project.saveRules":
            saveRules(dir, message.text);
            break;
          case "project.linkClaude":
            linkClaude(dir);
            break;
          case "project.saveCommand":
            saveCommand(dir, message);
            break;
          case "project.removeCommand":
            removeCommand(dir, message.name);
            break;
          case "project.saveSkill":
            saveSkill(dir, message);
            break;
          case "project.removeSkill":
            removeSkill(dir, message.path);
            break;
        }
        client.send({
          type: "projectSetup",
          requestId: message.requestId,
          projectId: project.id,
          setup: await readSetup(dir, !!this.withGit(project).git),
        });
        return;
      }
      case "lock.setPin":
        this.locks.setPin(message.pin, message.current, COMPUTER_ACTOR);
        this.sendSnapshots();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "lock.project":
        if (!this.store.getProject(message.projectId)) throw new Error("Projet introuvable.");
        this.locks.lock(message.projectId);
        this.sendSnapshots();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "lock.unlock":
        this.locks.unlock(message.projectId, message.pin, client.deviceId ?? COMPUTER_ACTOR);
        this.sendSnapshots();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "lock.reset":
        this.locks.reset();
        this.sendSnapshots();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "push.state":
        client.send({
          type: "pushState",
          requestId: message.requestId,
          publicKey: this.push.publicKey(),
          subscribed: !!message.endpoint && this.push.subscribed(message.endpoint, client.deviceId),
        });
        return;
      case "push.subscribe":
        this.push.subscribe(message, client.deviceId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "push.unsubscribe":
        this.push.unsubscribe(message.endpoint, client.deviceId);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "artifacts.list":
        client.send({
          type: "artifacts",
          requestId: message.requestId,
          // A locked project's folders are not even looked at, nor counted in the cap.
          ...(await findArtifacts(
            this.store.listThreads().filter((t) => !this.locks.isLocked(t.projectId)),
          )),
        });
        return;
      case "artifacts.open": {
        const workspace = this.requireLiveThread(message.threadId).workspace;
        if (!(await listedWorktreeFile(workspace, message.path))) {
          throw new Error("Ce fichier n'est plus dans la copie de travail de ce fil.");
        }
        const { ticket, expiresAt } = this.artifactLinks.issue(message.threadId, client.deviceId);
        client.send({
          type: "artifactLink",
          requestId: message.requestId,
          url: artifactUrl(ticket, message.path),
          expiresAt,
        });
        return;
      }
      case "project.branches":
        client.send({
          type: "projectBranches",
          requestId: message.requestId,
          projectId: message.projectId,
          ...(await projectBranches(this.gitProjectPath(message.projectId), this.branchOwners())),
        });
        return;
      case "project.deleteBranches":
        client.send({
          type: "branchesDeleted",
          requestId: message.requestId,
          projectId: message.projectId,
          ...(await deleteMergedBranches(
            this.gitProjectPath(message.projectId),
            this.branchOwners(),
            message.branches,
          )),
        });
        return;
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
      case "review.start": {
        const id = this.startPrReview(message);
        this.coordinators.setCoordinatorSettings({
          ...this.coordinators.coordinatorSettings(),
          review: (message.slots ?? message.reviewers).map((r) =>
            r ? { agentId: r.agentId, ...(r.model ? { model: r.model } : {}) } : null,
          ),
          reviewJudge: message.judge
            ? {
                agentId: message.judge.agentId,
                ...(message.judge.model ? { model: message.judge.model } : {}),
              }
            : null,
        });
        watch(client, id);
        client.send({ type: "created", requestId: message.requestId, id });
        client.send(this.opening(id));
        return;
      }
      case "review.stop":
        await this.reviews.stop(message.threadId);
        return;
      case "review.retry":
        this.reviews.retry(message.threadId, message.index);
        client.send({ type: "done", requestId: message.requestId });
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
      case "plan.run": {
        const id = this.planner.run(message.id, (card) =>
          this.createThread({
            projectId: card.projectId,
            agentId: message.agentId,
            permissionMode: message.permissionMode,
            model: message.model,
            isolated: message.isolated,
            title: card.title,
            text: cardText(card),
          }),
        );
        client.send({ type: "created", requestId: message.requestId, id });
        return;
      }
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
      case "activity": {
        this.flushAll();
        const offsetMs = message.tzOffset * 60_000;
        // From the start of the oldest day asked for, in the client's time zone.
        const today = Math.floor((Date.now() - offsetMs) / 86_400_000);
        const since = (today - message.days + 1) * 86_400_000 + offsetMs;
        client.send({
          type: "activity",
          requestId: message.requestId,
          // Not even how much a locked project's threads were written in.
          days: this.store.activityDays(since, offsetMs, this.locks.lockedProjects()),
          firstAt: this.store.firstThreadAt(this.locks.lockedProjects()),
        });
        return;
      }
      case "search":
        client.send({
          type: "searched",
          requestId: message.requestId,
          hits:
            (this.flushAll(),
            this.store.searchItems(message.query, 30, this.locks.lockedProjects())),
        });
        return;
      case "agent.setMascot":
        this.setMascot(message.agentId, message.mascot);
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
      case "workspace.rejectFile":
        await this.rejectFile(message.threadId, message.path, message.from);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "workspace.forecast":
        client.send({
          type: "forecast",
          requestId: message.requestId,
          threadId: message.threadId,
          ...(await this.forecast(message.threadId)),
        });
        return;
      case "workspace.files":
        client.send({
          type: "worktreeFiles",
          requestId: message.requestId,
          threadId: message.threadId,
          ...(await worktreeFiles(this.requireLiveThread(message.threadId).workspace)),
        });
        return;
      case "workspace.readFile":
        client.send({
          type: "worktreeFile",
          requestId: message.requestId,
          threadId: message.threadId,
          path: message.path,
          ...(await readWorktreeFile(
            this.requireLiveThread(message.threadId).workspace,
            message.path,
          )),
        });
        return;
      case "workspace.sync":
        await this.syncWithBase(message.threadId);
        client.send({ type: "done", requestId: message.requestId });
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

  /**
   * Refuses folders that would expose MoonAgentic's own internal data (`dataDir` / worktrees)
   * or bypass `/lock` via a parent folder, subfolder, symlink, or shared git repository.
   */
  private assertProjectPathAllowed(resolved: string): void {
    if (this.dataDir && pathsOverlap(resolved, this.dataDir)) {
      throw new Error(
        "Ce dossier contient les données internes de MoonAgentic et ne peut pas être ouvert comme projet.",
      );
    }
    if (isSameOrInside(resolved, this.worktreesDir)) {
      throw new Error(
        "Ce dossier appartient à MoonAgentic et ne peut pas être ouvert comme projet.",
      );
    }
    if (!this.locks.any()) return;
    let targetCommonDir: string | undefined | null = null;
    for (const p of this.store.listProjects()) {
      if (!this.locks.isLocked(p.id)) continue;
      if (pathsOverlap(resolved, p.path)) {
        throw new Error(
          "Ce dossier chevauche un projet verrouillé : saisis le code pour l'ouvrir.",
        );
      }
      // Only compare git repositories when the locked project is the root of its own repo,
      // not when it merely sits inside a git-tracked parent (such as a versioned home folder).
      // The target's repository is asked once, and a folder outside git skips the rest.
      if (targetCommonDir === null) {
        targetCommonDir = existsSync(resolved) ? gitCommonDir(resolved) : undefined;
      }
      if (targetCommonDir && existsSync(p.path) && gitRootCommonDir(p.path) === targetCommonDir) {
        throw new Error(
          "Ce dossier partage son dépôt git avec un projet verrouillé : saisis le code pour l'ouvrir.",
        );
      }
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
    if (known) {
      if (this.locks.isLocked(known.id)) {
        throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
      }
      return known.id;
    }
    this.assertProjectPathAllowed(resolved);
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

  /**
   * The project « Discussions », where conversations started without a project go: a folder
   * beside where projects are usually made, created the first time it is needed. One already made
   * is reused, wherever the next projects go.
   */
  discussionsProject(): string {
    const made = this.store
      .listProjects()
      .find((p) => p.name === "Discussions" && path.basename(p.path) === "Discussions");
    if (made && existsSync(made.path)) return made.id;
    const folder = path.join(defaultParent(this.store.listProjects(), this.homeDir), "Discussions");
    mkdirSync(folder, { recursive: true });
    return this.createProject("Discussions", folder);
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
    /** The text is a goal the agent works toward, over this many turns at most. */
    goal?: { maxTurns?: number | undefined } | undefined;
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
      ...(input.goal && input.text.trim() && !input.openedBy && !input.held
        ? {
            goal: {
              text: input.text.trim(),
              state: "active" as const,
              turns: 1,
              maxTurns: input.goal.maxTurns ?? GOAL_TURNS,
              startedAt: now,
            },
          }
        : {}),
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
            thread.goal ? goalContext(thread.goal) : undefined,
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

  /**
   * Starts « /revue » on a pull request of the project's GitHub repository: a thread of its
   * own, whose folder gets the pull request's last commit, then one reviewer thread per
   * agent, all reading in that folder at once. Returns the review's thread at once; what
   * goes wrong while the pull request is fetched is kept on it.
   */
  startPrReview(input: {
    projectId: string;
    pr: string;
    reviewers: { agentId: string; model?: string | undefined }[];
    judge?: { agentId: string; model?: string | undefined } | undefined;
    supervised?: boolean | undefined;
  }): string {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error("Projet introuvable.");
    if (!this.withGit(project).git) {
      throw new Error("Une revue a besoin d'un dépôt git relié à GitHub.");
    }
    const at = parsePullRequestUrl(input.pr);
    const typed = /^#?(\d{1,9})$/.exec(input.pr.trim());
    const number = at?.number ?? (typed ? Number(typed[1]) : undefined);
    if (!number) {
      throw new Error("Donne le numéro de la PR, ou son adresse : /revue 113.");
    }
    const reviewers = input.reviewers.map((r) => {
      this.agents.launch(r.agentId);
      return {
        agentId: r.agentId,
        ...(r.model ? { model: r.model } : {}),
        status: "waiting" as const,
      };
    });
    const first = reviewers[0]!;
    if (input.judge) this.agents.launch(input.judge.agentId);
    const id = this.createThread({
      projectId: project.id,
      // Its own agent answers what the user asks about the review, given what was found.
      agentId: first.agentId,
      ...(first.model ? { model: first.model } : {}),
      permissionMode: "supervised",
      isolated: false,
      text: "",
      title: `Revue de la PR #${number}`,
    });
    this.updateThread(id, {
      prReview: {
        phase: "preparing",
        repo: at?.repo ?? "",
        number,
        reviewers,
        ...(input.judge
          ? {
              judge: {
                agentId: input.judge.agentId,
                ...(input.judge.model ? { model: input.judge.model } : {}),
              },
            }
          : {}),
        ...(input.supervised ? { supervised: true as const } : {}),
        startedAt: Date.now(),
      },
    });
    const step = this.prepareReview(id, project, number, at?.repo).catch((error: unknown) => {
      const review = this.store.getThread(id)?.prReview;
      if (!review || this.closed) return;
      this.updateThread(id, {
        prReview: {
          ...review,
          phase: "failed",
          endedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
    this.steps.add(step);
    void step.finally(() => this.steps.delete(step));
    return id;
  }

  /** Fetches the pull request into a folder of the review's own, then starts its reviewers. */
  private async prepareReview(
    threadId: string,
    project: Project,
    number: number,
    asked: string | undefined,
  ): Promise<void> {
    const repo = await githubRemote(project.path);
    if (!repo) throw new Error("Ce projet n'est pas relié à un dépôt GitHub.");
    if (asked && asked.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`Cette PR est dans ${asked}, mais ce projet est ${repo}.`);
    }
    const github = this.pullRequests();
    if (!github) throw new Error("GitHub CLI (gh) est requis pour lire la PR.");
    const pr = await github.find(repo, String(number));
    if (!pr) throw new Error(`La PR #${number} n'existe pas dans ${repo}.`);
    const { head, mergeBase } = await fetchPullRequest(project.path, number, pr.head, pr.base);
    if (this.closed) return;
    const start = await worktreeStart(project.path);
    // The folder starts at the pull request's last commit; its changes are counted from
    // where it leaves its base, so the review panel shows the pull request.
    const workspace: Workspace = {
      branch: branchName(`revue-pr-${number}`, threadId),
      path: path.join(this.worktreesDir, threadId.slice(0, 8)),
      base: mergeBase,
      ...(start.subdir ? { subdir: start.subdir } : {}),
    };
    await ensureWorktree(project.path, workspace.path, workspace.branch, head);
    // Until the thread keeps it, the folder and its branch are nobody's: dropped when the
    // review was stopped, deleted or failed meanwhile, or they would stay on disk.
    const drop = async () => {
      await removeWorktree(project.path, workspace.path).catch(() => undefined);
      await deleteBranch(project.path, workspace.branch).catch(() => undefined);
    };
    let changes: Awaited<ReturnType<typeof reviewChanges>>;
    try {
      changes = await reviewChanges(workspace.path, mergeBase);
    } catch (error) {
      await drop();
      throw error;
    }
    const review = this.store.getThread(threadId)?.prReview;
    if (this.closed || !review || review.phase !== "preparing") return drop();
    this.updateThread(threadId, {
      workspace,
      prReview: {
        ...review,
        repo,
        title: pr.title,
        url: pr.url,
        head,
        base: pr.base,
      },
    });
    const prompt = reviewPrompt({
      repo,
      number,
      title: pr.title,
      url: pr.url,
      base: pr.base,
      head,
      diff: diffText(changes, REVIEW_DIFF_LIMIT),
      others: review.reviewers.length - 1,
    });
    this.reviews.start(threadId, prompt);
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
    if (thread?.prReview && !thread.parentId) return reviewStatus(thread.prReview);
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
  /** A message the user wrote, sent to the thread as theirs. */
  private sendByUser(threadId: string, text: string, attachments?: readonly string[]): void {
    // Written to by hand, a thread waiting in line starts now, its brief first.
    const held = this.store.getThread(threadId)?.held;
    this.send(
      threadId,
      held ? `${held}\n\n${text}` : text,
      this.leadContext(threadId) ?? this.coordinators.coordinatorContext(threadId),
      undefined,
      undefined,
      undefined,
      attachments,
    );
    // Only once it is sent: a refusal keeps the brief where it was.
    if (held) this.updateThread(threadId, { held: null });
  }

  /**
   * Takes a thread up again after its agent stopped. The agent is gone, so the next turn
   * starts a new session, with the thread's model as it is now: the user may have picked
   * another one meanwhile. What waits goes first; else the agent is asked to go on.
   */
  resume(threadId: string): void {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    if (thread.queue?.length && this.sendNextQueued(threadId)) return;
    this.sendByUser(threadId, RESUME_TEXT);
  }

  /**
   * Keeps a message for after the turn under way: the user's, or one the project's
   * coordinator leaves. With the thread free and nothing waiting before it, it is sent at
   * once: its turn ended while it was being written.
   */
  queueMessage(threadId: string, text: string, from?: "coordinator"): void {
    const thread = this.requireLiveThread(threadId);
    const queue = thread.queue ?? [];
    if (!this.turns.has(threadId) && queue.length === 0) {
      this.sendQueued(threadId, { text, ...(from ? { from } : {}) });
      return;
    }
    if (queue.length >= MAX_QUEUED_MESSAGES) {
      throw new Error(`${MAX_QUEUED_MESSAGES} messages attendent déjà : retires-en un d'abord.`);
    }
    this.updateThread(threadId, {
      queue: [...queue, { id: randomUUID(), text, ...(from ? { from } : {}), at: Date.now() }],
    });
  }

  /** Sends a message that waited as what it is: the user's own, or the coordinator's. */
  private sendQueued(threadId: string, message: Pick<QueuedMessage, "text" | "from">): void {
    if (message.from === "coordinator") {
      this.coordinators.sendFromCoordinator(threadId, message.text);
    } else this.sendByUser(threadId, message.text);
  }

  /** Changes a message that waits; an empty text takes it out. */
  editQueued(threadId: string, id: string, text: string): void {
    const queue = this.requireThread(threadId).queue ?? [];
    // Sent meanwhile: there is nothing left to change, and the screen already shows it.
    if (!queue.some((m) => m.id === id)) throw new Error("Ce message est déjà parti.");
    const next = text.trim()
      ? queue.map((m) => (m.id === id ? { ...m, text: text.trim() } : m))
      : queue.filter((m) => m.id !== id);
    this.updateThread(threadId, { queue: next });
  }

  /**
   * « Corriger tout seul »: from now on, a pull request of the thread's branch that fails its
   * checks or conflicts with its base sends the agent to fix it, a few times at most.
   */
  watchPr(threadId: string, on: boolean): void {
    const thread = this.requireLiveThread(threadId);
    if (!on) {
      // A fix under way is no longer pushed when its turn ends.
      this.prFixing.delete(threadId);
      this.updateThread(threadId, { prWatch: null });
      return;
    }
    if (!thread.workspace?.base || thread.team || thread.role || thread.parentId) {
      throw new Error("Seul un fil qui travaille sur sa propre branche peut corriger sa PR.");
    }
    // Turned on again, it counts afresh, and may take up what it had given up on.
    this.updateThread(threadId, { prWatch: { tries: 0, max: PR_WATCH_TRIES } });
    if (this.closed) return;
    const asked = this.pullRequest(threadId).catch(() => undefined);
    this.steps.add(asked);
    void asked.finally(() => this.steps.delete(asked));
  }

  /** Sends the agent to fix the pull request, when the watch calls for it and it is free. */
  private watchTick(threadId: string, info: PullRequestInfo): void {
    const thread = this.store.getThread(threadId);
    const watch = thread?.prWatch;
    if (!thread || !watch || thread.archived || this.closed) return;
    if (this.turns.has(threadId) || this.busy.has(threadId)) return;
    const next = nextFix(watch, info);
    if (!next) return;
    if ("exhausted" in next) {
      this.updateThread(threadId, {
        prWatch: { ...watch, handled: next.exhausted.key, exhausted: true },
      });
      return;
    }
    const fix = next.send;
    this.prFixing.add(threadId);
    try {
      this.send(threadId, fix.text, fix.context, undefined, "pr");
    } catch (error) {
      // Busy for a moment: the next look at the pull request tries again.
      this.prFixing.delete(threadId);
      console.error("Correction de la PR :", error);
      return;
    }
    const { error: _error, ...kept } = watch;
    this.updateThread(threadId, {
      prWatch: { ...kept, tries: watch.tries + 1, handled: fix.key, last: fix.kind },
    });
  }

  /** Pushes what the agent did to fix its pull request, then lets the thread go on. */
  private async pushFix(threadId: string): Promise<void> {
    const watch = this.store.getThread(threadId)?.prWatch;
    // Turned off while the agent worked: what it did stays on the thread's branch, unpushed.
    if (watch) {
      try {
        await this.ship(
          threadId,
          watch.last === "conflict"
            ? "Fusion de la branche de base et résolution des conflits"
            : "Correction de la CI",
          false,
        );
      } catch (error) {
        const now = this.store.getThread(threadId)?.prWatch;
        if (now) this.updateThread(threadId, { prWatch: { ...now, error: describe(error) } });
      }
    }
    this.goOn(threadId, false, false, false);
  }

  /**
   * Gives the thread a goal, in place of the one it had: its agent works toward it turn after
   * turn. It starts at once on a free thread, else when the turn under way ends.
   */
  setGoal(threadId: string, text: string, maxTurns = GOAL_TURNS): void {
    const thread = this.requireLiveThread(threadId);
    if (thread.team || thread.role || thread.kind === "coordinator") {
      throw new Error(
        "Un objectif se donne à un fil d'agent, pas à une équipe ni au coordinateur.",
      );
    }
    this.updateThread(threadId, {
      goal: { text: text.trim(), state: "active", turns: 0, maxTurns, startedAt: Date.now() },
    });
    this.continueGoal(threadId);
  }

  /** Pauses the thread's goal, takes it up again, or drops it. */
  controlGoal(threadId: string, action: "pause" | "resume" | "stop"): void {
    const goal = this.requireThread(threadId).goal;
    if (action === "stop") {
      if (goal) this.updateThread(threadId, { goal: null });
      return;
    }
    if (!goal) throw new Error("Ce fil n'a pas d'objectif.");
    if (action === "pause") {
      // The turn under way goes to its end; nothing follows it.
      if (goal.state === "active") {
        this.updateThread(threadId, {
          goal: { ...goal, state: "paused", reason: "Mis en pause." },
        });
      }
      return;
    }
    if (goal.state === "reached") {
      throw new Error("Cet objectif est atteint : donnes-en un nouveau avec /goal.");
    }
    if (goal.state === "active") return;
    this.requireLiveThread(threadId);
    const { reason: _reason, endedAt: _ended, ...rest } = goal;
    // Its turns spent: taken up again, it gets a few more.
    const spent = goal.turns >= goal.maxTurns;
    this.updateThread(threadId, {
      goal: {
        ...rest,
        state: "active",
        maxTurns: spent ? goal.turns + GOAL_MORE_TURNS : goal.maxTurns,
      },
    });
    this.continueGoal(threadId);
  }

  /**
   * What the turn that just ended means for the thread's goal: the agent said it is reached
   * or blocked, or the user stopped the turn, or it failed, or its last turn is spent.
   */
  private settleGoal(threadId: string, stopped: boolean, failed: boolean): void {
    const goal = this.store.getThread(threadId)?.goal;
    if (!goal || (goal.state !== "active" && goal.state !== "paused")) return;
    const now = Date.now();
    // Set while another turn was under way: that turn's answer says nothing of the goal.
    const verdict = goal.turns > 0 ? goalVerdict(this.lastReply(threadId)) : undefined;
    const { reason: _reason, ...rest } = goal;
    if (verdict && "reached" in verdict) {
      this.updateThread(threadId, { goal: { ...rest, state: "reached", endedAt: now } });
    } else if (verdict) {
      this.updateThread(threadId, {
        goal: { ...rest, state: "blocked", reason: verdict.blocked, endedAt: now },
      });
    } else if (goal.state !== "active") {
      return;
    } else if (stopped) {
      this.updateThread(threadId, { goal: { ...rest, state: "paused", reason: "Tour arrêté." } });
    } else if (failed) {
      this.updateThread(threadId, {
        goal: { ...rest, state: "paused", reason: "Le dernier tour a échoué." },
      });
    } else if (goal.turns >= goal.maxTurns) {
      this.updateThread(threadId, { goal: { ...rest, state: "exhausted", endedAt: now } });
    }
  }

  /**
   * Sends the goal's next turn, when the goal is at work and the thread free: the goal itself
   * the first time, then a short line, with what the agent must know given unseen.
   */
  private continueGoal(threadId: string): boolean {
    const thread = this.store.getThread(threadId);
    const goal = thread?.goal;
    if (!thread || !goal || goal.state !== "active" || this.turns.has(threadId)) return false;
    const pause = (reason: string) => {
      this.updateThread(threadId, { goal: { ...goal, state: "paused", reason } });
      return false;
    };
    if (thread.archived) return pause("Le fil est résolu.");
    if (goal.turns >= goal.maxTurns) {
      this.updateThread(threadId, { goal: { ...goal, state: "exhausted", endedAt: Date.now() } });
      return false;
    }
    const next = { ...goal, turns: goal.turns + 1 };
    try {
      if (next.turns === 1) this.send(threadId, `Objectif : ${goal.text}`, goalContext(next));
      else this.send(threadId, goalMessage(next), goalContext(next), undefined, "goal");
    } catch (error) {
      // Busy for a moment, with a step back or a change of setting: the user takes it up.
      return pause(`Le tour suivant n'a pas pu partir : ${describe(error)}`);
    }
    this.updateThread(threadId, { goal: next });
    return true;
  }

  /**
   * Sends a message that waits without waiting for the turn's end: the first one, or the one
   * named, which then goes first. A turn under way is stopped, and the message leaves as
   * soon as the agent has stopped.
   */
  sendQueuedNow(threadId: string, id?: string): void {
    const queue = this.requireLiveThread(threadId).queue ?? [];
    if (id) {
      const chosen = queue.find((m) => m.id === id);
      if (!chosen) throw new Error("Ce message est déjà parti.");
      if (queue[0] !== chosen) {
        this.updateThread(threadId, { queue: [chosen, ...queue.filter((m) => m !== chosen)] });
      }
    }
    if (!this.turns.has(threadId)) {
      this.sendNextQueued(threadId);
      return;
    }
    this.sendAfterStop.add(threadId);
    this.cancel(threadId).catch((error: unknown) => console.error("File de messages :", error));
  }

  /**
   * Sends the first message that waits, as a turn of its own. Called when a turn ends by
   * itself, and when the user asks. One that cannot go now keeps its place. `afterError`:
   * the turn ended on an error, which the user looks at before their own messages go on;
   * what a coordinator left still goes, as nobody may be there to send it.
   */
  private sendNextQueued(threadId: string, afterError = false): boolean {
    const thread = this.store.getThread(threadId);
    const queue = thread?.queue ?? [];
    const first = queue[0];
    if (!thread || !first || thread.archived || this.turns.has(threadId)) return false;
    if (afterError && first.from !== "coordinator") return false;
    // What a coordinator left in a row is one message, as it always was.
    const run = first.from === "coordinator" ? queue.findIndex((m) => !m.from) : 1;
    const taken = queue.slice(0, run < 0 ? queue.length : run);
    try {
      this.sendQueued(threadId, { ...first, text: taken.map((m) => m.text).join("\n\n") });
    } catch (error) {
      // Busy for a moment, with a team, a step back or a change of setting.
      if (!this.closed) console.error("File de messages :", error);
      return false;
    }
    this.updateThread(threadId, { queue: queue.slice(taken.length) });
    return true;
  }

  send(
    threadId: string,
    text: string,
    context?: string,
    byTeam?: boolean,
    from?: "coordinator" | "goal" | "pr" | "remarks",
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
      this.diagnostics?.onActivityChanged();
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
      try {
        if (!this.closed) this.reviews.turnEnded(threadId, cancelled);
      } catch (error) {
        console.error("Revue :", error);
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
      // One that ended on an error holds the user's own messages back: they look at it first.
      // Unless they stopped it for a message that waits to go now.
      const failed = this.store.getThread(threadId)?.status === "error";
      const atOnce = this.sendAfterStop.delete(threadId);
      // A fix of the pull request whose words after a refusal go on in a new turn is pushed
      // when that one ends.
      if (this.prFixing.has(threadId) && this.turns.has(threadId)) return;
      const fixing = this.prFixing.delete(threadId);
      // The goal learns what this turn said, unless the turn was the pull request's fix;
      // it goes on after the messages that wait.
      if (!this.closed && !fixing) this.settleGoal(threadId, cancelled && !atOnce, failed);
      // A fix of the pull request is pushed before anything else goes on.
      if (fixing && !this.closed && !cancelled && !failed) {
        const pushed = this.pushFix(threadId);
        this.steps.add(pushed);
        void pushed.finally(() => this.steps.delete(pushed));
        return;
      }
      this.goOn(threadId, cancelled, failed, atOnce);
    });
    this.turns.set(threadId, turn);
    this.diagnostics?.onActivityChanged();
  }

  /**
   * What follows a turn: the messages that wait, else the goal's next turn, else the next
   * thread in line behind the same coordinator, which also hears what this one did.
   */
  private goOn(threadId: string, cancelled: boolean, failed: boolean, atOnce: boolean): void {
    if (this.closed || this.turns.has(threadId)) return;
    if ((atOnce || !cancelled) && this.sendNextQueued(threadId, failed && !atOnce)) return;
    if (this.continueGoal(threadId)) return;
    // A place is free: the next thread in line behind the same coordinator starts.
    const openedBy = this.store.getThread(threadId)?.openedBy;
    if (openedBy) this.coordinators.drainLine(openedBy);
    if (openedBy && !cancelled) void this.reportResult(threadId);
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
    if (thread.team || thread.queue?.length) return;
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
      let session = await this.pool.get(threadId)?.catch(() => undefined);
      const choices = session?.model?.choices ?? this.store.getAgentModels(thread.agentId)?.models;
      if (!choices?.some((c) => c.id === model)) throw new Error("Modèle inconnu.");
      if (session?.model) {
        if (await this.frozeOnSetting(threadId, () => session!.setModel(model))) {
          session = undefined;
        } else {
          // A new model can bring other effort levels, for the picker too.
          this.catalog.learn(thread.agentId, session.model, session.settings, false);
        }
      }
      const settings = session && settingValues(session.settings);
      this.updateThread(threadId, {
        model: session?.model?.current ?? model,
        ...(settings ? { settings } : {}),
      });
    });
  }

  /**
   * Runs a change of model or setting on the thread's agent. One that gets no answer in time
   * is stopped, and true is returned: the change is kept for the thread, and its next agent
   * starts with it, instead of the thread waiting on a frozen one.
   */
  private async frozeOnSetting(threadId: string, change: () => Promise<void>): Promise<boolean> {
    try {
      await change();
      return false;
    } catch (error) {
      // An agent that went away takes the change with it: the next one starts with it.
      if (CONNECTION_CLOSED.test(describe(error))) {
        await this.pool.stop(threadId);
        return true;
      }
      if (!(error instanceof SettingTimeout)) throw error;
      console.warn(`Fil ${threadId} : ${error.message} L'agent est arrêté.`);
      await this.pool.stop(threadId);
      return true;
    }
  }

  /** Changes one of the agent's settings, such as its mode, between turns. */
  async setSetting(threadId: string, settingId: string, value: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId))
      throw new Error("Attends la fin de la réponse pour changer ce réglage.");
    await this.exclusive(threadId, "Attends la fin du changement de réglage.", async () => {
      let session = await this.pool.get(threadId)?.catch(() => undefined);
      const offered = session?.settings ?? this.catalog.settingsFor(thread.agentId, thread.model);
      const setting = offered?.find((s) => s.id === settingId);
      if (!setting?.choices.some((c) => c.id === value)) throw new Error("Réglage inconnu.");
      if (session) {
        if (await this.frozeOnSetting(threadId, () => session!.setSetting(settingId, value))) {
          session = undefined;
        } else {
          this.catalog.learn(thread.agentId, session.model, session.settings, false);
        }
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

  /** Drops the changes to one file of the review, while the agent is not at work. */
  async rejectFile(threadId: string, file: string, from?: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    await this.exclusive(threadId, "Attends la fin de l'annulation du fichier.", () =>
      rejectReviewFile(thread.workspace, file, from),
    );
  }

  /**
   * What merging the branch the thread started from would do now. A merge of it made some
   * other way, by the agent, moves the start of the branch on, as « Synchroniser » does.
   */
  async forecast(threadId: string): Promise<MergeForecast> {
    const workspace = this.requireLiveThread(threadId).workspace;
    const { base, ...forecast } = await forecastFor(workspace);
    // The server closed meanwhile: its store is no longer there to write to.
    if (this.closed) return forecast;
    const now = this.store.getThread(threadId)?.workspace;
    // Only over the start it was worked out from: a sync meanwhile has the last word.
    if (now && workspace && now.base === workspace.base && base !== now.base) {
      this.updateThread(threadId, { workspace: { ...now, base } });
    }
    return forecast;
  }

  /**
   * Merges the branch the thread started from into its own, when nothing conflicts. The
   * branch then starts from there, so the review keeps showing the thread's work alone.
   */
  async syncWithBase(threadId: string): Promise<void> {
    this.requireLiveThread(threadId);
    await this.exclusive(threadId, "Attends la fin de la synchronisation.", async () => {
      const workspace = this.store.getThread(threadId)?.workspace;
      const { base } = await syncWorkspace(workspace);
      const now = this.store.getThread(threadId)?.workspace;
      if (now && now.base !== base) this.updateThread(threadId, { workspace: { ...now, base } });
    });
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
    if (thread.prReview)
      throw new Error("Cette discussion relit une PR : elle n'a rien à pousser.");
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
    // GitHub may answer after the hub has closed, and its store with it.
    if (on && !this.closed) await this.notePullRequest(threadId, pr);
    return pr;
  }

  /**
   * The open review remarks of the pull request of the thread's branch. None to read: no
   * pull request, one already merged or closed, or nothing here that can ask GitHub.
   */
  async pullRequestRemarks(
    threadId: string,
  ): Promise<{ pr: PullRequestInfo; remarks: PullRequestRemark[] } | undefined> {
    const on = await this.branchOnGithub(threadId);
    if (!on?.github.remarks) return undefined;
    const pr = await on.github.find(on.repo, on.branch);
    if (!pr || (pr.state !== "open" && pr.state !== "draft")) return undefined;
    return { pr, remarks: await on.github.remarks(on.repo, pr.number) };
  }

  /**
   * Sends the agent the remarks picked, read again from GitHub: their words never come from
   * the client, and one resolved since is left out.
   */
  async sendRemarks(threadId: string, ids: readonly string[]): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    if (!thread.workspace?.base) {
      throw new Error("Seul un fil qui travaille sur sa propre branche a une pull request.");
    }
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    const found = await this.pullRequestRemarks(threadId);
    if (!found) throw new Error("Cette branche n'a plus de pull request ouverte sur GitHub.");
    const wanted = new Set(ids);
    const picked = found.remarks.filter((r) => wanted.has(r.id));
    if (!picked.length) {
      throw new Error("Ces remarques ne sont plus ouvertes sur GitHub : actualise la liste.");
    }
    // GitHub took its time: the thread may have been locked, archived, removed or set to
    // work since, and is looked at again before anything is sent.
    if (this.closed) throw new Error("MoonAgentic s'arrête.");
    if (this.lockedThread(threadId)) {
      throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
    }
    this.requireLiveThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    const { text, context } = remarksMessage(found.pr, picked);
    this.send(threadId, text, context, undefined, "remarks");
  }

  /**
   * Keeps what lists of threads show of the pull request. One that has just been merged
   * resolves its thread, when its folder holds nothing more than what was merged.
   */
  private async notePullRequest(threadId: string, info: PullRequestInfo | undefined) {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    if (info) this.watchTick(threadId, info);
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
    if (atWork(threadId) || atWork(target.id) || this.groupActive(target.id)) return;
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
    this.planner.syncThread(thread);
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
    if (archived) this.refuseGroupAtWork(threadId);
    // A team goes to the archive whole, and comes back whole: never its lead alone.
    const members = this.teamMembers(threadId);
    const order = archived ? [...members, threadId] : [threadId, ...members.reverse()];
    for (const id of order) await this.setOneArchived(id, archived);
  }

  /** Whether the thread runs a team or a review still at work, or is one of its threads. */
  private groupActive(threadId: string): boolean {
    return this.teams.isActive(threadId) || this.reviews.isActive(threadId);
  }

  private refuseGroupAtWork(threadId: string): void {
    if (this.teams.isActive(threadId)) throw new Error(TEAM_AT_WORK);
    if (this.reviews.isActive(threadId)) throw new Error(REVIEW_AT_WORK);
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
    this.refuseGroupAtWork(threadId);
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
      threads.some((t) => this.turns.has(t.id) || this.busy.has(t.id) || this.groupActive(t.id))
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
      this.locks.forget(projectId);
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

  setMascot(agentId: string, mascot: Mascot | null): void {
    this.catalog.setMascot(agentId, mascot);
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

  /**
   * Stops every agent and resolves once their turns have ended, or once `CLOSE_LIMIT_MS` has
   * passed. The agents are stopped first, before anything else is waited for: should
   * something hang, the server is ended with no agent left running unseen behind it.
   */
  async close(): Promise<void> {
    this.closed = true;
    const deadline = Date.now() + CLOSE_LIMIT_MS;
    const upTo = (work: Promise<unknown>) => within(work, deadline - Date.now());
    clearTimeout(this.indexTimer);
    clearInterval(this.prTimer);
    clearInterval(this.sweepTimer);
    this.quotas.close();
    this.scheduler.close();
    this.teams.close();
    this.reviews.close();
    this.pool.clearTimers();
    for (const timer of this.forceStops.values()) clearTimeout(timer);
    this.forceStops.clear();
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
    await upTo(this.pool.closeAll());
    for (const threadId of new Set([...this.pendingPermissions.values()].map((p) => p.threadId))) {
      this.settlePermissions(threadId);
    }
    // A review starting reads the changes first; it must not reach the store once closed.
    await upTo(this.teams.settled());
    await upTo(this.recovered);
    await upTo(this.catalog.close());
    // Those just started too, which find no agent to start.
    await upTo(Promise.all(this.turns.values()));
    await upTo(Promise.all([...this.steps].map((step) => step.catch(() => undefined))));
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
      const said = describe(error);
      // An agent whose connection closed is of no more use, even if its process lingers:
      // it goes, so a change of model and the next message start a new one.
      if (CONNECTION_CLOSED.test(said)) await this.pool.stop(thread.id).catch(() => undefined);
      if (this.store.getThread(thread.id)?.status !== "error") {
        // Its process went away mid-turn: said plainly, with the technical detail under it.
        this.updateThread(thread.id, {
          status: "error",
          error: CONNECTION_CLOSED.test(said) ? stoppedError(said) : said,
        });
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

  /** The folder of a project that is a git repository, for what works on its branches. */
  private gitProjectPath(projectId: string): string {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Ce projet n'existe plus.");
    if (!this.withGit(project).git) throw new Error("Ce projet n'est pas un dépôt git.");
    return project.path;
  }

  /** Every thread with a branch of its own, whatever its project: two can share a repository. */
  private branchOwners(): BranchOwner[] {
    return this.store.listThreads().flatMap((t) =>
      t.workspace?.branch
        ? [
            {
              id: t.id,
              title: t.title,
              branch: t.workspace.branch,
              ...(t.archived ? { archived: true } : {}),
              ...(this.locks.isLocked(t.projectId) ? { locked: true } : {}),
            },
          ]
        : [],
    );
  }

  private withGit(project: Project): Project {
    let git = this.gitProjects.get(project.id);
    if (git === undefined) {
      git = isGitRepo(project.path);
      this.gitProjects.set(project.id, git);
    }
    const pinned = this.store.getSetting<string[]>(PINNED_PROJECTS, []).includes(project.id);
    const locked = this.locks.isLocked(project.id);
    const look = this.store.getSetting<Record<string, ProjectLook>>(PROJECT_LOOKS, {})[project.id];
    return git || pinned || locked || look
      ? {
          ...project,
          ...(git ? { git } : {}),
          ...(pinned ? { pinned } : {}),
          ...(locked ? { locked } : {}),
          ...(look?.icon ? { icon: look.icon } : {}),
          ...(look?.color ? { color: look.color } : {}),
        }
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
    const startedAt = Date.now();
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
          if (reason && !this.closed && !this.cancelled.has(thread.id)) {
            const summary = this.locks.isLocked(thread.projectId)
              ? ""
              : (reason.split(/\r?\n/)[0]?.trim().slice(0, 180) ?? "");
            this.diagnostics?.recordSlow(
              "agent-exit",
              `${thread.agentId} arrêté : ${summary || "sortie imprévue"}`,
            );
          }
          if (reason && this.turns.has(thread.id) && !this.cancelled.has(thread.id)) {
            this.updateThread(thread.id, { status: "error", error: stoppedError(reason) });
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
    const startMs = Date.now() - startedAt;
    if (startMs >= 5_000) {
      this.diagnostics?.recordSlow(
        "agent-start",
        `démarrage lent ${thread.agentId} (${startMs} ms)`,
        startMs,
      );
    }
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
          this.catalog.learn(thread.agentId, session.model, session.settings, false);
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
    this.diagnostics?.onActivityChanged();
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
    const thread = this.store.updateThread(threadId, patch);
    this.broadcast({ type: "thread", thread });
    // A card that follows this thread moves with it.
    this.planner.syncThread(thread);
  }

  private sendToViewers(threadId: string, message: ServerMessage): void {
    for (const client of this.clients)
      if (client.openThreadIds?.has(threadId)) client.send(message);
  }

  /** Attaches the runtime crash & performance monitor created by the server. */
  setDiagnostics(monitor: DiagnosticsMonitor | undefined): void {
    this.diagnostics = monitor;
  }

  /** True when at least one project is locked via /lock. */
  hasLockedProjects(): boolean {
    return this.locks.any();
  }

  /** Number of active agent turns right now. */
  get runningTurnCount(): number {
    return this.turns.size;
  }

  /** Number of agent processes currently starting up. */
  get startingAgentCount(): number {
    return this.pool.startingCount;
  }

  /**
   * Live agent processes for memory diagnostics: exposes only agent id, model, pid and running
   * status — never project names, thread titles or file paths (/lock safe).
   */
  diagnosticAgents(): AgentProcessRef[] {
    return this.pool.liveSessions().map(({ threadId, session }) => {
      const thread = this.store.getThread(threadId);
      const model = session.model?.current ?? thread?.model ?? undefined;
      return {
        agentId: thread?.agentId ?? "agent",
        ...(model ? { model } : {}),
        ...(session.pid !== undefined ? { pid: session.pid } : {}),
        running: this.turns.has(threadId),
      };
    });
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
    if (message.type === "thread") this.push.threadChanged(message.thread);
    else if (message.type === "threadRemoved") this.push.threadRemoved(message.threadId);
    for (const client of this.clients) client.send(message);
  }
}

export { CoordinatorRefused, coordinatorPrompt } from "./coordinator.ts";
