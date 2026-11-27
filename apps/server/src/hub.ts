import { grantKeys, readOnlyCall, THREAD_GRANT_OPTION } from "./permission-rules.ts";
import { AttachmentRefused, Attachments } from "./attachments.ts";
import { ArtifactLinks, artifactUrl, findArtifacts } from "./artifacts.ts";
import type { AgentProcessRef, DiagnosticsMonitor } from "./diagnostics.ts";
import { generatedFolders, madeImages, resolveThreadFile } from "./thread-files.ts";
import { labelStart, plainLabel } from "./labels.ts";
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
import { Hermes, type WebhookSend } from "./hermes.ts";
import { HermesCli, type HermesRunner, hermesRunner } from "./hermes-cli.ts";
import { ThreadClock, type WidgetData, widgetData } from "./widget.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_STOPPED,
  DEFAULT_MAX_TURNS,
  packSnapshot,
  GOAL_MORE_TURNS,
  GOAL_TURNS,
  MAX_QUEUED_MESSAGES,
  PR_WATCH_TRIES,
  RESUME_TEXT,
  spentUntil,
  threadPullRequest,
} from "@moonagentic/protocol";
import type {
  ProjectQuotaRules,
  Schedule,
  ScheduleRepeat,
  ThreadQuota,
} from "@moonagentic/protocol";
import type {
  CustomAgentInput,
  RoleMascots,
  FavoriteRef,
  Defaults,
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
  canonicalPath,
  dropCheckpoints,
  gitCommonDir,
  gitRootCommonDir,
  isGitRepo,
  isSameOrInside,
  pathsOverlap,
  matchesCheckpoint,
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
import { historyBefore, projectMemoryContext } from "./history.ts";
import { cardText, Planner } from "./planner.ts";
import { COORDINATOR_TOOLS, THREAD_TOOLS } from "./coordinator-tools.ts";
import { localPullRequests, parsePullRequestUrl, type PullRequests } from "./pull-request.ts";
import { Scheduler } from "./scheduler.ts";
import { diffText, shipTarget, Teams, teamStatus } from "./team.ts";
import { PrReviews, REVIEW_DIFF_LIMIT, reviewPrompt, reviewStatus } from "./pr-review.ts";
import { mcpServersFor, RESERVED_MCP_NAME } from "./mcp.ts";
import { probeMcpTools } from "./mcp-probe.ts";
import { type QuotaReader, Quotas } from "./quotas.ts";
import { formContent, formQuestions, toolQuestions, type FormQuestions } from "./questions.ts";
import { AgentSession, describe, needsSignIn, SettingTimeout } from "./session.ts";
import { AgentPool } from "./sessions.ts";
import { SHRINK_PAGES } from "./checkpoints.ts";
import { light, TimelineLog } from "./timeline.ts";
import { TurnLine } from "./turn-line.ts";
import { dropOldOrphans, sweepWorktrees } from "./worktree-sweep.ts";
import { AppUpdates, type GitSource, type ShellChannel } from "./app-update.ts";
import { backupBeforeUpdate } from "./backups.ts";
import { redact } from "./redact.ts";
import {
  GIVE_UP_AFTER_MS,
  nextFallback,
  quotaStopped,
  RESET_MARGIN_MS,
  resetFromText,
  UNKNOWN_RESET_RETRY_MS,
} from "./quota-relief.ts";
import { isTeamPreset } from "./saved-shapes.ts";
import { isRecord, type Store, StorageRefused, storageTrouble, type ThreadPlace } from "./store.ts";
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
/** A widget waits this long at most for quotas read again: iOS gives it a few seconds. */
const WIDGET_QUOTA_WAIT_MS = 2500;
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

/** How often a write is tried again while the database refuses them. */
const STORAGE_RETRY_MS = 5_000;
/** How a turn ended: what its thread is left with. */
type TurnEnd = { status: "idle" | "error"; error?: string | null };

/** A thread's error when its agent stopped mid-turn: plain words first, the detail after. */
const stoppedError = (detail: string): string => {
  const rest = detail.trim();
  return rest ? `${AGENT_STOPPED}\n${rest}` : AGENT_STOPPED;
};

const titleFrom = (text: string, images = 0) => {
  const line = plainLabel(text.trim().split("\n")[0] ?? "");
  if (line.length > 60) return `${labelStart(line, 57).trimEnd()}…`;
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
/** How long a coordinator being restarted has to end its turn before its agent is stopped. */
const RESTART_WAIT_MS = 5_000;

/** A route as the app sends it: an agent, and its model and settings when given. */
const memberOf = (picked: {
  agentId: string;
  model?: string | undefined;
  settings?: Record<string, string> | undefined;
}): TeamMember => ({
  agentId: picked.agentId,
  ...(picked.model ? { model: picked.model } : {}),
  ...(picked.settings && Object.keys(picked.settings).length ? { settings: picked.settings } : {}),
});
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
  /** How Discord webhook messages are sent; to Discord over the network when not given. */
  webhookSend?: WebhookSend;
  /** How Hermes's own commands run; the `hermes` installed on this computer when not given. */
  hermesRunner?: HermesRunner;
  /** How often Hermes's gateway is looked at and started again; 0 for only when asked. */
  hermesGatewayMs?: number;
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
  /** How often threads waiting on a quota, or on a fallback model, look whether it is back. */
  quotaTickMs?: number;
  /** Where the images sent with messages are kept; beside the worktrees unless given. */
  attachmentsDir?: string;
  /** The desktop app's channel, when it started this server. */
  shell?: ShellChannel;
  /** The clone this server runs from, looked at for newer commits on `main`. */
  appGit?: GitSource;
  /** Where the database is copied before an update; beside the worktrees unless given. */
  backupsDir?: string;
  /** How often a write is tried again while the database refuses them. */
  storageRetryMs?: number;
}

/** The setting that lists the projects kept at the top. */
const PINNED_PROJECTS = "pinnedProjects";
/** The projects the user put away. */
const ARCHIVED_PROJECTS = "archivedProjects";
/** The user's defaults for a new thread, the same on every device. */
const DEFAULTS = "defaults";
/** Each project's icon and tint, as set in its settings. */
const PROJECT_LOOKS = "projectLooks";
type ProjectLook = Pick<Project, "icon" | "color">;
/** The reviews of each pull request the user marked « Réglé », by the pull request's address. */
const SETTLED_REVIEWS = "settledReviews";
/** The projects that keep a thread's branch once its pull request is merged. */
const KEEP_MERGED_BRANCHES = "keepMergedBranches";
/** The projects put on hold from their settings. */
const PAUSED_PROJECTS = "pausedProjects";
/** Each project's rules for a quota that runs out, by project id. */
const PROJECT_QUOTA = "projectQuotaRules";
/** How often threads waiting on a quota look whether it is back, unless told otherwise. */
const QUOTA_TICK_MS = 60_000;

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
const OWN_THREAD_TOOL = new RegExp(
  `^(?:Run )?mcp_{1,2}moonagentic_{1,2}(?:${THREAD_TOOLS.map((t) => t.name).join("|")})$`,
);

/** A known, open pull request is asked about again this often. */
const PR_WATCH_MS = 60_000;
/** Pull requests turned green at once before the coordinator's conversation says so. */
const GREEN_AT_ONCE = 2;
/** The setting that keeps the mascot of each role the user changed. */
const ROLE_MASCOTS = "roleMascots";
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

/** A reply's first sentences, as one short line: a thread's result read at a glance. */
export function leadOf(reply: string, sentences = 2, limit = SUMMARY_LIMIT): string {
  // Titles say what a part is about, not the result.
  const flat = summaryOf(reply.replace(/^\s{0,3}#{1,6}\s.*$/gm, ""), Number.MAX_SAFE_INTEGER);
  const parts = flat.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ«"(0-9])/);
  return summaryOf(parts.slice(0, sentences).join(" "), limit);
}

const settingValues = (settings: AgentSetting[]) =>
  settings.length ? Object.fromEntries(settings.map((s) => [s.id, s.current])) : undefined;

/** Keeps a message's checkpoint from git's garbage collection, out of sight of branches. */
const checkpointRef = (threadId: string, itemId: string) =>
  `refs/moonagentic/${threadId}/${itemId.replace(/^user:/, "")}`;
/** Keeps the files of an archived thread, uncommitted ones included, until it comes back. */
const archiveRef = (threadId: string) => `refs/moonagentic/${threadId}/archive`;
/** Keeps the files a conversation found in the project it moved into, to go back to. */
const movedRef = (threadId: string) => `refs/moonagentic/${threadId}/moved`;
/** Where the files a step back takes away are kept, one ref for each step back. */
const undoneRef = (threadId: string, at: number) => `refs/moonagentic/${threadId}/undone-${at}`;

/** How a folder's name compares on this system: Windows does not tell `A` from `a`. */
const folderKey = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);

/**
 * `find` asked once for each folder: many threads, and few ways their folders' place was
 * ever written, so the disk is looked at a few times, not once a thread.
 */
function onceEach(find: (folder: string) => string): (folder: string) => string {
  const known = new Map<string, string>();
  return (folder) => {
    let found = known.get(folder);
    if (found === undefined) known.set(folder, (found = find(folder)));
    return found;
  };
}

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

/** How many of a deleted thread's messages go at once, between two answers to screens. */
const DELETE_BATCH = 250;
/** Lets what waits on the server run (a screen's message, a timer) before going on. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** How many of the user's last actions are known by their id, for one sent again. */
const MAX_SENDS_KEPT = 5000;

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
  /** The earlier run of a planned task going to the archive, by the thread of the next run. */
  private readonly puttingAway = new Map<string, Promise<void>>();
  /** Identifies the running turn, so a turn's plan and text stay separate from the next. */
  private readonly turnIds = new Map<string, string>();
  private readonly pendingPermissions = new Map<
    string,
    {
      threadId: string;
      resolve: (r: acp.RequestPermissionResponse) => void;
      /** « Autoriser pour ce fil »: what it remembers, and the agent's own option it answers. */
      grant?: { key: string; optionId: string };
    }
  >();
  /**
   * The green pull requests already told to each coordinator, as `thread url`. Read back from
   * its conversation the first time: a server started again tells none of them twice.
   */
  private readonly greenTold = new Map<string, Set<string>>();
  /** What « Autoriser pour ce fil » allowed, by thread: similar calls then pass without asking. */
  private readonly threadGrants = new Map<string, Set<string>>();
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
  /** Hermes Agent, driven from Discord. */
  readonly hermes: Hermes;
  /** Since when each thread waits or works, for the iPhone widgets. */
  private readonly threadClock = new ThreadClock();
  /** MoonAgentic's own version and updates. */
  readonly app: AppUpdates;
  /** The projects locked with /lock, and the code that opens them. */
  readonly locks: ProjectLocks;
  /** The project of each thread looked at while some are locked: a thread never moves. */
  private readonly threadProjects = new Map<string, string>();
  /** The addresses artifacts are shown from, each for one thread's folder. */
  readonly artifactLinks = new ArtifactLinks(
    (id) => {
      const thread = this.store.getThread(id);
      // A locked project's files are not shown either, even from an address given before.
      return thread && !thread.archived && !this.locks.isLocked(thread.projectId)
        ? thread.workspace
        : undefined;
    },
    Date.now,
    // The files its answers name stay to be seen in a resolved thread, which is read again.
    (id) => {
      const thread = this.store.getThread(id);
      return !!thread && !this.locks.isLocked(thread.projectId);
    },
  );
  /**
   * Threads busy with their branch or their agent (a push, a step back, a hand-off), with
   * what to answer a message or another such step meanwhile.
   */
  private readonly busy = new Map<string, string>();
  /** Whether each project's folder is in a git repository, checked once. */
  private readonly gitProjects = new Map<string, boolean>();
  /** Projects being removed, which take no new thread meanwhile. */
  private readonly removingProjects = new Set<string>();
  /** Threads whose items are being deleted in batches: exports/pages fail instead of returning a half-deleted timeline. */
  private readonly deletingThreads = new Set<string>();
  /** The text each thread's agent is streaming, ahead of what is written down. */
  /** Names this run of the server: a screen's mark from another run means nothing here. */
  private readonly epoch = randomUUID();
  /** What changed in each timeline since the server started. */
  private readonly logs = new Map<string, TimelineLog>();
  /** Above every change number a forgotten log gave: where a new log starts. */
  private logsFrom = 0;
  private readonly drafts = new Map<
    string,
    { item: TextItem; dirty: boolean; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Why the database refuses writes right now, in the user's words, while a cause outside
   * the server lasts (a full disk, another program holding the file). The server goes on:
   * stopping would cut every agent, and it could not start again either.
   */
  private storageDown: string | undefined;
  private storageTimer: NodeJS.Timeout | undefined;
  private readonly storageRetryMs: number;
  /**
   * What an agent sent that the database refused (its text, its tools, its questions), by
   * item, in the order it came: written in that order once writes pass again, and shown
   * meanwhile as if it were written.
   */
  private readonly unsaved = new Map<string, { threadId: string; item: Item }>();
  /** How the turns whose end could not be written ended, by thread, to write then too. */
  private readonly unsettled = new Map<string, TurnEnd>();

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
  private quotaTimer: NodeJS.Timeout | undefined;
  /** Threads that wait on a quota or run on a fallback: the only ones the tick looks at. */
  private readonly quotaThreads = new Set<string>();
  /** When a thread whose quota gives no reset time is tried again, by thread id. */
  private readonly quotaRetryAt = new Map<string, number>();
  /** Threads the tick is putting back or starting again right now. */
  private readonly quotaActing = new Set<string>();

  constructor(store: Store, agents: Agents, options: HubOptions) {
    this.store = store;
    this.locks = new ProjectLocks(store, undefined, () => store.listProjects().map((p) => p.id));
    this.agents = agents;
    this.dataDir = options.dataDir;
    this.worktreesDir = options.worktreesDir;
    this.attachments = new Attachments(
      options.attachmentsDir ?? path.join(path.dirname(options.worktreesDir), "attachments"),
    );
    this.forceStopMs = options.forceStopMs ?? FORCE_STOP_MS;
    this.storageRetryMs = options.storageRetryMs ?? STORAGE_RETRY_MS;
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
    this.hermes = new Hermes(
      {
        getSetting: (key, fallback) => store.getSetting(key, fallback),
        setSetting: (key, value) => store.setSetting(key, value),
        // As the app sees them: archived, a git repository.
        projects: () => store.listProjects().map((p) => this.withGit(p)),
        threads: () => store.listThreads(),
        thread: (id) => store.getThread(id),
        items: (id) => this.items(id),
        markRelayed: (threadId, itemId) => {
          const item = this.store.getItem(threadId, itemId);
          if (item?.kind === "user" && !item.relayed) {
            this.putItem(threadId, { ...item, relayed: true });
          }
        },
        running: (id) => this.turns.has(id),
        whenIdle: (id) => this.whenIdle(id),
        sendFromHermes: (id, text) => this.sendFromHermes(id, text),
        planCards: () => this.planner.list(),
        addPlanCard: (input) => this.planner.add(input, { source: "hermes" }),
        addSchedule: (input) => this.hermesSchedule(input),
        pendingRequests: () => this.pendingRequests(),
        pendingQuestions: () => this.pendingQuestions(),
        respondToPermission: (threadId, itemId, optionId) =>
          this.respondToPermission(threadId, itemId, optionId),
        respondToQuestion: (threadId, itemId, answers) =>
          this.respondToQuestion(threadId, itemId, answers),
        closed: (id) =>
          this.locks.isLocked(id) || this.removingProjects.has(id) || this.isDiscussions(id),
        quiet: (id) => this.locks.isLocked(id),
        broadcast: (m) => this.broadcast(m),
        url: () => this.coordinators.url,
        cli: () => {
          if (options.hermesRunner) return new HermesCli(options.hermesRunner);
          try {
            return new HermesCli(hermesRunner(this.agents.launch("hermes").command));
          } catch {
            return undefined;
          }
        },
      },
      options.dataDir,
      options.webhookSend,
      options.hermesGatewayMs,
    );
    this.hermes.know(store.listThreads());
    this.threadClock.know(store.listThreads());
    const backupsDir =
      options.backupsDir ?? path.join(path.dirname(options.worktreesDir), "backups");
    this.app = new AppUpdates({
      settings: store,
      broadcast: (m) => this.broadcast(m),
      working: () => this.turns.size,
      backup: async (version) => {
        const file = await backupBeforeUpdate(store, backupsDir, version);
        console.log(`Copie de la base avant la mise à jour : ${file}`);
      },
      // Said of no project: a locked one keeps its secrets.
      notify: (title, body) => {
        this.push
          .deliver({ tag: "app-update", threadId: "", title, body }, "")
          .catch((error: unknown) =>
            console.error("Notifications :", error instanceof Error ? error.message : error),
          );
      },
      // Tasks due while the app is replaced start after, as after any stop.
      pause: () => this.scheduler.close(),
      resume: () => {
        if (!this.closed) void this.recovered.then(() => this.scheduler.start());
      },
      ...(options.shell ? { shell: options.shell } : {}),
      ...(options.appGit ? { git: options.appGit } : {}),
    });
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
      start: (s) => {
        const id = this.createThread({
          projectId: s.projectId,
          agentId: s.agentId,
          permissionMode: s.permissionMode,
          model: s.model,
          isolated: s.isolated,
          title: s.title,
          text: s.text,
          auto: true,
        });
        // Only the latest run stays in sight: each one would otherwise leave its thread and
        // its copy of the repository, 720 a month for an hourly task.
        if (s.lastThreadId) this.putAwayRun(s.lastThreadId, id);
        return id;
      },
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
      outsideProjects: (id) => this.isDiscussions(id),
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
      confirmMemoryWrite: (threadId, content, replace, signal) =>
        this.confirmMemoryWrite(threadId, content, replace, signal),
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
      this.startQuotaTick(options.quotaTickMs ?? QUOTA_TICK_MS);
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
        .then(async (removed) => {
          if (removed.length)
            console.log(`Copies de travail sans fil retirées : ${removed.join(", ")}`);
          await this.dropOldOrphans();
        })
        .catch((error: unknown) => console.error("Nettoyage des copies de travail :", error));
      this.steps.add(step);
      void step.finally(() => this.steps.delete(step));
    };
    sweep();
    this.sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
    this.sweepTimer.unref();
  }

  /** In each project's repository, the files of orphan folders kept for too long go. */
  private async dropOldOrphans(): Promise<void> {
    // The database may be closed meanwhile: the server stopped during the sweep.
    if (this.closed) return;
    // Only git repositories hold them: no git command for a project known to be none
    // (Discussions). Not asked here when unknown: asking waits for git, holding the server.
    const repos = new Set(
      this.store
        .listProjects()
        .filter((p) => this.gitProjects.get(p.id) !== false)
        .map((p) => p.path),
    );
    for (const repo of repos) {
      if (this.closed) return;
      if (!existsSync(repo)) continue;
      const dropped = await dropOldOrphans(repo).catch((): string[] => []);
      if (dropped.length)
        console.log(`Copies orphelines anciennes oubliées dans ${repo} : ${dropped.length}`);
    }
  }

  /** The folders of the worktrees folder that a thread holds, archived ones included. */
  private heldWorktrees(): string[] {
    const real = onceEach(canonicalPath);
    const held: string[] = [];
    for (const thread of this.store.listThreads()) {
      const name = thread.workspace && this.ourFolder(thread.workspace.path, real);
      if (name) held.push(name);
    }
    return held;
  }

  /**
   * The name of the folder of ours that `dir` is, or is in; undefined for any other folder.
   * Ours are told by where they are on disk, not by how their path is written: the data
   * folder reached through a link or a junction one day and by its own path the next is the
   * same folder, and a thread's folder taken for nobody's would be swept away.
   */
  private ourFolder(
    dir: string,
    real: (folder: string) => string = canonicalPath,
  ): string | undefined {
    const within = (parent: string, child: string) => {
      const inside = path.relative(parent, child);
      return inside && !inside.startsWith("..") && !path.isAbsolute(inside)
        ? inside.split(path.sep)[0]
        : undefined;
    };
    return (
      // A path made from this very folder's, as nearly all are: no look at the disk.
      within(this.worktreesDir, dir) ??
      // The folder that holds it is resolved, not the thread's own: it is named by its place.
      within(real(this.worktreesDir), path.join(real(path.dirname(dir)), path.basename(dir)))
    );
  }

  /**
   * A folder and a branch of its own for a thread, named by the start of its id: short, to
   * keep deep projects under Windows' path length limit. Two ids can start alike; a name
   * that a thread holds, or that is on disk, is left to it and more of the id is taken, or
   * the second thread would work in the first one's folder and take it along when deleted.
   */
  private ownWorkspace(title: string, id: string): { branch: string; path: string } {
    const folders = new Set(this.heldWorktrees().map(folderKey));
    const branches = new Set(this.store.listThreads().map((t) => t.workspace?.branch));
    // The id's own groups, then all of it, which no other thread has.
    const longer = [13, 18, 23, id.length];
    const folder = [8, ...longer]
      .map((length) => id.slice(0, length))
      .find(
        (name) => !folders.has(folderKey(name)) && !existsSync(path.join(this.worktreesDir, name)),
      );
    const branch = [6, ...longer]
      .map((length) => branchName(title, id, length))
      .find((name) => !branches.has(name));
    if (!folder || !branch) throw new Error("Aucun dossier libre pour ce fil : réessaie.");
    return { branch, path: path.join(this.worktreesDir, folder) };
  }

  /**
   * The other threads that hold this folder too, oldest first: two ids that start alike once
   * gave two threads one folder. It is the oldest one's, and nobody's to remove meanwhile.
   */
  private sharingFolder(
    threadId: string,
    dir: string,
    threads: ThreadPlace[] = this.store.listThreadPlaces(),
  ): ThreadPlace[] {
    const real = onceEach(canonicalPath);
    const name = this.ourFolder(dir, real);
    if (!name) return [];
    return threads
      .filter(
        (t) =>
          t.id !== threadId &&
          !!t.workspace &&
          folderKey(this.ourFolder(t.workspace.path, real) ?? "") === folderKey(name),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Whether the folder is one of ours that only this thread holds: its own to remove. */
  private ownFolder(threadId: string, dir: string, threads?: ThreadPlace[]): boolean {
    return this.isOurWorktree(dir) && !this.sharingFolder(threadId, dir, threads).length;
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
    // Sent at each connection, a phone's return to the screen included: each list of `/`
    // commands goes once, not once per thread.
    client.send({ type: "snapshot", snapshot: packSnapshot(this.snapshot(!!client.deviceId)) });
    return () => this.clients.delete(client);
  }

  snapshot(pairedDevice = false): Snapshot {
    const mcpSecretsError = this.catalog.mcpSecretsError();
    const defaults = this.store.getSetting<Defaults | null>(DEFAULTS, null, "object");
    const presets = this.store
      .getSetting<unknown[] | null>(TEAM_PRESETS_SETTING, null, "array")
      ?.filter(isTeamPreset);
    return {
      coordinator: this.coordinators.coordinatorSettings(),
      favorites: this.catalog.favorites(),
      favoriteOrder: this.catalog.favoriteOrder(),
      requests: this.pendingRequests(),
      questions: this.pendingQuestions(),
      mcpServers: this.catalog.mcpServerInfos(),
      ...(mcpSecretsError ? { mcpSecretsError } : {}),
      agents: this.catalog.list(),
      projects: this.store.listProjects().map((p) => this.withGit(p)),
      threads: this.store.listThreads().map((t) => this.asEnded(t)),
      quotas: this.quotas.list(),
      plan: this.planner.list(),
      schedules: this.scheduler.list(),
      ...(this.locks.hasPin() ? { lockPin: true } : {}),
      ...(pairedDevice ? { pairedDevice: true } : {}),
      ...(defaults ? { defaults } : {}),
      ...(presets ? { teamPresets: presets } : {}),
      roleMascots: this.store.getSetting<RoleMascots>(ROLE_MASCOTS, {}, "object"),
      app: this.app.info(),
      ...(this.storageDown ? { storageError: this.storageNotice()! } : {}),
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
    if (
      message.type === "mcp.setEnabled" ||
      message.type === "mcp.remove" ||
      message.type === "mcp.setAgents" ||
      message.type === "mcp.tools"
    ) {
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
    const owner = packSnapshot(this.snapshot(false));
    let paired: Snapshot | undefined;
    for (const client of this.clients) {
      const snapshot = client.deviceId ? (paired ??= { ...owner, pairedDevice: true }) : owner;
      client.send({ type: "snapshot", snapshot });
    }
  }

  /**
   * The user's actions each device sent, by the id it gave them: one it sends again, its
   * connection having died before it could tell whether this one got there, is done once.
   * Kept per device so one device cannot flush another's ids, and recorded only once done
   * so an action that failed can still be retried.
   */
  private readonly sends = new Map<string, Set<string>>();

  private sendKey(
    client: Client,
    message: ClientMessage,
  ): { actor: string; key: string } | undefined {
    if (!("sendId" in message) || message.sendId === undefined) return undefined;
    const actor = client.deviceId ?? "owner";
    const thread = "threadId" in message ? message.threadId : "";
    return { actor, key: `${message.type}:${thread}:${message.sendId}` };
  }

  private alreadySent(actor: string, key: string): boolean {
    return this.sends.get(actor)?.has(key) ?? false;
  }

  private rememberSend(actor: string, key: string): void {
    let seen = this.sends.get(actor);
    if (!seen) {
      seen = new Set();
      this.sends.set(actor, seen);
    }
    seen.add(key);
    if (seen.size > MAX_SENDS_KEPT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  /** Does what a screen asks. A write the database refuses is said in the user's words. */
  async handle(client: Client, message: ClientMessage): Promise<void> {
    try {
      await this.dispatch(client, message);
    } catch (error) {
      const refused = storageTrouble(error);
      if (!refused || !this.storageFailed(error)) throw error;
      throw new Error(`${refused} : rien n'a été enregistré.`, { cause: error });
    }
  }

  private async dispatch(client: Client, message: ClientMessage): Promise<void> {
    if (client.deviceId && COMPUTER_ONLY_MESSAGES.has(message.type)) {
      throw new Error(ONLY_ON_COMPUTER);
    }
    if (this.refuseLocked(message)) return;
    const sent = this.sendKey(client, message);
    if (sent && this.alreadySent(sent.actor, sent.key)) return;
    if (sent) this.rememberSend(sent.actor, sent.key);
    try {
      await this.runMessage(client, message);
    } catch (error) {
      if (sent) this.sends.get(sent.actor)?.delete(sent.key);
      throw error;
    }
  }

  private async runMessage(client: Client, message: ClientMessage): Promise<void> {
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
      case "workspace.settleRemark": {
        const reply = await this.settleRemark(message.threadId, message.id).then(
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
        // Opened: read. A refused note of it does not keep the thread from opening.
        if (this.store.getThread(message.threadId)?.unread) {
          this.wrote(() => this.updateThread(message.threadId, { unread: false }));
        }
        client.send(
          this.changesSince(message.threadId, message.since) ?? this.opening(message.threadId),
        );
        return;
      case "thread.page": {
        const thread = this.requireThread(message.threadId);
        if (this.deletingThreads.has(thread.id) || this.removingProjects.has(thread.projectId)) {
          throw new Error("Ce fil est en cours de suppression.");
        }
        // Bigger pages only for a use that is not shown: an export reads all of a long
        // thread by them, where one answer of all of it held the server for 0.7 s.
        const page = this.store.pageItems(
          message.threadId,
          message.before,
          message.reach,
          message.apart ? message.size : undefined,
        );
        client.send({
          type: "page",
          requestId: message.requestId,
          threadId: message.threadId,
          before: message.before,
          items: page.items.map(light),
          first: page.first,
          earlier: page.earlier,
          ...(message.apart ? { apart: true as const } : {}),
        });
        return;
      }
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
      case "thread.quotaWait":
        await this.waitInsteadOfFallback(message.threadId);
        return;
      case "thread.quotaCancel":
        this.requireThread(message.threadId);
        this.setThreadQuota(message.threadId, null);
        return;
      case "item.get": {
        this.requireThread(message.threadId);
        const item = this.itemOf(message.threadId, message.itemId);
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
        // The user's own choice: no fallback to come back from.
        this.dropRelief(message.threadId);
        return;
      case "thread.setPermissionMode":
        this.setPermissionMode(message.threadId, message.permissionMode);
        return;
      case "thread.setModel":
        await this.setModel(message.threadId, message.model);
        this.coordinators.keepChoice(message.threadId);
        this.dropRelief(message.threadId);
        return;
      case "thread.setSetting":
        await this.setSetting(message.threadId, message.settingId, message.value);
        return;
      case "thread.setArchived":
        await this.setArchived(message.threadId, message.archived);
        // Resolved after its pull request was merged: its branch has no more use.
        if (message.archived) await this.deleteMergedBranch(message.threadId);
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
      case "project.setArchived": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        if (this.isDiscussions(project.id)) throw new Error("Discussions ne s'archive pas.");
        const others = this.store
          .getSetting<string[]>(ARCHIVED_PROJECTS, [])
          .filter((p) => p !== project.id && this.store.getProject(p));
        this.store.setSetting(
          ARCHIVED_PROJECTS,
          message.archived ? [...others, project.id] : others,
        );
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
      case "defaults.set": {
        const current = this.store.getSetting<Defaults | null>(DEFAULTS, null, "object");
        const defaults: Defaults = {
          permissionMode: message.permissionMode ?? current?.permissionMode ?? "supervised",
          isolated: message.isolated ?? current?.isolated ?? true,
        };
        this.store.setSetting(DEFAULTS, defaults);
        this.broadcast({ type: "defaults", defaults });
        return;
      }
      case "roleMascots.set": {
        const current = this.store.getSetting<RoleMascots>(ROLE_MASCOTS, {}, "object");
        const { [message.job]: _old, ...rest } = current;
        const mascots: RoleMascots = message.look ? { ...rest, [message.job]: message.look } : rest;
        this.store.setSetting(ROLE_MASCOTS, mascots);
        this.broadcast({ type: "roleMascots", mascots });
        return;
      }
      case "teamPresets.set":
        this.store.setSetting(TEAM_PRESETS_SETTING, message.presets);
        this.broadcast({ type: "teamPresets", presets: message.presets });
        return;
      case "project.setDeleteMerged": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        const others = this.store
          .getSetting<string[]>(KEEP_MERGED_BRANCHES, [])
          .filter((p) => p !== project.id && this.store.getProject(p));
        this.store.setSetting(KEEP_MERGED_BRANCHES, message.on ? others : [...others, project.id]);
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
      case "project.setPaused": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        await this.setPaused(project, message.paused);
        return;
      }
      case "project.setQuotaRules": {
        const project = this.store.getProject(message.projectId);
        if (!project) throw new Error("Ce projet n'existe plus.");
        const all = Object.fromEntries(
          Object.entries(
            this.store.getSetting<Record<string, ProjectQuotaRules>>(PROJECT_QUOTA, {}),
          )
            // Projects removed since are dropped on the way.
            .filter(([p]) => p !== project.id && this.store.getProject(p)),
        );
        const current = this.quotaRules(project.id) ?? {};
        const next: ProjectQuotaRules = {
          ...current,
          ...(message.resume !== undefined ? { resume: message.resume } : {}),
          ...(message.fallback ? { fallback: message.fallback } : {}),
        };
        this.store.setSetting(PROJECT_QUOTA, { ...all, [project.id]: next });
        this.broadcast({ type: "project", project: this.withGit(project) });
        return;
      }
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
      case "project.saveMemory":
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
          case "project.saveMemory":
            this.store.setProjectMemory(project.id, message.text);
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
          setup: await readSetup(
            dir,
            !!this.withGit(project).git,
            this.store.getProjectMemory(project.id),
          ),
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
      case "lock.check":
        this.locks.verify(message.pin, client.deviceId ?? COMPUTER_ACTOR);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "lock.reset":
        this.locks.reset();
        this.sendSnapshots();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.get":
        client.send({ type: "hermes", hermes: this.hermes.status() });
        // Its model and its gateway are read from Hermes itself, and sent once known.
        void this.hermes.readModel();
        void this.hermes.watchGateway(true);
        return;
      case "hermes.gateway":
        await this.hermes.watchGateway();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.install":
        this.hermes.install();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.setModel":
        this.hermes.setModel(message.model);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.connect":
        this.hermes.connect();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.cut":
        this.hermes.cut();
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.set":
        this.hermes.set(message);
        client.send({ type: "done", requestId: message.requestId });
        return;
      case "hermes.test":
        await this.hermes.test();
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
      case "app.check":
        this.app.check();
        return;
      case "app.install": {
        const device = client.deviceId
          ? this.store.listDevices().find((d) => d.id === client.deviceId)
          : undefined;
        this.app.requestInstall(
          message.when,
          client.deviceId ? `depuis ${device?.name ?? "un appareil jumelé"}` : "sur cet ordinateur",
        );
        return;
      }
      case "app.cancel":
        this.app.cancel();
        return;
      case "app.settings": {
        const { type: _type, ...patch } = message;
        this.app.setSettings(patch);
        return;
      }
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
      case "file.open": {
        const thread = this.requireThread(message.threadId);
        // Only a file one of its answers names, or one of its tools says it made: the folders
        // where agents keep what they generate are shared by every project, a locked one's too.
        const draft = this.drafts.get(thread.id)?.item;
        const named =
          (draft?.kind === "agent" && draft.text.includes(message.ref)) ||
          this.store.answerHolds(thread.id, message.ref) ||
          this.store.toolMade(thread.id, message.ref);
        if (!named) throw new Error("Aucune réponse de ce fil ne nomme ce fichier.");
        const folder = this.folderOf(thread.projectId, thread.id);
        const project = this.store.getProject(thread.projectId);
        const roots = [
          folder,
          ...(project ? [project.path] : []),
          ...(thread.workspace?.path ? [thread.workspace.path] : []),
        ];
        const found = await resolveThreadFile(
          message.ref,
          folder,
          roots,
          generatedFolders(this.homeDir),
        );
        if (!found) {
          throw new Error(
            "Ce fichier ne peut pas être ouvert d'ici : il n'existe plus, n'est pas une image, un PDF ou une page, ou n'est pas dans les dossiers de ce fil.",
          );
        }
        const { ticket, expiresAt } = this.artifactLinks.issueFile(
          thread.id,
          found.file,
          client.deviceId,
        );
        client.send({
          type: "fileLink",
          requestId: message.requestId,
          url: artifactUrl(ticket, found.name),
          name: found.name,
          mime: found.type,
          size: found.size,
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
        const projectId = message.projectId;
        if (projectId && !this.store.getProject(projectId)) {
          throw new Error("Ce projet n'existe plus.");
        }
        const routes = { ...(projectId ? settings.projectRoutes?.[projectId] : settings.routes) };
        delete routes[message.kind];
        if (message.agentId) {
          // Refused now rather than at the first thread a coordinator opens with it.
          this.agents.launch(message.agentId);
          routes[message.kind] = memberOf({ ...message, agentId: message.agentId });
        }
        if (!projectId) {
          this.coordinators.setCoordinatorSettings({ ...settings, routes });
          return;
        }
        // Projects removed since are dropped on the way.
        const projectRoutes = Object.fromEntries(
          Object.entries(settings.projectRoutes ?? {}).filter(
            ([p]) => p !== projectId && this.store.getProject(p),
          ),
        );
        if (Object.keys(routes).length) projectRoutes[projectId] = routes;
        const { projectRoutes: _was, ...rest } = settings;
        this.coordinators.setCoordinatorSettings(
          Object.keys(projectRoutes).length ? { ...rest, projectRoutes } : rest,
        );
        return;
      }
      case "discussions.setModel": {
        const { loose: _was, ...rest } = this.coordinators.coordinatorSettings();
        const agentId = message.agentId;
        if (agentId) this.agents.launch(agentId);
        this.coordinators.setCoordinatorSettings(
          agentId ? { ...rest, loose: memberOf({ ...message, agentId }) } : rest,
        );
        return;
      }
      case "coordinator.restart":
        await this.restartCoordinator(message.projectId);
        client.send({ type: "done", requestId: message.requestId });
        return;
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
            ...(message.reviewer2 ? { reviewer2: message.reviewer2 } : {}),
            ...(message.judge ? { judge: message.judge } : {}),
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
      case "team.addMission":
        this.teams.addMission(message.threadId, message.text);
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
      case "thread.move":
        await this.moveThread(message.threadId, message.projectId);
        return;
      case "thread.rename": {
        this.requireThread(message.threadId);
        // One line: a name pasted with its line breaks would break the lists of threads.
        const title = plainLabel(message.title.replace(/\s+/g, " ")).trim();
        if (title) this.updateThread(message.threadId, { title });
        return;
      }
      case "files.search": {
        const dir = this.folderOf(message.projectId, message.threadId);
        const files = searchFiles(await listFiles(dir), message.query, message.limit);
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
        // What the search left unindexed is filled in the background.
        this.indexSearchSoon();
        return;
      case "agent.setMascot":
        this.setMascot(message.agentId, message.mascot);
        return;
      case "favorites.toggle":
        this.catalog.toggleFavorite(message.agentId, message.model, message.starred);
        return;
      case "favorites.reorder":
        this.reorderFavorites(message.order);
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
      case "mcp.setAgents":
        this.catalog.setMcpAgents(message.id, message.agentIds);
        return;
      case "mcp.tools": {
        const server = (await this.catalog.mcpServers()).find((s) => s.id === message.id);
        if (!server) throw new Error("Ce serveur MCP n'existe plus.");
        const tools = await probeMcpTools(server);
        client.send({ type: "mcpTools", requestId: message.requestId, tools });
        return;
      }
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
   * Whether the project is « Discussions »: its conversations have nothing in common but
   * where they are kept, so they share no memory and do not read each other.
   */
  private isDiscussions(projectId: string): boolean {
    const project = this.store.getProject(projectId);
    return project?.name === "Discussions" && path.basename(project.path) === "Discussions";
  }

  /**
   * The project « Discussions », where conversations started without a project go: a folder
   * beside where projects are usually made, created the first time it is needed. One already made
   * is reused, wherever the next projects go.
   */
  discussionsProject(): string {
    const made = this.store.listProjects().find((p) => this.isDiscussions(p.id));
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
        ? this.ownWorkspace(title, id)
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
    reviewer2?: { agentId: string; model?: string | undefined } | undefined;
    judge?: { agentId: string; model?: string | undefined } | undefined;
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
      // A second review and a judge only come with a first review.
      reviewer2: input.reviewer && input.reviewer2 && member(input.reviewer2),
      judge: input.reviewer && input.judge && member(input.judge),
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
      ...this.ownWorkspace(`revue-pr-${number}`, threadId),
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
        title: plainLabel(pr.title),
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

  /**
   * What the iPhone widgets show: quotas, the threads that wait or work, Hermes. Asking reads
   * the quotas again when they are old, as an open window does, without waiting for long.
   */
  async widget(): Promise<WidgetData> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.quotas.fresh().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, WIDGET_QUOTA_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return widgetData({
      now: Date.now(),
      agents: this.catalog.list(),
      quotas: this.quotas.list(),
      projects: this.store.listProjects(),
      threads: this.store.listThreads().map((t) => this.asEnded(t)),
      requests: this.pendingRequests(),
      questions: this.pendingQuestions(),
      schedules: this.scheduler.list(),
      hermes: this.hermes.status(),
      clock: this.threadClock,
      locked: (projectId) => this.locks.isLocked(projectId),
      modelName: (agentId, model) => this.modelNames(agentId, model)[1],
    });
  }

  /** One tool call of Hermes, from its bridge. */
  hermesCall(token: string, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.hermes.call(token, tool, args, signal);
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
    const items = this.lastTurn(threadId);
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
    // A project on hold keeps its turns in line; those behind them go first.
    const free = (threadId: string) => {
      const projectId = this.store.getThread(threadId)?.projectId;
      return !projectId || !this.paused(projectId);
    };
    while (this.turnsAtWork() < this.maxTurns() && this.line.next(free));
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
  queueMessage(threadId: string, text: string, from?: "coordinator" | "hermes"): void {
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
    } else if (message.from === "hermes") this.sendHermesNow(threadId, message.text);
    else this.sendByUser(threadId, message.text);
  }

  /**
   * The user's own message, written on Discord and brought by Hermes: sent as theirs, with
   * its origin shown, or kept for after the turn under way.
   */
  sendFromHermes(threadId: string, text: string): "sent" | "queued" {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId) || thread.queue?.length) {
      this.queueMessage(threadId, text, "hermes");
      return "queued";
    }
    this.sendHermesNow(threadId, text);
    return "sent";
  }

  private sendHermesNow(threadId: string, text: string): void {
    const held = this.store.getThread(threadId)?.held;
    this.send(
      threadId,
      held ? `${held}\n\n${text}` : text,
      this.leadContext(threadId) ?? this.coordinators.coordinatorContext(threadId),
      undefined,
      "hermes",
    );
    if (held) this.updateThread(threadId, { held: null });
  }

  /**
   * A task Hermes plans: started on the agent coordinators send work to, supervised, on its
   * own branch when the project is a git repository.
   */
  private hermesSchedule(input: {
    projectId: string;
    title?: string;
    text: string;
    at: number;
    repeat: ScheduleRepeat;
  }): Schedule {
    const found = this.store.getProject(input.projectId);
    if (!found) throw new Error("Projet introuvable.");
    const project = this.withGit(found);
    const route = this.coordinators.coordinatorSettings().routes.default;
    const coordinator = this.store
      .listThreads()
      .find((t) => t.projectId === input.projectId && t.kind === "coordinator");
    const agentId = route?.agentId ?? coordinator?.agentId;
    if (!agentId) {
      throw new Error("Aucun agent par défaut : ouvre le coordinateur du projet dans MoonAgentic.");
    }
    this.agents.launch(agentId);
    return this.scheduler.add({
      ...input,
      agentId,
      model: route ? route.model : coordinator?.model,
      permissionMode: "supervised",
      isolated: !!project.git,
      by: "hermes",
    });
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
    from?: "coordinator" | "goal" | "pr" | "remarks" | "hermes",
    auto?: boolean,
    /** The images joined to the message, already sent to the server. */
    attachments?: readonly string[],
  ): void {
    const thread = this.requireLiveThread(threadId);
    if (this.turns.has(threadId)) throw new Error("L'agent travaille encore sur ce fil.");
    // A turn whose message could not be kept is not started: the user sends it again later.
    if (this.storageDown) throw new StorageRefused(this.storageDown);
    // Nothing new starts while the app is replaced: it would be cut off a moment later.
    if (this.app.switching) {
      throw new Error("MoonAgentic installe sa mise à jour : réessaie après le redémarrage.");
    }
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
    this.updateThread(threadId, {
      status: "running",
      error: null,
      // A turn on its way: nothing waits for the quota any more.
      ...(thread.quota?.state === "wait" ? { quota: null } : {}),
    });
    this.quotaRetryAt.delete(threadId);
    // This turn's own end is the one that counts from here.
    this.unsettled.delete(threadId);
    this.turnIds.set(threadId, randomUUID());
    this.cancelled.delete(threadId);
    this.pool.clearIdle(threadId);
    const queued = !!(byTeam || from || auto);
    const turn = this.runTurn(thread, text, itemId, context, queued, images)
      .catch((error: unknown) => {
        // A write the database refused where the turn did not expect it: the turn is over all
        // the same, and nothing waits on its promise to say so. Any other failure stays one.
        const refused = storageTrouble(error);
        if (!refused || !this.storageFailed(error)) throw error;
        this.settleTurn(threadId, {
          status: "error",
          error: `${refused} : ce tour n'a pas pu aller au bout.`,
        });
      })
      .finally(() => this.afterTurn(threadId));
    this.turns.set(threadId, turn);
    this.diagnostics?.onActivityChanged();
  }

  /**
   * What the end of a turn sets going, whatever its end. Each write stands alone: one the
   * database refuses (see `wrote`) keeps neither the next from being tried nor the thread
   * from going on.
   */
  private afterTurn(threadId: string): void {
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
    this.wrote(() => {
      if (this.store.getThread(threadId)?.quietSince) {
        this.updateThread(threadId, { quietSince: null });
      }
    });
    this.pool.leftIdle(threadId);
    if (!this.closed) {
      // What the turn used shows in the agent's figures soon after.
      const agentId = this.store.getThread(threadId)?.agentId;
      if (agentId) this.quotas.afterTurn(agentId);
      this.wrote(() => {
        const summary = summaryOf(this.lastReply(threadId));
        const now = this.store.getThread(threadId);
        if (summary && now && now.summary !== summary) this.updateThread(threadId, { summary });
        // Answered with no window on it: unread, until it is opened. A team's members are
        // read through their lead, and a coordinator on its project's page.
        const seen = [...this.clients].some((c) => c.openThreadIds?.has(threadId));
        if (summary && now && !seen && !cancelled && !now.parentId && now.kind !== "coordinator") {
          this.updateThread(threadId, { unread: true });
        }
      });
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
        if (!this.storageFailed(error)) console.error("Message après un refus :", error);
      }
    }
    // A turn the user stopped starts nothing by itself: what waits goes after the next one.
    // One that ended on an error holds the user's own messages back: they look at it first.
    // Unless they stopped it for a message that waits to go now.
    const now = this.store.getThread(threadId);
    const failed = !!now && this.asEnded(now).status === "error";
    const atOnce = this.sendAfterStop.delete(threadId);
    // A quota that ran out: a fallback model takes over, or the thread waits for the reset.
    // Either is the thread's next step, never both, and nothing else goes on meanwhile.
    if (!cancelled && !this.closed && !this.turns.has(threadId) && this.onQuotaStop(threadId)) {
      this.prFixing.delete(threadId);
      return;
    }
    // A thread that got through a turn on its fallback, with no going back, is just on it now.
    if (!this.closed && !failed) this.settleRelief(threadId);
    // A fix of the pull request whose words after a refusal go on in a new turn is pushed
    // when that one ends.
    if (this.prFixing.has(threadId) && this.turns.has(threadId)) return;
    const fixing = this.prFixing.delete(threadId);
    this.wrote(() => {
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
    const turn = this.lastTurn(threadId);
    const asked = turn.findLast((i) => i.kind === "user");
    if (asked?.kind !== "user" || asked.from !== "coordinator") return;
    // Its conclusion: what it said last, after its tools, not how it set out.
    const last = turn.findLast((i) => i.kind === "agent" || i.kind === "user");
    const summary = last?.kind === "agent" ? leadOf(last.text, 2, RESULT_LIMIT) : "";
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
    await this.puttingAway.get(threadId);
  }

  /**
   * Puts the earlier run of a planned task in the archive, its folder given back to the disk,
   * once the next run has started: it can be taken out again, its files with it. Not one
   * still at work, pinned, or already put away.
   */
  private putAwayRun(earlier: string, next: string): void {
    const thread = this.store.getThread(earlier);
    // One the user pinned stays where they want it.
    if (!thread || thread.archived || thread.pinned || thread.kind === "coordinator") return;
    if (this.turns.has(earlier) || this.busy.has(earlier) || this.groupActive(earlier)) return;
    const step = this.setArchived(earlier, true).catch((error: unknown) =>
      console.error(
        `Lancement précédent d'une tâche planifiée laissé en place (${earlier}) :`,
        error,
      ),
    );
    this.steps.add(step);
    this.puttingAway.set(next, step);
    void step.finally(() => {
      this.steps.delete(step);
      if (this.puttingAway.get(next) === step) this.puttingAway.delete(next);
    });
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
        if (await this.frozeOnSetting(threadId, session, (s) => s.setModel(model))) {
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
  private async frozeOnSetting(
    threadId: string,
    session: AgentSession,
    change: (session: AgentSession) => Promise<void>,
  ): Promise<boolean> {
    try {
      await change(session);
      return false;
    } catch (error) {
      // An agent that went away takes the change with it: the next one starts with it.
      if (CONNECTION_CLOSED.test(describe(error)) || session.closed) {
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
        if (await this.frozeOnSetting(threadId, session, (s) => s.setSetting(settingId, value))) {
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
    const settled = new Set(
      this.store.getSetting<Record<string, string[]>>(SETTLED_REVIEWS, {})[pr.url] ?? [],
    );
    const remarks = (await on.github.remarks(on.repo, pr.number)).map((r) =>
      r.kind === "review" && settled.has(r.id) ? { ...r, settled: true as const } : r,
    );
    return { pr, remarks };
  }

  /**
   * « Réglé »: the remark is done with. A conversation is resolved on GitHub, by the user's own
   * `gh`; a review is kept settled here, for this pull request. Returns the remarks read again.
   */
  async settleRemark(
    threadId: string,
    remarkId: string,
  ): Promise<{ pr: PullRequestInfo; remarks: PullRequestRemark[] } | undefined> {
    this.requireThread(threadId);
    const found = await this.pullRequestRemarks(threadId);
    if (!found) throw new Error("Cette branche n'a plus de pull request ouverte sur GitHub.");
    const remark = found.remarks.find((r) => r.id === remarkId);
    if (!remark) throw new Error("Cette remarque n'est plus sur GitHub : actualise la liste.");
    if (remark.settled) return found;
    if (remark.kind === "thread") {
      const on = await this.branchOnGithub(threadId);
      if (!on?.github.resolveRemark)
        throw new Error("GitHub CLI (gh) est requis pour régler une remarque.");
      await on.github.resolveRemark(remark.id);
    } else {
      const all = this.store.getSetting<Record<string, string[]>>(SETTLED_REVIEWS, {});
      // Pull requests no thread has any more are dropped on the way.
      const kept = Object.fromEntries(
        Object.entries(all).filter(([url]) =>
          this.store.listThreads().some((t) => t.pr?.url === url),
        ),
      );
      this.store.setSetting(SETTLED_REVIEWS, {
        ...kept,
        [found.pr.url]: [...(all[found.pr.url] ?? []), remark.id],
      });
    }
    return this.pullRequestRemarks(threadId);
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
    const picked = found.remarks.filter((r) => wanted.has(r.id) && !r.settled);
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
    this.noteGreen(thread, pr);
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
    if (this.store.getThread(threadId)?.archived)
      await this.deleteMergedBranch(threadId, info.head);
  }

  /**
   * « Supprimer après la fusion »: once a resolved thread's pull request is merged, its branch
   * goes from the project's repository, unless the project keeps them. Looked at again just
   * before, like a branch deleted by hand: still merged, and nobody working on it.
   */
  private async deleteMergedBranch(threadId: string, mergedHead?: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    const branch = thread?.workspace?.base ? thread.workspace.branch : undefined;
    if (!thread?.archived || !branch || thread.pr?.state !== "merged") return;
    if (this.store.getSetting<string[]>(KEEP_MERGED_BRANCHES, []).includes(thread.projectId))
      return;
    // Kept on the thread when it was merged, for a thread the user resolves later.
    const head = mergedHead ?? thread.pr.mergedHead;
    try {
      const { kept } = await deleteMergedBranches(
        this.gitProjectPath(thread.projectId),
        this.branchOwners(),
        [branch],
        head ? { [branch]: head } : {},
      );
      if (kept.length) console.warn(`Branche ${branch} gardée : ${kept[0]!.reason}`);
    } catch (error) {
      if (!this.closed) console.error("Suppression de la branche après la fusion :", error);
    }
  }

  /**
   * Tells the coordinator's conversation, once at least `GREEN_AT_ONCE` pull requests of the
   * threads it opened have turned green and wait only on a review: one short message with a
   * link to each thread and its pull request. Nothing runs for it: the server writes it.
   */
  private noteGreen(thread: Thread, pr: Thread["pr"] | undefined) {
    const coordinatorId = thread.openedBy;
    if (!coordinatorId || !this.store.getThread(coordinatorId)) return;
    const green = (p: Thread["pr"] | undefined): p is NonNullable<Thread["pr"]> =>
      !!p && (p.state === "open" || p.state === "draft") && p.checks === "passed" && !p.conflicts;
    if (!green(pr)) return;
    let told = this.greenTold.get(coordinatorId);
    if (!told) {
      told = new Set<string>();
      for (const item of this.store.listItems(coordinatorId)) {
        if (item.kind !== "agent" || !item.id.startsWith("green:")) continue;
        for (const m of item.text.matchAll(/\]\(fil:([\w-]+)\) : sa PR (\S+) /g))
          told.add(`${m[1]} ${m[2]}`);
      }
      this.greenTold.set(coordinatorId, told);
    }
    // Counted from the threads as they are kept, not from what this run saw turn green: one
    // that turned green before the server started again waits as much as the others.
    const urls = new Set<string>();
    const waiting = this.store.listThreads().filter((t) => {
      if (t.openedBy !== coordinatorId || !green(t.pr)) return false;
      // A team's lead shows its merge thread's pull request: it counts once.
      if (told.has(`${t.id} ${t.pr.url}`) || urls.has(t.pr.url)) return false;
      urls.add(t.pr.url);
      return true;
    });
    if (waiting.length < GREEN_AT_ONCE) return;
    const lines = waiting.map((t) => {
      told.add(`${t.id} ${t.pr!.url}`);
      return `- [${t.title.replace(/[[\]]/g, "")}](fil:${t.id}) : sa PR ${t.pr!.url} passe toutes ses vérifications.`;
    });
    this.putItem(coordinatorId, {
      id: `green:${randomUUID()}`,
      kind: "agent",
      text: `Les ${lines.length} PR sont vertes. Chacune attend seulement ta relecture.\n\n**Prêt pour relecture**\n\n${lines.join("\n")}`,
      at: Date.now(),
    });
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
      // What the step back takes away is kept first: the last turn's files and those put
      // there by hand since are in no message's checkpoint. Without it, no step back.
      try {
        await saveCheckpoint(workspace.path, undoneRef(threadId, Date.now()));
      } catch (error) {
        throw new Error(
          `Retour en arrière annulé : les fichiers actuels n'ont pas pu être gardés d'abord (${describe(error)}).`,
        );
      }
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
    return this.store.recordSetting(
      "pendingRestores",
      (r): r is PendingRestore =>
        isRecord(r) && typeof r.itemId === "string" && typeof r.tree === "string",
    );
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
      // Going back to before a move keeps the thread in its project: the move stays told.
      const moved = removed.find((i) => i.kind === "moved");
      if (moved) this.store.putItem(threadId, moved);
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
    // What waited to be written came after the message gone back to: it goes with the rest,
    // and so does the end of a turn that waited, which would put the thread back as it was.
    this.dropHeld(threadId);
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
        // Those from before a move share the move's ref, which stays for the others.
        i.kind === "user" && i.checkpoint && !i.beforeMove ? [checkpointRef(threadId, i.id)] : [],
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
      const workspace = this.store.getThread(threadId)?.workspace;
      if (
        workspace?.base &&
        project &&
        this.ownFolder(threadId, workspace.path) &&
        existsSync(workspace.path)
      ) {
        // Written down before the folder goes: a stop in between loses nothing. The files
        // git ignores one by one go with it (`.env.local`), as the folder is all they had.
        // Not saved again after a removal cut short: what it left is not all the thread had.
        const kept =
          workspace.archivedTree ??
          (await saveCheckpoint(workspace.path, archiveRef(threadId), true));
        this.updateThread(threadId, { workspace: { ...workspace, archivedTree: kept } });
        try {
          await removeWorktree(project.path, workspace.path);
        } catch (error) {
          // The folder stays in use (Windows): the thread stays out of the archive, its files
          // as they are if none went. Otherwise they are those of the checkpoint from now
          // on, which stays written down and comes back with the thread's next step.
          if (await matchesCheckpoint(workspace.path, kept, true).catch(() => false)) {
            const { archivedTree: _whole, ...asItWas } = workspace;
            this.updateThread(threadId, { workspace: asItWas });
          }
          throw error;
        }
      }
      this.updateThread(threadId, { archived: true, status: "idle" });
      this.dropLog(threadId);
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

  /**
   * `threads`, when given, are all the threads there are: a project's removal reads them
   * once for all of its own, instead of once for each.
   */
  private async deleteOneThread(threadId: string, threads?: ThreadPlace[]): Promise<void> {
    const thread = this.requireThread(threadId);
    await this.exclusive(threadId, "Attends la fin de la suppression.", async () => {
      this.deletingThreads.add(threadId);
      try {
        await this.releaseFolder(threadId, threads);
        await this.forgetSession(threadId);
        this.settlePermissions(threadId);
        const project = this.store.getProject(thread.projectId);
        const workspace = thread.workspace;
        if (workspace && project) {
          if (this.ownFolder(threadId, workspace.path, threads))
            await removeWorktree(project.path, workspace.path);
          await dropRefs(project.path, `refs/moonagentic/${threadId}/`).catch(() => undefined);
        }
        // Drop pending drafts and held writes before yielding across deletion batches so
        // neither flushAll() nor storage recovery writes items back into a deleted thread.
        clearTimeout(this.drafts.get(threadId)?.timer);
        this.drafts.delete(threadId);
        this.dropHeld(threadId);
        // A long timeline goes a stretch at a time, the latest first, so screens are answered
        // meanwhile: in one go, 20 000 messages held the server half a second.
        // Their room goes back to the disk a stretch at a time too.
        for (;;) {
          const more = this.store.deleteSomeItems(threadId, DELETE_BATCH);
          while (this.store.shrink(SHRINK_PAGES)) await nextTurn();
          if (!more) break;
          await nextTurn();
        }
        this.setPendingRestore(threadId, undefined);
        this.dropLog(threadId);
        this.threadGrants.delete(threadId);
        this.greenTold.delete(threadId);
        this.quotaThreads.delete(threadId);
        this.quotaRetryAt.delete(threadId);
        this.coordinators.forget(threadId);
        this.attachments.forget(threadId);
        this.store.deleteThread(threadId);
        this.broadcast({ type: "threadRemoved", threadId });
        this.planner.threadDeleted(threadId);
        this.scheduler.threadDeleted(threadId);
      } finally {
        this.deletingThreads.delete(threadId);
      }
    });
  }

  /** Removes the project and its threads from MoonAgentic; its folder is left as it is. */
  async removeProject(projectId: string): Promise<void> {
    if (!this.store.getProject(projectId)) throw new Error("Projet introuvable.");
    if (this.removingProjects.has(projectId))
      throw new Error("Ce projet est déjà en cours de retrait.");
    const all = this.store.listThreadPlaces();
    const threads = all.filter((t) => t.projectId === projectId);
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
      // Read once: each thread's removal reading them all again held the server for
      // seconds with a few thousand threads. A thread made meanwhile is in another project.
      const left = new Map(all.map((t) => [t.id, t]));
      for (const thread of order) {
        this.busy.delete(thread.id);
        await this.deleteOneThread(thread.id, [...left.values()]);
        left.delete(thread.id);
        // Screens are answered between two threads.
        await nextTurn();
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
    return this.ourFolder(dir) !== undefined;
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

  /** The project's rules for a quota that runs out, once set. */
  private quotaRules(projectId: string): ProjectQuotaRules | undefined {
    return this.store.getSetting<Record<string, ProjectQuotaRules>>(PROJECT_QUOTA, {})[projectId];
  }

  /** The words a model goes by, for the quota windows: its id and the name its agent gives. */
  private modelNames(agentId: string, model: string): (string | undefined)[] {
    const name = this.store.getAgentModels(agentId)?.models.find((c) => c.id === model)?.name;
    return [model, name];
  }

  /** When the figures, or else the agent's own words, say this model's quota is back. */
  private quotaBackAt(ref: FavoriteRef, said: string, now = Date.now()): number | undefined {
    const left = spentUntil(
      this.quotas.get(ref.agentId),
      this.modelNames(ref.agentId, ref.model),
      now,
    );
    return (left && left.until) || resetFromText(said, now);
  }

  private setThreadQuota(threadId: string, quota: ThreadQuota | null): void {
    if (!this.store.getThread(threadId)) return;
    this.updateThread(threadId, { quota });
    if (quota) this.quotaThreads.add(threadId);
    else {
      this.quotaThreads.delete(threadId);
      this.quotaRetryAt.delete(threadId);
    }
  }

  /** The user picked a model or an agent themselves: the thread is no longer on a fallback. */
  private dropRelief(threadId: string): void {
    if (this.store.getThread(threadId)?.quota?.state === "relief")
      this.setThreadQuota(threadId, null);
  }

  /** After a turn that went through on a fallback that does not go back: just its model now. */
  private settleRelief(threadId: string): void {
    const thread = this.store.getThread(threadId);
    const relief = thread?.quota?.state === "relief" ? thread.quota : undefined;
    if (!thread || !relief) return;
    if (this.quotaRules(thread.projectId)?.fallback?.back) {
      // It went through: the fallbacks that ran out before may be tried again next time.
      if (relief.tried) {
        const { tried: _tried, ...kept } = relief;
        this.wrote(() => this.setThreadQuota(threadId, kept));
      }
      return;
    }
    this.wrote(() => this.setThreadQuota(threadId, null));
  }

  /**
   * Called as a turn ends, before anything else goes on: when its quota stopped it, the
   * project's rules say what follows. A fallback with quota left takes over at once and goes
   * on; with none, the thread waits on its own model for the reset, when the project asks;
   * the user's other messages wait meanwhile. True when it took the thread's next step.
   * Teams and reviews keep their own way of handling a failure.
   */
  private onQuotaStop(threadId: string): boolean {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.archived || thread.parentId || thread.role) return false;
    if (thread.team || thread.prReview) return false;
    const ended = this.asEnded(thread);
    const error = ended.status === "error" ? ended.error : undefined;
    const turn = this.lastTurn(threadId);
    const answer = turn.some((i) => i.kind === "tool")
      ? undefined
      : turn
          .flatMap((i) => (i.kind === "agent" ? [i.text] : []))
          .join("\n")
          .trim();
    if (!quotaStopped(error, answer)) return false;
    const rules = this.quotaRules(thread.projectId);
    const said = [error, answer].filter(Boolean).join("\n");
    const now = Date.now();
    const spent: FavoriteRef = { agentId: thread.agentId, model: thread.model ?? "" };
    const relief = thread.quota?.state === "relief" ? thread.quota : undefined;
    // On a fallback, its own model is the one to come back to.
    const own = relief?.from ?? spent;
    const ownBack = relief ? relief.back : this.quotaBackAt(spent, said, now);
    // Every fallback that ran out since the thread left its own model: never one twice.
    const tried = relief ? [...(relief.tried ?? []), relief.to] : [];
    const next = nextFallback(rules, spent, {
      tried: relief ? [relief.from, ...tried] : [],
      installed: (agentId) => !!this.catalog.list().find((a) => a.id === agentId && a.available),
      quota: (agentId) => this.quotas.get(agentId),
      names: (agentId, model) => this.modelNames(agentId, model),
      now,
    });
    if (next) {
      const back = rules?.fallback?.back ? ownBack : undefined;
      this.runQuotaStep(threadId, () => this.takeOver(threadId, own, next, back, tried));
      return true;
    }
    if (rules?.resume) {
      this.runQuotaStep(threadId, () => this.waitForQuota(threadId, own, ownBack));
      return true;
    }
    // Nothing to do but say it: a thread left on a spent fallback goes back to its own model.
    if (relief) this.runQuotaStep(threadId, () => this.putBack(threadId, own));
    return false;
  }

  /** Runs one step of a thread's quota handling, kept for `close` to wait on. */
  private runQuotaStep(threadId: string, work: () => Promise<void>): void {
    if (this.quotaActing.has(threadId)) return;
    this.quotaActing.add(threadId);
    const step = work()
      .catch((error: unknown) => {
        if (!this.closed && !this.storageFailed(error)) console.error("Quota :", error);
      })
      .finally(() => this.quotaActing.delete(threadId));
    this.steps.add(step);
    void step.finally(() => this.steps.delete(step));
  }

  /** Puts the thread on a model, changing agent when it is another one's. */
  private async putOn(threadId: string, ref: FavoriteRef): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    if (thread.agentId !== ref.agentId) {
      await this.switchAgent(threadId, ref.agentId);
      // The new agent starts on it: its models may not be known before its first start.
      if (ref.model) this.updateThread(threadId, { model: ref.model });
    } else if (ref.model && thread.model !== ref.model) {
      await this.setModel(threadId, ref.model);
    }
  }

  /** The fallback takes over, and the agent goes on where the quota stopped it. */
  private async takeOver(
    threadId: string,
    own: FavoriteRef,
    to: FavoriteRef,
    back: number | undefined,
    tried: FavoriteRef[],
  ): Promise<void> {
    await this.putOn(threadId, to);
    if (this.closed) return;
    this.setThreadQuota(threadId, {
      state: "relief",
      from: own,
      to,
      since: Date.now(),
      ...(back ? { back } : {}),
      ...(tried.length ? { tried } : {}),
    });
    this.send(threadId, RESUME_TEXT, undefined, undefined, undefined, true);
  }

  /** The thread waits on its own model for its quota, to start again by itself. */
  private async waitForQuota(
    threadId: string,
    own: FavoriteRef,
    until: number | undefined,
  ): Promise<void> {
    await this.putOn(threadId, own);
    if (this.closed) return;
    this.setThreadQuota(threadId, {
      state: "wait",
      agentId: own.agentId,
      ...(own.model ? { model: own.model } : {}),
      since: Date.now(),
      ...(until ? { until } : {}),
    });
    if (!until) this.quotaRetryAt.set(threadId, Date.now() + UNKNOWN_RESET_RETRY_MS);
  }

  /** Back on its own model, with nothing more to do about the quota. */
  private async putBack(threadId: string, own: FavoriteRef): Promise<void> {
    await this.putOn(threadId, own);
    this.setThreadQuota(threadId, null);
  }

  /**
   * « Attendre »: the thread leaves its fallback, its turn there stopped, and waits on its own
   * model for its quota, to start again by itself.
   */
  private async waitInsteadOfFallback(threadId: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    const relief = thread.quota?.state === "relief" ? thread.quota : undefined;
    if (!relief) throw new Error("Ce fil n'est pas sur un modèle de secours.");
    if (this.quotaActing.has(threadId)) throw new Error("Attends la fin du changement de modèle.");
    // Held while its turn stops: no tick puts it back meanwhile.
    this.quotaActing.add(threadId);
    try {
      const turn = this.turns.get(threadId);
      if (turn) {
        await this.cancel(threadId);
        await turn.catch(() => undefined);
      }
      // Something else may have moved it meanwhile: a message, a model picked, a removal.
      const now = this.store.getThread(threadId);
      if (
        !now ||
        now.archived ||
        now.quota?.state !== "relief" ||
        this.turns.has(threadId) ||
        this.busy.has(threadId)
      ) {
        return;
      }
      await this.waitForQuota(threadId, relief.from, relief.back);
    } finally {
      this.quotaActing.delete(threadId);
    }
  }

  private startQuotaTick(everyMs: number): void {
    const later = Date.now() + UNKNOWN_RESET_RETRY_MS;
    for (const thread of this.store.listThreads()) {
      if (!thread.quota) continue;
      this.quotaThreads.add(thread.id);
      // With no time given, it is tried again later, not on each restart.
      const at = thread.quota.state === "wait" ? thread.quota.until : thread.quota.back;
      if (at === undefined) this.quotaRetryAt.set(thread.id, later);
    }
    if (everyMs <= 0) return;
    this.quotaTimer = setInterval(() => void this.quotaTick(), everyMs);
    this.quotaTimer.unref();
    void this.quotaTick();
  }

  /**
   * Looks at each thread that waits on a quota or runs on a fallback that goes back: once its
   * own model has quota again, the waiting one starts again and the other goes back to it.
   * The figures, when readable, have the last word on whether the quota is back.
   */
  async quotaTick(now = Date.now()): Promise<void> {
    for (const threadId of Array.from(this.quotaThreads)) {
      if (this.closed) return;
      const thread = this.store.getThread(threadId);
      const quota = thread?.quota;
      if (!thread || !quota || thread.archived) {
        if (thread?.quota) this.setThreadQuota(threadId, null);
        else this.quotaThreads.delete(threadId);
        continue;
      }
      if (this.quotaActing.has(threadId) || this.turns.has(threadId) || this.busy.has(threadId)) {
        continue;
      }
      if (quota.state === "relief" && !this.quotaRules(thread.projectId)?.fallback?.back) continue;
      const own: FavoriteRef =
        quota.state === "wait" ? { agentId: quota.agentId, model: quota.model ?? "" } : quota.from;
      const at = quota.state === "wait" ? quota.until : quota.back;
      const due = at !== undefined ? at + RESET_MARGIN_MS : this.quotaRetryAt.get(threadId);
      if (due !== undefined && now < due) continue;
      if (now - quota.since > GIVE_UP_AFTER_MS) {
        this.setThreadQuota(threadId, null);
        continue;
      }
      // The figures may say it is not back yet, and when it will be. The thread is held
      // meanwhile, and looked at again after: the user may have moved it in between.
      this.quotaActing.add(threadId);
      try {
        await this.quotas.refresh(own.agentId, RESET_MARGIN_MS).catch(() => undefined);
      } finally {
        this.quotaActing.delete(threadId);
      }
      if (this.closed) return;
      const after = this.store.getThread(threadId);
      if (
        !after ||
        after.archived ||
        JSON.stringify(after.quota) !== JSON.stringify(quota) ||
        this.turns.has(threadId) ||
        this.busy.has(threadId)
      ) {
        continue;
      }
      const left = spentUntil(
        this.quotas.get(own.agentId),
        this.modelNames(own.agentId, own.model),
        now,
      );
      if (left) {
        if (left.until && left.until !== at) {
          this.setThreadQuota(
            threadId,
            quota.state === "wait"
              ? { ...quota, until: left.until }
              : { ...quota, back: left.until },
          );
        } else if (!left.until) {
          this.quotaRetryAt.set(threadId, now + UNKNOWN_RESET_RETRY_MS);
        }
        continue;
      }
      // Unknown figures and no time given: tried now, and again later if it stops again.
      if (at === undefined) this.quotaRetryAt.set(threadId, now + UNKNOWN_RESET_RETRY_MS);
      if (quota.state === "wait") {
        this.setThreadQuota(threadId, null);
        try {
          this.resume(threadId);
        } catch (error) {
          if (!this.storageFailed(error)) console.error("Reprise après le quota :", error);
        }
      } else {
        this.runQuotaStep(threadId, () => this.putBack(threadId, own));
      }
    }
  }

  /**
   * Takes a conversation started outside any project (« Discussions ») into a project, between
   * two turns. Its agent starts again there, in that project's folder, with the conversation so
   * far and the project's memory. A copy of work it had in « Discussions » is kept in git first.
   */
  async moveThread(threadId: string, projectId: string): Promise<void> {
    const thread = this.requireLiveThread(threadId);
    if (thread.projectId === projectId) return;
    if (!this.isDiscussions(thread.projectId)) {
      throw new Error("Seule une discussion hors projet se déplace dans un projet.");
    }
    const from = this.store.getProject(thread.projectId);
    // Asked again after each wait: the project can be removed or locked meanwhile.
    const checkTarget = () => {
      if (!this.store.getProject(projectId) || this.removingProjects.has(projectId)) {
        throw new Error("Projet introuvable.");
      }
      if (this.isDiscussions(projectId)) throw new Error("Choisis un projet.");
      if (this.locks.isLocked(projectId)) throw new Error("Ce projet est verrouillé.");
    };
    checkTarget();
    await this.exclusive(threadId, "Attends la fin du déplacement.", async () => {
      await this.releaseFolder(threadId);
      await this.forgetSession(threadId);
      checkTarget();
      const workspace = this.store.getThread(threadId)?.workspace;
      if (
        workspace?.base &&
        from &&
        this.ownFolder(threadId, workspace.path) &&
        existsSync(workspace.path)
      ) {
        // Written down before the folder goes, as for a resolved thread: should the project
        // go away meanwhile, the conversation stays where it was and gets its files back.
        const kept =
          workspace.archivedTree ??
          (await saveCheckpoint(workspace.path, archiveRef(threadId), true));
        this.updateThread(threadId, { workspace: { ...workspace, archivedTree: kept } });
        await removeWorktree(from.path, workspace.path);
      }
      // Nothing waits between this last look and the move itself.
      checkTarget();
      this.store.moveThread(threadId, projectId);
      // What was allowed « pour ce fil » outside any project is asked again in the project.
      this.threadGrants.delete(threadId);
      // In a git project the thread gets a branch of its own, like a thread started there:
      // its messages from before can then go back to the files as they were at the move.
      // Elsewhere it works in the project's folder, with no step back, as threads there do.
      const project = this.store.getProject(projectId)!;
      const own = this.withGit(project).git
        ? this.ownWorkspace(this.requireThread(threadId).title, threadId)
        : undefined;
      this.updateThread(threadId, {
        workspace: own,
        usage: undefined,
        canCompact: undefined,
        commands: undefined,
        status: "idle",
        error: null,
      });
      let tree: string | undefined;
      if (own) {
        try {
          await this.prepareWorkspace(threadId, project);
          const made = this.store.getThread(threadId)?.workspace;
          if (made) tree = await saveCheckpoint(made.path, movedRef(threadId));
        } catch {
          // Its folder is made at its next message instead; what came before has no way back.
        }
      }
      this.flushText(threadId);
      this.store.transaction(() => {
        for (const item of this.store.listItems(threadId)) {
          if (item.kind !== "user") continue;
          // The checkpoints of before were trees of the other folder's repository.
          const { checkpoint: _other, beforeMove: _was, ...rest } = item;
          this.store.putItem(
            threadId,
            tree ? { ...rest, checkpoint: tree, beforeMove: true } : rest,
          );
        }
        // With the rest: a stop in between leaves both or neither, and screens get one timeline.
        this.store.putItem(threadId, {
          id: `moved:${randomUUID()}`,
          kind: "moved",
          projectId,
          name: plainLabel(project.name),
          at: Date.now(),
        });
      });
      this.timelineCut(threadId);
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
  private async releaseFolder(
    threadId: string,
    threads: ThreadPlace[] = this.store.listThreadPlaces(),
  ): Promise<void> {
    const borrowers = threads.filter((t) => t.worksIn === threadId);
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
      const item = this.itemOf(pending.threadId, itemId);
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
      const item = threadId ? this.itemOf(threadId, itemId) : undefined;
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
    const item = this.itemOf(threadId, itemId);
    if (!pending || pending.threadId !== threadId || item?.kind !== "permission") {
      throw new Error("Cette demande n'attend plus de réponse.");
    }
    if (!item.options.some((o) => o.optionId === optionId)) throw new Error("Choix inconnu.");
    this.pendingPermissions.delete(itemId);
    if (optionId === THREAD_GRANT_OPTION && pending.grant) {
      const grants = this.threadGrants.get(threadId) ?? new Set<string>();
      grants.add(pending.grant.key);
      this.threadGrants.set(threadId, grants);
    }
    if (followUp?.trim() && this.turns.has(threadId)) this.followUps.set(threadId, followUp.trim());
    // The answer is given: the agent gets it even when the database refuses to write it,
    // which is then kept to be written later. A turn never waits on a lost answer.
    this.putItem(threadId, { ...item, outcome: optionId }, true);
    this.broadcastRequests();
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.wrote(() => this.updateThread(threadId, { status: "running" }));
    }
    const answer =
      optionId === THREAD_GRANT_OPTION && pending.grant ? pending.grant.optionId : optionId;
    pending.resolve({ outcome: { outcome: "selected", optionId: answer } });
  }

  /** Answers a question the agent holds its turn on; the turn goes on with it. */
  respondToQuestion(threadId: string, itemId: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingPermissions.get(itemId);
    const asked = this.pendingForms.get(itemId);
    const item = this.itemOf(threadId, itemId);
    if (!pending || !asked || pending.threadId !== threadId || item?.kind !== "tool") {
      throw new Error("Cette question n'attend plus de réponse.");
    }
    const content = formContent(asked.form, answers);
    if (asked.form.fields.some((f) => !(f.key in content) && !(f.custom && f.custom in content))) {
      throw new Error("Réponds à chaque question.");
    }
    this.pendingPermissions.delete(itemId);
    this.pendingForms.delete(itemId);
    // As for a permission: the answer goes to the agent whatever the database does with it.
    this.putItem(
      threadId,
      {
        ...item,
        form: "answered",
        status: "completed",
        answers: asked.form.fields.map((f) =>
          [content[f.key] ?? [], f.custom ? (content[f.custom] ?? []) : []].flat().join(", "),
        ),
      },
      true,
    );
    this.broadcastRequests();
    if (![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)) {
      this.wrote(() => this.updateThread(threadId, { status: "running" }));
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

  reorderFavorites(order: FavoriteRef[]): void {
    this.catalog.reorderFavorites(order);
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
    this.hermes.close();
    clearInterval(this.sweepTimer);
    clearInterval(this.quotaTimer);
    clearInterval(this.storageTimer);
    this.app.close();
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
    // Hermes's setup half done would leave its gateway stopped: its end is waited for.
    await upTo(this.hermes.settled());
    await upTo(this.recovered);
    await upTo(this.catalog.close());
    // Those just started too, which find no agent to start.
    await upTo(Promise.all(this.turns.values()));
    await upTo(Promise.all([...this.steps].map((step) => step.catch(() => undefined))));
    // A turn that ended meanwhile armed no timer (closed), but leaves nothing behind either.
    this.pool.clear();
    // What the database refused is tried a last time: its cause may be gone by now.
    this.storageDown = undefined;
    try {
      this.writeWaiting();
    } catch (error) {
      this.storageFailed(error);
      console.error("Base de données : ce qui attendait n'a pas pu être écrit.", error);
    }
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
    let session: AgentSession | undefined;
    try {
      // Behind those already in line, so none is overtaken.
      if (
        queued &&
        (this.line.size > 0 ||
          this.turnsAtWork() >= this.maxTurns() ||
          this.paused(thread.projectId))
      ) {
        this.updateThread(thread.id, { inLine: true });
        const letThrough = this.line.wait(thread.id);
        // Those on hold ahead of it do not keep it waiting while places are free.
        this.admit();
        await letThrough;
        if (this.store.getThread(thread.id)) this.updateThread(thread.id, { inLine: null });
        if (this.cancelled.has(thread.id)) {
          this.settleTurn(thread.id, { status: "idle" });
          return;
        }
      }
      // A pooled session whose connection already closed is replaced, not continued.
      const continuing = this.pool.has(thread.id) && !this.pool.isDead(thread.id);
      session = await this.session(thread);
      await this.checkpoint(thread.id, itemId);
      if (this.cancelled.has(thread.id)) {
        this.settleTurn(thread.id, { status: "idle" });
        return;
      }
      // A new session knows nothing of the project's shared memory or earlier thread messages:
      // send the shared memory (when non-empty) and the prior conversation (after a hand-off,
      // a step back, or when the agent could not resume its earlier session) once on turn 1.
      // A conversation outside any project has no project to share a memory or threads with.
      const shares = !this.isDiscussions(thread.projectId);
      const memory =
        !continuing && session.fresh && shares
          ? projectMemoryContext(this.store.getProjectMemory(thread.projectId).text)
          : undefined;
      const history =
        !continuing && session.fresh
          ? historyBefore(
              this.items(thread.id),
              itemId,
              this.catalog.name,
              (id) => this.attachments.find(thread.id, id)?.file,
              this.coordinatorUrl && shares && !thread.parentId && thread.kind !== "coordinator"
                ? { threadId: thread.id }
                : undefined,
            )
          : undefined;
      const preamble = [memory, history].filter(Boolean).join("\n\n") || undefined;
      const said = text.trim() || !images.length ? text : IMAGES_ONLY;
      const prompt = context ? `${context}\n\n${said}` : said;
      const stopReason = await session.prompt(prompt, preamble, [
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
      this.settleTurn(thread.id, error ? { status: "error", error } : { status: "idle" });
    } catch (error) {
      this.settlePermissions(thread.id);
      // A write the database refused is no failure of the agent: the screens are told why.
      const refused = storageTrouble(error);
      if (refused) this.storageFailed(error);
      else if (needsSignIn(error)) {
        this.wrote(() => this.catalog.recordCheck(thread.agentId, { ok: false, error }));
      }
      // Stopping an agent that was still starting is what the user asked for, not a failure.
      if (this.cancelled.has(thread.id)) {
        this.settleTurn(thread.id, { status: "idle", error: null });
        return;
      }
      // An agent that crashed already left its own reason, which beats "connection closed".
      const said = refused ? `${refused} : ce tour n'a pas pu aller au bout.` : describe(error);
      // An agent whose connection closed is of no more use, even if its process lingers:
      // it goes, so a change of model and the next message start a new one. The connection
      // itself tells: its error does not always say « connection closed » (a message past
      // the protocol's size limit says something else).
      const closed = CONNECTION_CLOSED.test(said) || !!session?.closed;
      if (closed) await this.pool.stop(thread.id).catch(() => undefined);
      if (this.store.getThread(thread.id)?.status !== "error") {
        // Its process went away mid-turn: said plainly, with the technical detail under it.
        this.settleTurn(thread.id, {
          status: "error",
          error: closed ? stoppedError(said) : said,
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
    // An agent whose connection closed while it waited (a line too long, a broken stream)
    // is let go, and the new one starts once its process is gone.
    this.pool.dropDead(thread.id);
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
      // Only what lets a later start continue the session: a refused write just loses that.
      (s) => {
        try {
          this.wrote(() => this.store.setSessionId(thread.id, s.sessionId));
        } catch (error) {
          console.error("Session de l'agent non retenue :", error);
        }
      },
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
    // A folder two threads were given stays the first one's.
    const [first] = this.sharingFolder(threadId, workspace.path);
    const self = this.store.getThread(threadId);
    if (
      first &&
      self &&
      (first.createdAt - self.createdAt || first.id.localeCompare(self.id)) < 0
    ) {
      throw new Error(
        `Le dossier de ce fil est celui du fil « ${first.title} », créé avant lui : ce fil ne peut pas y travailler sans toucher au sien. Reprends la tâche dans un nouveau fil.`,
      );
    }
    // Made, or made again when its folder went missing, from the branch and its commits.
    try {
      await ensureWorktree(project.path, workspace.path, workspace.branch, workspace.base!);
    } catch (error) {
      // What a removal cut short left of the folder (a file held open on Windows) is no
      // worktree any more. All its files were saved for that removal and come back below:
      // it is finished, and the folder made again. Any other folder stays as it is.
      const cutShort =
        workspace.archivedTree &&
        existsSync(workspace.path) &&
        this.ownFolder(threadId, workspace.path);
      if (!cutShort) throw error;
      await removeWorktree(project.path, workspace.path);
      await ensureWorktree(project.path, workspace.path, workspace.branch, workspace.base!);
    }
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
    const quota = this.quotaRules(project.id);
    const keep = this.store.getSetting<string[]>(KEEP_MERGED_BRANCHES, []).includes(project.id);
    const archived = this.store.getSetting<string[]>(ARCHIVED_PROJECTS, []).includes(project.id);
    const paused = this.paused(project.id);
    return git || pinned || locked || look || quota || keep || archived || paused
      ? {
          ...project,
          ...(git ? { git } : {}),
          ...(pinned ? { pinned } : {}),
          ...(locked ? { locked } : {}),
          ...(look?.icon ? { icon: look.icon } : {}),
          ...(look?.color ? { color: look.color } : {}),
          ...(quota ? { quota } : {}),
          ...(keep ? { deleteMerged: false as const } : {}),
          ...(archived ? { archived } : {}),
          ...(paused ? { paused } : {}),
        }
      : project;
  }

  /** Whether the project is on hold; see {@link Project.paused}. */
  private paused(projectId: string): boolean {
    return this.store.getSetting<string[]>(PAUSED_PROJECTS, []).includes(projectId);
  }

  /**
   * Puts the project on hold: its turns at work stop, and what its agents would start on their
   * own waits in line. Going on lets what waits through, as places free up.
   */
  private async setPaused(project: Project, paused: boolean): Promise<void> {
    const others = this.store
      .getSetting<string[]>(PAUSED_PROJECTS, [])
      .filter((p) => p !== project.id && this.store.getProject(p));
    this.store.setSetting(PAUSED_PROJECTS, paused ? [...others, project.id] : others);
    this.broadcast({ type: "project", project: this.withGit(project) });
    if (!paused) {
      this.admit();
      return;
    }
    const atWork = this.store
      .listThreads()
      .filter((t) => t.projectId === project.id && this.turns.has(t.id) && !this.line.has(t.id));
    await Promise.all(atWork.map((t) => this.cancel(t.id)));
  }

  /**
   * Stops the project's coordinator: its turn, then its agent. Its session is kept, so the next
   * message starts a new agent that resumes the conversation.
   */
  private async restartCoordinator(projectId: string): Promise<void> {
    if (this.locks.isLocked(projectId)) {
      throw new Error("Ce projet est verrouillé : saisis le code pour l'ouvrir.");
    }
    const coordinator = this.store
      .listThreads()
      .find((t) => t.projectId === projectId && t.kind === "coordinator");
    if (!coordinator) throw new Error("Ce projet n'a pas encore de coordinateur.");
    const turn = this.turns.get(coordinator.id);
    if (turn) {
      await this.cancel(coordinator.id);
      // Its turn ends as stopped; one frozen past this is stopped with its agent below.
      await Promise.race([
        turn.catch(() => undefined),
        new Promise((done) => setTimeout(done, RESTART_WAIT_MS).unref()),
      ]);
    }
    await this.pool.stop(coordinator.id);
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
    const userMcp = coordinatorMcp.length
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
        // The agent's connection keeps to itself an error thrown here: a refused write must
        // still be said, and what it would have written kept.
        onUpdate: (update) => void this.wrote(() => this.applyUpdate(thread.id, update)),
        // Told from a timer, where nothing catches a write the database refuses.
        onQuiet: (since) => {
          if (this.closed || !this.store.getThread(thread.id)) return;
          this.wrote(() => this.updateThread(thread.id, { quietSince: since ?? null }));
        },
        requestPermission: (request, signal) => this.requestPermission(thread.id, request, signal),
        elicit: (request, signal) => this.requestForm(thread.id, request, signal),
        onExit: (reason) => {
          if (!owns()) return;
          this.coordinators.dropCoordinatorAccess(thread.id);
          this.pool.exited(thread.id);
          this.settlePermissions(thread.id);
          if (reason && !this.closed && !this.cancelled.has(thread.id)) {
            const summary = this.locks.isLocked(thread.projectId)
              ? ""
              : // Masked before it is cut: half a secret is no longer known for one.
                redact(reason.split(/\r?\n/)[0]?.trim() ?? "").slice(0, 180);
            this.diagnostics?.recordSlow(
              "agent-exit",
              `${thread.agentId} arrêté : ${summary || "sortie imprévue"}`,
            );
          }
          if (reason && this.turns.has(thread.id) && !this.cancelled.has(thread.id)) {
            // Told as the process exits, where nothing catches either: the turn's own end
            // says it again if this write is refused.
            this.wrote(() =>
              this.updateThread(thread.id, { status: "error", error: stoppedError(reason) }),
            );
          }
        },
        // Told from the agent's connection, which keeps an error to itself.
        onConfig: ({ model, settings }) => {
          if (!ready) return;
          this.wrote(() => {
            this.catalog.learn(thread.agentId, model, settings, false);
            const current = this.store.getThread(thread.id);
            if (model && model.current !== current?.model) {
              this.updateThread(thread.id, { model: model.current });
            }
            const values = settingValues(settings);
            if (values && JSON.stringify(values) !== JSON.stringify(current?.settings)) {
              this.updateThread(thread.id, { settings: values });
            }
          });
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
    try {
      // Inside: an agent started and then left running unseen, on any failure from here.
      this.wrote(() =>
        this.catalog.recordCheck(thread.agentId, { ok: true, version: session.agentVersion }),
      );
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
        // Figures the next update brings again: one the database refuses is let go.
        this.wrote(() => this.updateThread(threadId, { usage }));
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
          this.wrote(() => this.updateThread(threadId, { canCompact, commands }));
        }
        this.wrote(() => this.catalog.rememberCommands(thread.agentId, commands));
        return;
      }
      case "plan": {
        const id = `plan:${this.turnIds.get(threadId) ?? "late"}`;
        const before = this.itemOf(threadId, id);
        const now = Date.now();
        this.putItem(
          threadId,
          {
            id,
            kind: "plan",
            entries: mergePlan(
              before?.kind === "plan" ? before.entries : undefined,
              update.entries.map((e) => ({ content: e.content, status: e.status })),
              now,
            ),
            at: before?.at ?? now,
          },
          true,
        );
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
      // What the agent said last, written or still waiting to be: text that waits goes on
      // where it is, not from what the database holds of it.
      const last = this.lastItemOf(threadId);
      if (last?.kind !== kind) {
        const item: TextItem = { id: `${kind}:${randomUUID()}`, kind, text, at: Date.now() };
        this.putItem(threadId, item, true);
        const held = this.unsaved.get(item.id);
        // Refused: the text is the stream's own from here, written with its next words.
        if (held) this.unsaved.delete(item.id);
        this.drafts.set(threadId, { item, dirty: !!held });
        return;
      }
      const held = this.unsaved.get(last.id);
      if (held) this.unsaved.delete(last.id);
      draft = { item: last, dirty: !!held };
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
    if (draft.dirty && this.store.getThread(threadId)) {
      // While the database refuses writes, the text waits in memory: trying it four times a
      // second would wait on another program's hold each time.
      const written =
        !this.storageDown && this.wrote(() => this.store.putItem(threadId, draft.item));
      if (written) draft.dirty = false;
      // Text that ends here has no later write to count on: it is written with what waits.
      else if (end) this.hold(threadId, draft.item);
    } else {
      draft.dirty = false;
    }
    if (end) this.drafts.delete(threadId);
  }

  /**
   * Takes note of a write the database refused for a cause outside the server: a full disk,
   * another program holding the file. Every screen is told, and a write is tried again now
   * and then until one passes. False for any other error, which stays its caller's.
   */
  storageFailed(error: unknown): boolean {
    const reason = storageTrouble(error);
    if (!reason) return false;
    if (this.closed) {
      // Stopping: the writes left fail at once, rather than each wait on the same hold and
      // hold the stop up with them.
      if (!this.storageDown) {
        this.storageDown = reason;
        try {
          this.store.waitOnHold(false);
        } catch {
          // The database is closing too.
        }
      }
      return true;
    }
    if (this.storageDown !== reason) {
      this.storageDown = reason;
      // From here writes fail at once instead of each waiting on the same hold.
      this.store.waitOnHold(false);
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `Base de données : ${reason.toLowerCase()}, plus rien n'est enregistré (${detail}).`,
      );
      this.broadcast({ type: "storage", error: this.storageNotice()! });
    }
    if (!this.storageTimer) {
      this.storageTimer = setInterval(() => this.retryStorage(), this.storageRetryMs);
      this.storageTimer.unref();
    }
    return true;
  }

  /** What the screens say while nothing is saved. */
  private storageNotice(): string | undefined {
    return this.storageDown && `${this.storageDown} : plus rien n'est enregistré`;
  }

  /**
   * Runs a write. False when the database refused it for a cause outside the server, which
   * the screens are then told instead of the error being thrown: for writes made where
   * nothing catches (the end of a turn, a timer, an agent's exit), which stopped the whole
   * server. Any other failure is thrown as before.
   */
  private wrote(write: () => void): boolean {
    try {
      write();
      return true;
    } catch (error) {
      if (this.storageFailed(error)) return false;
      throw error;
    }
  }

  /** Tries a write again; once one passes, writes what waited and tells the screens. */
  private retryStorage(): void {
    if (this.closed || !this.storageDown) return;
    try {
      this.store.tryWrite();
      this.writeWaiting();
      // Text still being streamed waited too: written before the screens are told, so a
      // little room freed on the disk does not make the notice come and go.
      for (const [threadId, draft] of this.drafts) {
        if (!draft.dirty || !this.store.getThread(threadId)) continue;
        this.store.putItem(threadId, draft.item);
        draft.dirty = false;
      }
    } catch (error) {
      if (!this.storageFailed(error)) console.error("Base de données :", error);
      return;
    }
    clearInterval(this.storageTimer);
    this.storageTimer = undefined;
    this.storageDown = undefined;
    this.store.waitOnHold(true);
    console.log("Base de données : les écritures passent de nouveau.");
    this.broadcast({ type: "storage", error: null });
  }

  /** Writes the text and the ends of turns that the database refused; throws if it still does. */
  private writeWaiting(): void {
    for (const [itemId, { threadId, item }] of this.unsaved) {
      if (this.store.getThread(threadId)) {
        const seq = this.store.putItem(threadId, item);
        // Screens get it with its place, and one that comes back later finds it changed.
        const rev = this.log(threadId).touch(item.id);
        this.sendToViewers(threadId, { type: "item", threadId, item: light(item), seq, rev });
      }
      this.unsaved.delete(itemId);
    }
    for (const [threadId, end] of this.unsettled) {
      // A turn started since writes the thread's state itself.
      if (this.store.getThread(threadId) && !this.turns.has(threadId)) {
        this.updateThread(threadId, end);
      }
      this.unsettled.delete(threadId);
    }
  }

  /**
   * Writes how a turn ended. When the database refuses it, the end is kept to be written once
   * writes pass again, and the screens get it now: the thread does not look at work for good.
   */
  private settleTurn(threadId: string, end: TurnEnd): void {
    if (this.wrote(() => this.updateThread(threadId, end))) {
      this.unsettled.delete(threadId);
      return;
    }
    this.unsettled.set(threadId, end);
    const thread = this.store.getThread(threadId);
    if (thread) this.broadcast({ type: "thread", thread: this.asEnded(thread) });
  }

  /** The thread as its last turn left it, when that could not be written yet. */
  private asEnded(thread: Thread): Thread {
    const end = this.unsettled.get(thread.id);
    if (!end) return thread;
    const { error: _was, ...rest } = thread;
    return { ...rest, status: end.status, ...(end.error ? { error: end.error } : {}) };
  }

  private flushAll(): void {
    for (const threadId of this.drafts.keys()) this.flushText(threadId, false);
  }

  /**
   * The thread's last turn, from the user's last message, streamed text included: a long
   * thread is not read whole for it.
   */
  private lastTurn(threadId: string): Item[] {
    this.flushText(threadId, false);
    return this.withHeld(threadId, this.store.lastTurnItems(threadId), true);
  }

  /** The thread's timeline, streamed text included. */
  private items(threadId: string): Item[] {
    // Written down, but kept open: the agent may still be adding to it.
    this.flushText(threadId, false);
    return this.withHeld(threadId, this.store.listItems(threadId), true);
  }

  private log(threadId: string): TimelineLog {
    let log = this.logs.get(threadId);
    if (!log) this.logs.set(threadId, (log = new TimelineLog(this.logsFrom)));
    return log;
  }

  /**
   * Forgets the thread's log of changes: a thread put away, or deleted, keeps none in
   * memory. Its next one starts above every number this one gave.
   */
  private dropLog(threadId: string): void {
    const log = this.logs.get(threadId);
    if (!log) return;
    this.logsFrom = Math.max(this.logsFrom, log.rev + 1);
    this.logs.delete(threadId);
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
      // What waits to be written too: a screen that opens meanwhile sees what others see.
      items: this.withHeld(threadId, page.items, true).map(light),
      first: page.first,
      earlier: page.earlier,
      epoch: this.epoch,
      // Not a log made for it: a thread put away and only read keeps none in memory.
      rev: this.logs.get(threadId)?.rev ?? this.logsFrom,
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
    const heldList = this.heldItems(threadId);
    const held = new Map(heldList.map((item, index) => [item.id, { item, index }]));
    const items = ids
      .map((id) => {
        const found = this.store.getItemAt(threadId, id);
        const waiting = held.get(id);
        if (!waiting) return found && { ...found, order: found.seq };
        return {
          item: waiting.item,
          seq: found?.seq ?? Number.MAX_SAFE_INTEGER,
          // New held items stay in their creation order rather than last-touched order.
          order: found?.seq ?? Number.MAX_SAFE_INTEGER - heldList.length + waiting.index,
        };
      })
      .filter((found) => found !== undefined && found.seq >= since.first)
      .sort((a, b) => a!.order - b!.order)
      .map((found) => ({ item: light(found!.item), seq: found!.seq }));
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
    const existing = this.itemOf(threadId, id) as ToolItem | undefined;
    const content = update.content ? toolContent(update.content) : undefined;
    const questions = toolQuestions(update.rawInput) ?? existing?.questions;
    const images = [
      ...new Set([...(existing?.images ?? []), ...madeImages(update.content, update.rawOutput)]),
    ];
    // The agent's own words for what it does, shown as they read.
    const title = update.title ? plainLabel(update.title) : undefined;
    // A new call joins the step of the agent's plan it is on.
    if (!existing && title) {
      const planId = `plan:${this.turnIds.get(threadId) ?? "late"}`;
      const plan = this.itemOf(threadId, planId);
      const entries = plan?.kind === "plan" ? noteTool(plan.entries, title) : undefined;
      if (plan?.kind === "plan" && entries) this.putItem(threadId, { ...plan, entries }, true);
    }
    this.putItem(
      threadId,
      {
        id,
        kind: "tool",
        title: title || existing?.title || "Outil",
        toolKind: update.kind ?? existing?.toolKind ?? "other",
        status: update.status ?? existing?.status ?? "pending",
        content: content ?? existing?.content ?? [],
        ...(images.length ? { images } : {}),
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
      },
      true,
    );
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
        : thread.role === "reviewer" || thread.role === "reviewer2" || thread.role === "judge"
          ? REVIEWER_ALLOWED
          : undefined;
    const readOnlyDenied = !!allowed && !allowed.has(request.toolCall.kind ?? "");
    // MoonAgentic's own tools are already limited by the server: asking the user before each
    // one would make them useless. The server itself asks before a thread outside full access
    // writes the shared memory (`confirmMemoryWrite`), whether its agent asked first or not:
    // the agent's own request for it is let through here, so the user is asked once.
    this.noteToolName(threadId, request.toolCall);
    // An agent that does not name the tool is taken at its title, for a call of no known kind:
    // never a change of files nor a command.
    const named = this.toolNames.get(threadId)?.get(request.toolCall.toolCallId);
    const ownPattern = thread.kind === "coordinator" ? OWN_TOOL : OWN_THREAD_TOOL;
    const own =
      !!this.coordinatorUrl &&
      (named !== undefined
        ? ownPattern.test(named)
        : ownPattern.test(request.toolCall.title ?? "") &&
          (!request.toolCall.kind || request.toolCall.kind === "other"));
    const allow =
      request.options.find((o) => o.kind === "allow_once") ??
      request.options.find((o) => o.kind === "allow_always");
    // In « Demande d'abord », a call that only reads passes (a review reads thirty files),
    // and so does one like a call the user allowed « pour ce fil ». A coordinator runs no
    // command, even one that reads.
    const keys = grantKeys(request.toolCall, named);
    const reads = readOnlyCall(request.toolCall) && !readOnlyDenied;
    const grants = this.threadGrants.get(threadId);
    const granted = !readOnlyDenied && !!keys?.length && keys.every((k) => grants?.has(k));
    if ((thread.permissionMode === "full" && !readOnlyDenied) || own || reads || granted) {
      if (allow)
        return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    // Only offer « Autoriser pour ce fil » for a single non-read-only action so a chained
    // command (`npm test && rm -rf dist`) cannot silently grant multiple programs at once.
    const grant =
      allow && keys?.length === 1 && !readOnlyDenied
        ? { key: keys[0]!, optionId: allow.optionId }
        : undefined;
    const id = `permission:${randomUUID()}`;
    this.putItem(
      threadId,
      {
        id,
        kind: "permission",
        // What the user decides by reads as it is written: no character in it reorders or hides.
        title: plainLabel(request.toolCall.title ?? "") || "L'agent demande une autorisation",
        options: [
          ...(grant
            ? [
                {
                  optionId: THREAD_GRANT_OPTION,
                  name: "Autoriser pour ce fil",
                  kind: "allow_always" as const,
                },
              ]
            : []),
          ...request.options.map((o) => ({
            optionId: o.optionId,
            name: plainLabel(o.name),
            kind: o.kind,
          })),
        ],
        outcome: null,
        at: Date.now(),
      },
      true,
    );
    // Asked from the agent's connection, which keeps an error to itself: a refused write
    // must not leave the question unasked.
    this.wrote(() => this.updateThread(threadId, { status: "waiting" }));
    // Waiting for the user takes no place: the next turn in line may start.
    this.admit();
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, {
        threadId,
        resolve,
        ...(grant ? { grant } : {}),
      });
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
    const existing = call ? (this.itemOf(threadId, call) as ToolItem | undefined) : undefined;
    const id = existing?.kind === "tool" && call ? call : `tool:ask:${randomUUID()}`;
    this.putItem(
      threadId,
      {
        id,
        kind: "tool",
        title: existing?.title ?? "Question",
        toolKind: existing?.toolKind ?? "other",
        status: "pending",
        content: existing?.content ?? [],
        questions: form.questions,
        form: "open",
        at: existing?.at ?? Date.now(),
      },
      true,
    );
    this.wrote(() => this.updateThread(threadId, { status: "waiting" }));
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
    // The task is the coordinator's own words, and this is the request that opens the most:
    // its start is shown as it is written, signs and code included, and not a summary of it,
    // which would leave out a block of code.
    const said = plainLabel(task);
    const preview = said.length > 80 ? `${labelStart(said, 79).trimEnd()}…` : said;
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

  /**
   * Asks the user before a thread outside full access writes the project's shared memory:
   * every later session of the project starts with what is written there. Same card and
   * « À traiter » queue as an agent's own requests.
   */
  private confirmMemoryWrite(
    threadId: string,
    content: string,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    // The words to be written, on one line, with nothing in them that is not seen.
    const flat = content
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const shown = [...flat];
    const preview = shown.length > 80 ? `${shown.slice(0, 79).join("").trimEnd()}…` : flat;
    const id = `permission:${randomUUID()}`;
    this.putItem(threadId, {
      id,
      kind: "permission",
      title: !preview
        ? "Vider la mémoire du projet"
        : replace
          ? `Remplacer la mémoire du projet par : ${preview}`
          : `Ajouter à la mémoire du projet : ${preview}`,
      options: [
        { optionId: "allow", name: "Autoriser", kind: "allow_once" },
        { optionId: "reject", name: "Refuser", kind: "reject_once" },
      ],
      outcome: null,
      at: Date.now(),
    });
    this.updateThread(threadId, { status: "waiting" });
    this.admit();
    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        this.settlePermission(id);
        if (
          this.store.getThread(threadId)?.status === "waiting" &&
          ![...this.pendingPermissions.values()].some((p) => p.threadId === threadId)
        ) {
          this.updateThread(threadId, { status: this.turns.has(threadId) ? "running" : "idle" });
        }
      };
      const done = (response: acp.RequestPermissionResponse) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response.outcome.outcome === "selected" && response.outcome.optionId === "allow");
      };
      this.pendingPermissions.set(id, { threadId, resolve: done });
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
    const form = this.pendingForms.delete(itemId);
    // The agent gets its answer even when the database refuses to write it down.
    this.wrote(() => {
      const item = this.itemOf(pending.threadId, itemId);
      if (item?.kind === "permission")
        this.putItem(pending.threadId, { ...item, outcome: "cancelled" }, true);
      if (form && item?.kind === "tool")
        this.putItem(pending.threadId, { ...item, form: "cancelled", status: "failed" }, true);
    });
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

  /**
   * Writes an item and shows it. With `hold`, for what an agent sends, an item the database
   * refuses is kept to be written once writes pass again, and shown all the same: the agent
   * goes on, and nothing it said is lost. Without, the refusal is thrown, as for the user's
   * own message, which then changes nothing.
   */
  private putItem(threadId: string, item: Item, hold = false): void {
    // Another item ends the text being streamed, which keeps its place before it.
    if (this.drafts.get(threadId)?.item.id !== item.id) this.flushText(threadId);
    let seq: number;
    if (hold && (this.storageDown || this.heldIn(threadId))) {
      // Written after what waits before it, never ahead of it.
      seq = this.hold(threadId, item);
    } else {
      // Nothing is written ahead of what waits: the timeline keeps its order.
      if (this.heldIn(threadId)) throw new StorageRefused(this.storageDown ?? "Base de données");
      try {
        seq = this.store.putItem(threadId, item);
      } catch (error) {
        if (!hold || !this.storageFailed(error)) throw error;
        seq = this.hold(threadId, item);
      }
    }
    const rev = this.log(threadId).touch(item.id);
    this.sendToViewers(threadId, { type: "item", threadId, item: light(item), seq, rev });
  }

  /** Keeps an item the database refused in place when already held; gives its place in the timeline. */
  private hold(threadId: string, item: Item): number {
    this.unsaved.set(item.id, { threadId, item });
    // Its own place when it was written before, else after everything: it comes last.
    return this.store.getItemAt(threadId, item.id)?.seq ?? Number.MAX_SAFE_INTEGER;
  }

  /** Whether some of the thread's items wait to be written. */
  private heldIn(threadId: string): boolean {
    for (const held of this.unsaved.values()) if (held.threadId === threadId) return true;
    return false;
  }

  /** The thread's items not written yet: those refused, then its text being streamed. */
  private heldItems(threadId: string): Item[] {
    const held = [...this.unsaved.values()].filter((h) => h.threadId === threadId);
    const items = held.map((h) => h.item);
    const draft = this.drafts.get(threadId);
    if (draft?.dirty) {
      const at = items.findIndex((i) => i.id === draft.item.id);
      if (at === -1) items.push(draft.item);
      else items[at] = draft.item;
    }
    return items;
  }

  /** An item of the thread as it stands, written or not yet. */
  private itemOf(threadId: string, itemId: string): Item | undefined {
    const draft = this.drafts.get(threadId);
    if (draft?.item.id === itemId) return draft.item;
    const held = this.unsaved.get(itemId);
    if (held?.threadId === threadId) return held.item;
    return this.store.getItem(threadId, itemId);
  }

  /** The thread's last item as it stands, written or not yet. */
  private lastItemOf(threadId: string): Item | undefined {
    const held = this.heldItems(threadId);
    // An update to an earlier item already in the database does not move it past what followed.
    const added = held.findLast((item) => !this.store.getItemAt(threadId, item.id));
    if (added) return added;
    const last = this.store.lastItem(threadId);
    return last ? (held.find((item) => item.id === last.id) ?? last) : undefined;
  }

  /** `items`, read from the database, with what is not written yet; `atEnd` adds what is new. */
  private withHeld(threadId: string, items: Item[], atEnd: boolean): Item[] {
    const held = this.heldItems(threadId);
    if (!held.length) return items;
    const byId = new Map(held.map((i) => [i.id, i]));
    const merged = items.map((i) => byId.get(i.id) ?? i);
    if (atEnd) {
      const known = new Set(items.map((i) => i.id));
      merged.push(...held.filter((i) => !known.has(i.id)));
    }
    return merged;
  }

  /** Forgets what waits to be written for a thread removed, or whose timeline was cut. */
  private dropHeld(threadId: string): void {
    for (const [id, held] of this.unsaved) if (held.threadId === threadId) this.unsaved.delete(id);
    this.unsettled.delete(threadId);
  }

  private updateThread(threadId: string, patch: Parameters<Store["updateThread"]>[1]): void {
    const saved = this.store.updateThread(threadId, patch);
    // A state written now replaces the end that waited to be written.
    if (patch.status) this.unsettled.delete(threadId);
    // A turn's end that waits to be written still shows over a change of anything else.
    const thread = patch.status ? saved : this.asEnded(saved);
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
    if (message.type === "thread") {
      this.push.threadChanged(message.thread);
      this.hermes.threadChanged(message.thread);
      this.threadClock.threadChanged(message.thread);
    } else if (message.type === "threadRemoved") {
      this.push.threadRemoved(message.threadId);
      this.hermes.threadRemoved(message.threadId);
      this.threadClock.threadRemoved(message.threadId);
    }
    for (const client of this.clients) client.send(message);
  }
}

export { CoordinatorRefused, coordinatorPrompt } from "./coordinator.ts";
export { HermesRefused } from "./hermes.ts";
