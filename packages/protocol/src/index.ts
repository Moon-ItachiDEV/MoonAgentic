import { z } from "zod";

export type { RemoteAccess, RemoteAddress } from "./remote.ts";
export { defaultTeam, pickMember, TEAM_PRESETS, type TeamPreset } from "./team-presets.ts";

// Zod builds faster checks with `new Function` when it can, and tries it as soon as a
// schema is made. The web app's content security policy forbids that, so it is turned off
// before any schema exists; messages here are small enough not to need it.
z.config({ jitless: true });

export type AgentId = string;

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** Two-letter badge shown in the UI, e.g. "CC". */
  short: string;
  available: boolean;
  /** Why the agent cannot run, shown to the user when `available` is false. */
  hint?: string;
  /** Models the agent offered the last time one of its sessions started; absent until then. */
  models?: ModelChoice[];
  /** The model a new thread gets when the user picks none. */
  defaultModel?: string;
  /** Why the agent could not list its models, while it has none on record. */
  modelsError?: string;
  /** Other settings the agent offers, such as its mode (plan, agent…) or reasoning effort. */
  settings?: AgentSetting[];
  /** The `/` commands the agent listed the last time one of its sessions started. */
  commands?: AgentCommand[];
  /** The program that starts it, once found on this machine. */
  command?: string;
  /** How to sign in with the agent's own tool, outside MoonAgentic. */
  login?: string;
  /** Added by the user in Connexions rather than built in. */
  custom?: boolean;
  /** What the last check found: the agent answered and opened a session, or why not. */
  check?: AgentCheck;
}

export interface AgentCheck {
  at: number;
  ok: boolean;
  /** The agent's own name and version, as it gave them when it started. */
  version?: string;
  /** True when the agent said it needs the user to sign in first. */
  signInNeeded?: boolean;
  error?: string;
}

/** An ACP agent the user added: a command that speaks ACP on its standard input and output. */
export interface CustomAgentInput {
  name: string;
  command: string;
  args: string[];
}

/** A permission request waiting for an answer, in any thread. */
export interface PendingRequest {
  threadId: string;
  itemId: string;
  title: string;
  options: PermissionOption[];
  at: number;
}

/** A `/` command the agent offers, sent to it as the start of a message. */
export interface AgentCommand {
  name: string;
  description: string;
  /** What to type after the command, when it takes some input. */
  hint?: string;
}

/** A skill: a method written in a `SKILL.md` that the agent loads when it is called with `$`. */
export interface Skill {
  name: string;
  description: string;
  /** Where it was found: in the project, or in the user's own folder. */
  scope: "project" | "user";
  /** Its `SKILL.md`, relative to the project for a project skill, from the home folder otherwise. */
  path: string;
}

/** A `/` command written for the project, in `.moonagentic/commands/<name>.md`. */
export interface ProjectCommand {
  name: string;
  description: string;
  /** The message it stands for; `$ARGUMENTS` takes what follows the command. */
  template: string;
}

/** A message that matched a quick search. */
export interface SearchHit {
  threadId: string;
  itemId: string;
  kind: "user" | "agent";
  /** The text around the match. */
  snippet: string;
}

/** A setting an agent offers for its sessions, other than the model. */
export interface AgentSetting {
  /** The agent's own id for the setting. */
  id: string;
  kind: "mode" | "effort";
  choices: ModelChoice[];
  /** What the agent picks on its own for a new session. */
  current: string;
}

/** How much of the agent's context window the conversation fills, as the agent reports it. */
export interface ContextUsage {
  used: number;
  size: number;
  /** What the session has cost so far, when the agent says. */
  cost?: { amount: number; currency: string };
}

/**
 * An MCP server handed to every agent session. Secret values (environment variables, HTTP
 * headers) stay on the server; clients only see their names.
 */
export interface McpServerInfo {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  /** stdio: the command line that starts the server. http: its URL. */
  target: string;
  /** Names of the environment variables (stdio) or headers (http) it is given. */
  secretNames: string[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** True when the folder is in a git repository, so threads can get their own branch. */
  git?: boolean;
  /** Kept at the top of the list of projects. */
  pinned?: boolean;
}

/** A thread's own branch, checked out in a separate folder (a git worktree). */
export interface Workspace {
  branch: string;
  path: string;
  /** The commit the branch started from, once the worktree exists. */
  base?: string;
  /** The branch it started from, which a pull request targets. */
  baseBranch?: string;
  /**
   * Where the project sits inside the repository (`apps/web`), when it is not at its root:
   * the agent works in that folder of the worktree.
   */
  subdir?: string;
  /** While the thread is archived: the files it had, uncommitted ones included, as a tree. */
  archivedTree?: string;
  /** The pull request, or the page to open one, after the last push. */
  prUrl?: string;
  prOpened?: boolean;
}

/** One changed file in a thread's workspace, compared with where its branch started. */
export interface ReviewFile {
  path: string;
  /** The path before a rename. */
  from?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Line counts; null for a binary file. */
  added: number | null;
  removed: number | null;
  /** The unified diff hunks, from the first `@@` line. */
  patch: string;
  truncated?: boolean;
}

export type ThreadStatus = "idle" | "running" | "waiting" | "error";

export type PermissionMode = "supervised" | "full";

export type TeamRole = "lead" | "coder" | "reviewer" | "tester" | "merger";

/** What one lane of a team's timeline is doing: the lead's, a piece's, or the merge's. */
export type TeamLanePhase =
  TeamTask["status"] | "planning" | "idle" | "merging" | "solving" | "checking";

/** A change in one lane of the team, when it happened: the timeline is drawn from them. */
export interface TeamEvent {
  at: number;
  /** -1 for the lead, -2 for the merge, else the piece's index. */
  lane: number;
  phase: TeamLanePhase;
}

/** One agent and model of a team, by role. */
export interface TeamMember {
  agentId: AgentId;
  model?: string;
}

/**
 * Where a team is: `merging` while its pieces are merged onto one branch, `blocked` once
 * nothing runs and a piece or the merge waits on the user.
 */
export type TeamPhase =
  "planning" | "coding" | "merging" | "blocked" | "done" | "failed" | "stopped";

/** A piece of the team's work, given by the lead to one coder. */
export interface TeamTask {
  title: string;
  brief: string;
  /**
   * `running` while its coder works, `reviewing` and `testing` while the reviewer and the
   * tester check it, `lead` while the lead rewrites its brief, `blocked` once it is the
   * user's turn.
   */
  status:
    | "waiting"
    | "running"
    | "reviewing"
    | "testing"
    | "lead"
    | "blocked"
    | "done"
    | "failed"
    | "stopped";
  /** The coder's own thread, once it has started. */
  threadId?: string;
  reviewThreadId?: string;
  testThreadId?: string;
  /** Corrections sent back to the coder so far. */
  tries?: number;
  /** True once the lead has rewritten the brief, which it does once. */
  leadHelped?: boolean;
  /** True once the reviewer or tester was asked again for the verdict it left out. */
  reasked?: boolean;
  /** The last remarks of the reviewer or the tester, or why the piece is blocked. */
  note?: string;
  /** True once its branch is merged onto the team's. */
  merged?: boolean;
}

/** What a team, run from its lead's thread, is doing. The server keeps it. */
export interface Team {
  phase: TeamPhase;
  /** The task as the user gave it. */
  task: string;
  coder: TeamMember;
  /** Reads each piece's changes before it counts as done. */
  reviewer?: TeamMember;
  /** Runs the tests, and writes the missing ones, on each piece's branch. */
  tester?: TeamMember;
  /** Settles merge conflicts, then checks the pieces work together. */
  merger?: TeamMember;
  /** The thread whose branch gets every piece, once they are all done. */
  mergeThreadId?: string;
  /**
   * Once done, the team pushes its branch and opens its pull request by itself: `url` is
   * the pull request, or the page to open one when the user's `gh` could not.
   */
  shipped?: { url?: string; opened: boolean; note?: string };
  /** Why the branch could not be pushed or its pull request opened. */
  shipError?: string;
  /** The branch is being pushed and the pull request opened, right now. */
  shipping?: true;
  /** Set to false at the start when the user opens the pull request themselves. */
  autoShip?: boolean;
  /** What the merger is at: the piece whose conflicts it settles, or -1 for the last check. */
  mergeStep?: number;
  /** True once the merger was asked again for the verdict its last check left out. */
  mergeReasked?: boolean;
  /** Every change of each lane, oldest first, as it really happened. */
  timeline?: TeamEvent[];
  /** Coders working at once. */
  coders: number;
  permissionMode: PermissionMode;
  tasks: TeamTask[];
  /** Times the lead was asked again for a plan it could not be read from. */
  planTries?: number;
  /** The piece whose brief the lead is rewriting, one at a time. */
  leadTask?: number;
  error?: string;
}

/** An agent's turn with no sign of progress for this long is said to be quiet. */
export const AGENT_QUIET_MS = 10 * 60_000;
/** An agent's turn with no sign of progress for this long is stopped. */
export const AGENT_SILENCE_STOP_MS = 30 * 60_000;

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  agentId: AgentId;
  status: ThreadStatus;
  permissionMode: PermissionMode;
  /** The model the agent runs, once known. */
  model?: string;
  /** The value of each of the agent's other settings, by setting id. */
  settings?: Record<string, string>;
  /** Hidden when the agent does not report it. */
  usage?: ContextUsage;
  /** True when the agent offers a /compact command to shrink its context. */
  canCompact?: boolean;
  /** The `/` commands this thread's agent offers, as it last listed them. */
  commands?: AgentCommand[];
  /** Kept at the top of the sidebar. */
  pinned?: boolean;
  /**
   * Resolved (« Résolu »): out of the lists of work under way, its worktree removed until
   * it is reopened. Its files, uncommitted ones included, are kept in git meanwhile.
   */
  archived?: boolean;
  /** Its pull request as GitHub last described it, once one is known. */
  pr?: ThreadPullRequest;
  /** The start of what its agent last said, for lists of threads. */
  summary?: string;
  /** Set when the thread works on its own branch rather than in the project folder. */
  workspace?: Workspace;
  /**
   * A project's coordinator: the one conversation the user talks to about the whole
   * project. It answers, or opens a thread for the work. Kept out of lists of threads.
   */
  kind?: "coordinator";
  /**
   * Its agent answered while no window had it open, or the user marked it so: shown until
   * it is opened.
   */
  unread?: boolean;
  /**
   * While its agent works: since when (ms) it has given no sign of progress, once that has
   * lasted long enough to say so. Past a longer silence the turn is stopped.
   */
  quietSince?: number;
  /**
   * Its turn waits for a place: the server already runs as many turns as it may. It starts
   * by itself once one ends.
   */
  inLine?: true;
  /** The coordinator's thread, for a thread it opened. */
  openedBy?: string;
  /** The coordinator's own name for the subject: asked again, it gets this thread back. */
  taskKey?: string;
  /**
   * The brief it gets once a place is free: its coordinator already has as many threads
   * at work as it may run at once, so this one waits in line.
   */
  held?: string;
  /** The team lead's thread, for a coder's thread. */
  parentId?: string;
  /** The thread's part in a team. */
  role?: TeamRole;
  /** Works in that thread's folder rather than its own: a team's reviewer or tester. */
  worksIn?: string;
  /** The team this thread leads. */
  team?: Team;
  /** Set when the last turn ended with an error. */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** What lists of threads need of a thread's pull request. */
export interface ThreadPullRequest {
  url: string;
  number: number;
  state: PullRequestInfo["state"];
  /** Its checks as one: `failed` if one failed, else `pending` if one still runs. */
  checks: "none" | "pending" | "passed" | "failed";
  conflicts?: true;
  /** The repository's rules hold the merge back. */
  blocked?: true;
}

/** What a list of threads keeps of a pull request. */
export function threadPullRequest(pr: PullRequestInfo): ThreadPullRequest {
  const counted = pr.checks.filter((c) => c.state !== "skipped");
  return {
    url: pr.url,
    number: pr.number,
    state: pr.state,
    checks: counted.some((c) => c.state === "failed")
      ? "failed"
      : counted.some((c) => c.state === "pending")
        ? "pending"
        : counted.length
          ? "passed"
          : "none",
    ...(pr.conflicts ? { conflicts: true as const } : {}),
    ...(pr.blocked ? { blocked: true as const } : {}),
  };
}

/** Where a thread stands for its user, in the order a project lists them. */
export const THREAD_GROUPS = ["waiting", "running", "idle", "resolved"] as const;
export type ThreadGroup = (typeof THREAD_GROUPS)[number];

/** Phases of a team in which one of its agents works, or is about to. */
const TEAM_AT_WORK: readonly TeamPhase[] = ["planning", "coding", "merging"];

/**
 * The group of a thread, worked out from what is really going on: its agent, the team it
 * leads, its pull request. `waiting` means the next step is the user's: an answer, an
 * error to look at, a pull request to merge or whose checks failed. `members` are the
 * threads of the team it leads: the lead's own pull request is its team's, kept on it by
 * the server.
 */
export function threadGroup(thread: Thread, members: readonly Thread[] = []): ThreadGroup {
  if (thread.archived) return "resolved";
  // A team's member that asks the user something makes the whole team wait on them.
  if (
    thread.status === "waiting" ||
    thread.team?.phase === "blocked" ||
    members.some((m) => m.status === "waiting" && !m.archived)
  )
    return "waiting";
  // One waiting in line behind its coordinator starts by itself: it stays in sight with the
  // threads at work, not folded away with the idle ones.
  if (
    thread.status === "running" ||
    !!thread.held ||
    (thread.team && TEAM_AT_WORK.includes(thread.team.phase))
  )
    return "running";
  if (thread.status === "error" || thread.team?.phase === "failed") return "waiting";
  const pr = thread.pr;
  if (pr?.state === "open" && (pr.checks === "failed" || pr.conflicts || prReady(pr)))
    return "waiting";
  return "idle";
}

/** An open pull request nothing holds back: only the user's merge is missing. */
export const prReady = (pr: ThreadPullRequest): boolean =>
  pr.state === "open" &&
  !pr.conflicts &&
  !pr.blocked &&
  pr.checks !== "pending" &&
  pr.checks !== "failed";

/** The planner's columns, in order. */
export const PLAN_STATUSES = ["todo", "doing", "report", "test", "live"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A card of a project's planner: written by the user, or laid down by a team's lead. */
export interface PlanTask {
  id: string;
  projectId: string;
  /** Its number in the project, shown as `#12`; never used twice. */
  number: number;
  title: string;
  description?: string;
  /** The user sets it, unless a team does the task: then it follows the team's piece. */
  status: PlanStatus;
  /** `lead` when a team's lead planned it, `user` when written by hand. */
  source: "user" | "lead";
  /** The thread that works on it, when the user linked one. */
  threadId?: string;
  /** The piece of a team it stands for: its status then follows that piece. */
  team?: { leadId: string; index: number };
  /** The day its work is meant to start, as a timestamp. */
  start?: number;
  /** The day it is due, as a timestamp. */
  due?: number;
  /** When its work really began: when it first left « À faire ». The server sets it. */
  startedAt?: number;
  /** When it was delivered. The server sets it, and clears it if the card comes back. */
  doneAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** When the server saw the agent start this step, and finish it. */
  startedAt?: number;
  endedAt?: number;
  /** What the agent used while on this step: a file, a command, a tool, at most three. */
  tools?: string[];
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

/** A question an agent asks with a tool of its own; the answer is the user's next message. */
export interface ToolQuestion {
  question: string;
  options: string[];
  /** Several options may be picked. */
  multi?: boolean;
  /** What each option means, in the order of `options`; "" for one that says nothing more. */
  descriptions?: string[];
  /** What each option would look like (code, a sketch in text), in the order of `options`. */
  previews?: string[];
}

/** The answer to one question: the options picked, and the user's own words if any. */
export interface QuestionAnswer {
  picks: string[];
  text?: string;
}

/** A question an agent stopped its turn on, waiting for an answer, in any thread. */
export interface PendingQuestion {
  threadId: string;
  itemId: string;
  questions: ToolQuestion[];
  at: number;
}

/** The kinds of image a message can carry. SVG is left out: it can carry scripts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** The largest image the server keeps. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;

/** An image sent with a message, kept by the server with the message's thread. */
export interface ImageRef {
  id: string;
  /** The file's name, as it was sent or made up from its kind. */
  name: string;
  mime: ImageType;
  /** In bytes. */
  size: number;
}

export type Item =
  | {
      id: string;
      kind: "user";
      /** Empty when the message is only images. */
      text: string;
      /** The images sent with the message: read at `/api/attachments/<thread>/<id>`. */
      images?: ImageRef[];
      /** Written by the team's engine, not by the user: a member's brief, a fix, a check. */
      byTeam?: true;
      /** Written by the project's coordinator, an agent, not typed by the user. */
      from?: "coordinator";
      /** The thread's files just before this message, for threads with their own branch. */
      checkpoint?: string;
      at: number;
    }
  | { id: string; kind: "agent"; text: string; at: number }
  | { id: string; kind: "thought"; text: string; at: number }
  | {
      id: string;
      kind: "tool";
      title: string;
      toolKind: string;
      status: ToolStatus;
      content: ToolContent[];
      /**
       * How many characters of `content` are left out of this copy: a large result does not
       * travel with the timeline, it is asked for with `item.get` when its line is opened.
       */
      omitted?: number;
      /** What the tool asks the user, when it is a question. */
      questions?: ToolQuestion[];
      /**
       * Set when the agent holds its turn until the question is answered (`question.respond`),
       * rather than ending the turn and reading the next message.
       */
      form?: "open" | "answered" | "cancelled";
      /** What the user answered to each question, once `form` is "answered". */
      answers?: string[];
      at: number;
    }
  | {
      id: string;
      kind: "permission";
      title: string;
      options: PermissionOption[];
      /** The option the user picked, or "cancelled" when the turn ended first. */
      outcome: string | null;
      at: number;
    }
  | { id: string; kind: "plan"; entries: PlanEntry[]; at: number }
  /** The coordinator opened a thread for a piece of work: a link to it, where it did. */
  | { id: string; kind: "opened"; threadId: string; title: string; at: number }
  /**
   * A thread the coordinator opened has finished what it was asked: its own last words and
   * the files it changed, told where the user asked for the work.
   */
  | {
      id: string;
      kind: "result";
      threadId: string;
      title: string;
      /** The start of the thread's last answer. */
      summary: string;
      /** The files changed on its branch, the first of them. */
      files: string[];
      /** How many more it changed. */
      moreFiles?: number;
      /** True when what ended is a failure, such as a team that could not finish. */
      failed?: boolean;
      at: number;
    }
  /** The thread went from one agent to another; agent items before it are `from`'s. */
  | { id: string; kind: "handoff"; from: AgentId; to: AgentId; at: number };

export type ItemKind = Item["kind"];

/** Favorite model ids per agent, shared by every device. */
export type Favorites = Record<AgentId, string[]>;

export const SCHEDULE_REPEATS = ["once", "hourly", "daily", "weekdays", "weekly"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

/**
 * A task MoonAgentic starts by itself, once or again and again: at its time, a new thread
 * of its project gets the task's text, with the agent chosen when it was planned.
 */
export interface Schedule {
  id: string;
  projectId: string;
  title: string;
  /** The message the thread starts with. */
  text: string;
  agentId: string;
  model?: string;
  permissionMode: PermissionMode;
  /** Each run gets its own branch, when the project is a git repository. */
  isolated?: boolean;
  repeat: ScheduleRepeat;
  /** When it next starts. For one that is off or has run its only time, when it last was due. */
  nextAt: number;
  /** Off: paused by the user, or a one-time task that has run. */
  enabled: boolean;
  /** How many times it really started a thread. */
  runs: number;
  lastAt?: number;
  /** The thread of its last run, while that thread exists. */
  lastThreadId?: string;
  /** Why its last time did not start, in words for the user. */
  lastError?: string;
  createdAt: number;
}

export type { PullRequestCheck, PullRequestInfo } from "./pull-request.ts";
import type { PullRequestInfo } from "./pull-request.ts";

/**
 * What MoonAgentic knows of GitHub on the machine running it: the account signed in from
 * MoonAgentic itself (its token stays on that machine, sealed by the system), or else what the
 * user's own `git` and `gh` know.
 */
export interface GithubStatus {
  /** `git` is installed. */
  git: boolean;
  /** GitHub CLI (`gh`) is installed. */
  gh: boolean;
  /** The signed-in account, when there is one. */
  login?: string;
  /**
   * Who signed in: MoonAgentic's own « Se connecter à GitHub », or the user's `gh`. MoonAgentic's
   * own sign-in wins when both are there.
   */
  account?: "moonagentic" | "gh";
  /** True when « Se connecter à GitHub » can be offered here. */
  canSignIn: boolean;
  /** Where MoonAgentic's own sign-in is kept, so the user is told the truth about it. */
  vault?: GithubVault;
  /**
   * How git proves who it is to github.com when it pushes: MoonAgentic's sign-in, `gh` lent for
   * each clone and push (after git's own helpers), or only its own credential helper, or nothing.
   */
  gitAuth: "token" | "helper" | "gh" | "none";
  /** Why the account could not be read, in GitHub's or `gh`'s own words. */
  error?: string;
}

/**
 * Where MoonAgentic keeps its GitHub sign-in: sealed with the Windows account (DPAPI), in the
 * macOS keychain or the Linux secret service, or, with none of them, a file only the user reads.
 */
export type GithubVault = "windows" | "macos" | "linux" | "file";

/** A repository the user can reach on GitHub. */
export interface GithubRepo {
  /** `owner/name`. */
  fullName: string;
  description?: string;
  private: boolean;
  /** Its last push, as a timestamp. */
  pushedAt?: number;
}

/** A git folder found on the machine running MoonAgentic, so nothing is cloned twice. */
export interface LocalClone {
  path: string;
  /** Its folder's name. */
  name: string;
  /** The GitHub repository its `origin` points to, as `owner/name`. */
  repo?: string;
  /** The project already using this folder. */
  projectId?: string;
}

/** A sign-in started from MoonAgentic: the code to type on GitHub, and where. */
export interface GithubDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/** The kinds of work a coordinator opens a thread for. */
export const WORK_KINDS = ["question", "bug", "fonctionnalite", "relecture", "tests"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
/** What a route is set for: a kind of work, or all those with no route of their own. */
export const ROUTE_KINDS = ["default", ...WORK_KINDS] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Threads a coordinator runs at once unless the settings say otherwise, and at most. */
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 6;
/**
 * Turns the whole server runs at once unless the settings say otherwise, and at most. Past
 * it, what a coordinator, a team or a planned task starts waits in line; what the user sends
 * themselves always goes.
 */
export const DEFAULT_MAX_TURNS = 4;
export const MAX_MAX_TURNS = 12;

/** A team as the user last set one up: what a coordinator starts when asked for a team. */
export interface TeamSetup {
  lead: TeamMember;
  coder: TeamMember;
  reviewer?: TeamMember;
  tester?: TeamMember;
  merger?: TeamMember;
  coders: number;
  permissionMode: PermissionMode;
  autoShip?: boolean;
}

/** How coordinators route work: an agent and model for each kind, and the team to start. */
export interface CoordinatorSettings {
  /** A kind left out goes to the coordinator's own agent. */
  /** Per kind of work; `default` for every kind left unset, before the coordinator's own. */
  routes: Partial<Record<RouteKind, TeamMember>>;
  /** Kept from the last team the user started by hand. */
  team?: TeamSetup;
  /** Threads a coordinator runs at once, the others waiting in line; 3 when left out. */
  parallel?: number;
  /** Turns the whole server runs at once, coordinators or not; 4 when left out. */
  maxTurns?: number;
}

/** One window of an agent's subscription, as the agent's own service reports it. */
export interface QuotaWindow {
  /** What it covers, in words: « Session de 5 h », « Semaine, Opus ». */
  label: string;
  /** The same, short, for tight places: « 5 h », « semaine ». */
  short: string;
  /** Share used, from 0 to 100; past 100 when the agent lets the user go over. */
  usedPercent: number;
  /** When it frees up again, as a timestamp, when the agent says. */
  resetsAt?: number;
}

/**
 * What an agent's subscription has left, read from the agent's own service: never estimated.
 * `loading`: first read in progress; `unreadable`: the agent gives no figures to another app,
 * or asking failed (`note` says why); `none`: the agent pays as it goes, so there is no quota
 * to follow. When `state` is `ok`, `note` may still explain that a newer refresh failed
 * temporarily and the previous figures were kept.
 */
export interface AgentQuota {
  agentId: AgentId;
  state: "ok" | "unreadable" | "none" | "loading";
  /** The plan, as the agent names it: « Abonnement Max », « ChatGPT Plus ». */
  plan?: string;
  windows: QuotaWindow[];
  /** Other lines worth showing, such as credits. */
  extras: { label: string; value: string }[];
  note?: string;
  /** Where the agent shows its figures itself, when they cannot be read here. */
  link?: string;
  /** True when the agent has no live reader (so re-reading cannot change this card). */
  fixed?: boolean;
  /** When figures were last read, as a timestamp. */
  readAt?: number;
}

export interface Snapshot {
  coordinator: CoordinatorSettings;
  favorites: Favorites;
  requests: PendingRequest[];
  /** Questions agents hold their turn on, in every thread. */
  questions: PendingQuestion[];
  mcpServers: McpServerInfo[];
  /** Set when MCP secrets could not be decrypted/read from disk (e.g. DPAPI vault moved machines). */
  mcpSecretsError?: string;
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
  plan: PlanTask[];
  schedules: Schedule[];
  quotas: AgentQuota[];
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "favorites"; favorites: Favorites }
  | { type: "coordinatorSettings"; settings: CoordinatorSettings }
  /** Every permission request still waiting, after one is added or answered. */
  | { type: "requests"; requests: PendingRequest[] }
  /** Every question an agent holds its turn on, after one is asked or answered. */
  | { type: "questions"; questions: PendingQuestion[] }
  | { type: "mcpServers"; servers: McpServerInfo[]; error?: string }
  | { type: "project"; project: Project }
  | { type: "thread"; thread: Thread }
  /** The thread was deleted, its timeline with it. */
  | { type: "threadRemoved"; threadId: string }
  /** A planner card, new or changed. */
  | { type: "planTask"; task: PlanTask }
  | { type: "planTaskRemoved"; id: string }
  | { type: "schedule"; schedule: Schedule }
  | { type: "scheduleRemoved"; id: string }
  /** The project was removed from MoonAgentic, with its threads; its folder stays. */
  | { type: "projectRemoved"; projectId: string }
  | { type: "items"; threadId: string; items: Item[] }
  | { type: "item"; threadId: string; item: Item }
  /** Streaming text appended to an existing agent or thought item. */
  | { type: "append"; threadId: string; itemId: string; text: string }
  | {
      type: "review";
      threadId: string;
      files: ReviewFile[];
      error?: string;
      /** Files left out of the list because there are too many to show. */
      omitted?: number;
    }
  /** Project files matching what follows an `@`, best first. */
  | { type: "files"; requestId: string; files: string[] }
  /** What `$` and `/` can offer in a thread's folder, beyond the agent's own commands. */
  | { type: "catalog"; requestId: string; skills: Skill[]; commands: ProjectCommand[] }
  | { type: "searched"; requestId: string; hits: SearchHit[] }
  /** An item whole, with what its copy in the timeline left out. */
  | { type: "fullItem"; requestId: string; threadId: string; item: Item }
  | {
      type: "shipped";
      requestId: string;
      threadId: string;
      commit?: string;
      url?: string;
      prOpened: boolean;
    }
  /** What each agent's subscription has left, after it was read again. */
  | { type: "quotas"; quotas: AgentQuota[] }
  | { type: "github"; requestId: string; status: GithubStatus }
  | { type: "githubRepos"; requestId: string; repos: GithubRepo[] }
  /** Reply to `github.login`: the code to type on GitHub. */
  | { type: "githubDevice"; requestId: string; device: GithubDeviceCode }
  /** How a sign-in started from MoonAgentic ended, sent to every client. */
  | {
      type: "githubLogin";
      state: "done" | "failed" | "cancelled";
      login?: string;
      error?: string;
    }
  /** Reply to `local.clones`: where projects go by default, and the git folders found. */
  | { type: "localClones"; requestId: string; parent: string; clones: LocalClone[] }
  /**
   * A pull request as it is now. Without `pr`: there is none, or nothing here can ask
   * GitHub (no `gh`, no GitHub remote); `error` says why when asking failed.
   */
  | { type: "pullRequest"; requestId: string; pr?: PullRequestInfo; error?: string }
  /** Reply to a create request, so the client can navigate to what it made. */
  | { type: "created"; requestId: string; id: string }
  /** Reply to a request that makes nothing new, once it succeeded. */
  | { type: "done"; requestId: string }
  /** Answer to a `ping`: the connection is alive. */
  | { type: "pong" }
  | { type: "error"; requestId?: string; message: string };

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(200_000);
/** A message's text, which may be empty when images say it all. */
const messageText = z.string().max(200_000);
/** The images joined to a message, already sent to `POST /api/attachments`. */
const attachments = z.array(id).max(MAX_IMAGES_PER_MESSAGE).optional();
const saysSomething = (m: { text: string; attachments?: string[] | undefined }) =>
  m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0;
const planTitle = z.string().trim().min(1).max(200);
const planDescription = z.string().trim().max(4000);
/** Names an MCP secret may take: an environment variable, or an HTTP header (RFC 9110 token). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const secrets = (name: RegExp, sameName: (a: string, b: string) => boolean) =>
  z
    .array(z.object({ name: z.string().max(200).regex(name), value: z.string().max(10_000) }))
    .max(50)
    .refine((list) => list.every((s, i) => list.findIndex((o) => sameName(o.name, s.name)) === i));

export const McpServerInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stdio"),
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(100),
      env: secrets(ENV_NAME, (a, b) => a === b),
    }),
    z.object({
      type: z.literal("http"),
      url: z.url({ protocol: /^https?$/ }).max(4096),
      headers: secrets(HEADER_NAME, (a, b) => a.toLowerCase() === b.toLowerCase()),
    }),
  ]),
});
export type McpServerInput = z.infer<typeof McpServerInput>;

export const ClientMessage = z.discriminatedUnion("type", [
  /** Asks for a `pong`: a connection that gets none back is dead, whatever the browser says. */
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("project.create"),
    requestId: id,
    name: z.string().trim().min(1).max(120),
    path: z.string().min(1).max(4096),
  }),
  z
    .object({
      type: z.literal("thread.create"),
      requestId: id,
      projectId: id,
      agentId: id,
      permissionMode: z.enum(["supervised", "full"]),
      model: id.optional(),
      settings: z
        .record(id, id)
        .refine((r) => Object.keys(r).length <= 20)
        .optional(),
      /** Gives the thread its own branch and worktree, when the project is a git repository. */
      isolated: z.boolean().optional(),
      text: messageText,
      attachments,
    })
    .refine(saysSomething),
  /**
   * Opens the project's coordinator, made with this agent the first time. Answers
   * `created` with its thread.
   */
  z.object({
    type: z.literal("coordinator.open"),
    requestId: id,
    projectId: id,
    agentId: id,
    model: id.optional(),
  }),
  /** Sends a kind of work to an agent and model; without an agent, back to the coordinator's own. */
  z.object({
    type: z.literal("coordinator.setRoute"),
    kind: z.enum(ROUTE_KINDS),
    agentId: id.optional(),
    model: id.optional(),
  }),
  /** How many threads a coordinator runs at once. */
  z.object({
    type: z.literal("coordinator.setParallel"),
    parallel: z.number().int().min(1).max(MAX_PARALLEL),
  }),
  /** How many turns the whole server runs at once. */
  z.object({
    type: z.literal("server.setMaxTurns"),
    maxTurns: z.number().int().min(1).max(MAX_MAX_TURNS),
  }),
  z.object({ type: z.literal("workspace.review"), threadId: id }),
  z.object({
    type: z.literal("workspace.ship"),
    requestId: id,
    threadId: id,
    message: z.string().trim().min(1).max(10_000),
    pr: z.boolean(),
    /** The files to commit, as the review lists them; every change when left out. */
    files: z.array(z.string().min(1).max(4096)).min(1).max(5000).optional(),
  }),
  z.object({ type: z.literal("thread.open"), threadId: id }),
  /** The window no longer shows the thread: what its agent says next is unread. */
  z.object({ type: z.literal("thread.leave"), threadId: id }),
  z.object({ type: z.literal("thread.setUnread"), threadId: id, unread: z.boolean() }),
  /** Marks every thread of the project as read. */
  z.object({ type: z.literal("project.markRead"), projectId: id }),
  z
    .object({ type: z.literal("thread.send"), threadId: id, text: messageText, attachments })
    .refine(saysSomething),
  z.object({ type: z.literal("thread.cancel"), threadId: id }),
  /** Puts the files back as they were before this message and forgets what came after. */
  z.object({ type: z.literal("thread.restore"), requestId: id, threadId: id, itemId: id }),
  /** Asks for an item whole: a tool's large result, when its line is opened. */
  z.object({ type: z.literal("item.get"), requestId: id, threadId: id, itemId: id }),
  /** Hands the thread to another agent, which gets the conversation so far. */
  z.object({ type: z.literal("thread.switchAgent"), threadId: id, agentId: id }),
  z.object({
    type: z.literal("thread.setPermissionMode"),
    threadId: id,
    permissionMode: z.enum(["supervised", "full"]),
  }),
  z.object({ type: z.literal("thread.setModel"), threadId: id, model: id }),
  z.object({ type: z.literal("thread.setSetting"), threadId: id, settingId: id, value: id }),
  z.object({ type: z.literal("thread.setPinned"), threadId: id, pinned: z.boolean() }),
  /** Gives a task to a team: a lead splits it, coders do the pieces at once, each on a branch. */
  z.object({
    type: z.literal("team.start"),
    requestId: id,
    projectId: id,
    task: text,
    lead: z.object({ agentId: id, model: id.optional() }),
    coder: z.object({ agentId: id, model: id.optional() }),
    reviewer: z.object({ agentId: id, model: id.optional() }).optional(),
    tester: z.object({ agentId: id, model: id.optional() }).optional(),
    merger: z.object({ agentId: id, model: id.optional() }).optional(),
    coders: z.number().int().min(1).max(4),
    permissionMode: z.enum(["supervised", "full"]),
    /** Opens the pull request by itself once done; true when left out. */
    autoShip: z.boolean().optional(),
  }),
  /** Stops the team, its lead and every coder at work. */
  z.object({ type: z.literal("team.stop"), threadId: id }),
  /**
   * Starts a piece that is blocked, failed or stopped again, its tries counted from zero;
   * without a piece, the merge that stopped.
   */
  /** Pushes the finished team's branch and opens its pull request, once more. */
  z.object({
    type: z.literal("team.ship"),
    requestId: id,
    threadId: id,
  }),
  z.object({
    type: z.literal("team.retry"),
    requestId: id,
    threadId: id,
    index: z.number().int().min(0).max(63).optional(),
  }),
  /** Adds a card to the project's planner. */
  z.object({
    type: z.literal("plan.add"),
    requestId: id,
    projectId: id,
    title: planTitle,
    description: planDescription.optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    start: z.number().int().positive().optional(),
    due: z.number().int().positive().optional(),
  }),
  /**
   * Changes a card. `null` clears its description, its days or its thread. The status
   * of a card a team works on follows the team, and cannot be set here.
   */
  z.object({
    type: z.literal("plan.update"),
    requestId: id,
    id,
    title: planTitle.optional(),
    description: planDescription.nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    start: z.number().int().positive().nullable().optional(),
    due: z.number().int().positive().nullable().optional(),
    threadId: id.nullable().optional(),
  }),
  z.object({ type: z.literal("plan.remove"), requestId: id, id }),
  /** Plans a task: at `at`, then as `repeat` says, a new thread starts with `text`. */
  z.object({
    type: z.literal("schedule.add"),
    requestId: id,
    projectId: id,
    title: planTitle.optional(),
    text: z.string().trim().min(1).max(200_000),
    agentId: id,
    model: id.optional(),
    permissionMode: z.enum(["supervised", "full"]),
    isolated: z.boolean().optional(),
    repeat: z.enum(SCHEDULE_REPEATS),
    at: z.number().int().positive(),
  }),
  /** Changes a planned task. Turning one back on that is past due moves it to its next time. */
  z.object({
    type: z.literal("schedule.update"),
    requestId: id,
    id,
    title: planTitle.optional(),
    text: z.string().trim().min(1).max(200_000).optional(),
    repeat: z.enum(SCHEDULE_REPEATS).optional(),
    at: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal("schedule.remove"), requestId: id, id }),
  /** Starts the planned task now, whatever its time; its next time does not move. */
  z.object({ type: z.literal("schedule.run"), requestId: id, id }),
  z.object({ type: z.literal("thread.setArchived"), threadId: id, archived: z.boolean() }),
  z.object({ type: z.literal("thread.delete"), requestId: id, threadId: id }),
  z.object({ type: z.literal("project.remove"), requestId: id, projectId: id }),
  /** Gives the project another name in MoonAgentic; its folder keeps its own. */
  z.object({
    type: z.literal("project.rename"),
    projectId: id,
    name: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal("project.setPinned"), projectId: id, pinned: z.boolean() }),
  /** Looks for project files to mention with `@`, in the thread's folder when given. */
  z.object({
    type: z.literal("files.search"),
    requestId: id,
    projectId: id,
    threadId: id.optional(),
    query: z.string().max(500),
  }),
  /** Lists the skills and project commands of the thread's folder, or the project's. */
  z.object({
    type: z.literal("composer.catalog"),
    requestId: id,
    projectId: id,
    threadId: id.optional(),
  }),
  /** Finds messages containing the text, in every thread. */
  z.object({
    type: z.literal("search"),
    requestId: id,
    query: z.string().trim().min(2).max(200),
  }),
  /** Stars or unstars one model, so two devices editing favorites never overwrite each other. */
  z.object({
    type: z.literal("favorites.toggle"),
    agentId: id,
    model: id,
    starred: z.boolean(),
  }),
  z.object({ type: z.literal("mcp.add"), requestId: id, server: McpServerInput }),
  z.object({ type: z.literal("mcp.setEnabled"), id, enabled: z.boolean() }),
  z.object({ type: z.literal("mcp.remove"), id }),
  /**
   * Starts the agent briefly to learn which models it offers, and whether it is ready.
   * Without a project, it starts in the user's home folder.
   */
  z.object({ type: z.literal("agent.discover"), agentId: id, projectId: id.optional() }),
  z.object({
    type: z.literal("agent.addCustom"),
    requestId: id,
    agent: z.object({
      name: z.string().trim().min(1).max(60),
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(50),
    }),
  }),
  z.object({ type: z.literal("agent.removeCustom"), agentId: id }),
  /** Reads each agent's subscription quotas again now, or only this agent's. */
  z.object({ type: z.literal("quotas.refresh"), requestId: id, agentId: id.optional() }),
  /** Asks what `git` and `gh` know of GitHub on the machine running MoonAgentic. */
  z.object({ type: z.literal("github.status"), requestId: id }),
  /** Lists the repositories the signed-in account can reach, last pushed first. */
  z.object({ type: z.literal("github.repos"), requestId: id }),
  /**
   * Starts « Se connecter à GitHub »: the reply holds a code to type on github.com, and a
   * `githubLogin` message follows once the user said yes there, or no, or let it expire.
   */
  z.object({ type: z.literal("github.login"), requestId: id }),
  /** Stops a sign-in still waiting for the user on GitHub. */
  z.object({ type: z.literal("github.loginCancel"), requestId: id }),
  /** Forgets MoonAgentic's own GitHub sign-in; `gh`'s, if any, is left alone. */
  z.object({ type: z.literal("github.logout"), requestId: id }),
  /** Where new projects go, and the git folders already on the machine. */
  z.object({ type: z.literal("local.clones"), requestId: id }),
  /** Asks GitHub for the pull request of a thread's branch, with its checks. */
  z.object({ type: z.literal("workspace.pr"), requestId: id, threadId: id }),
  /**
   * Merges the pull request of a thread's branch, if its last commit is still `head`: what
   * the user saw is what gets merged.
   */
  z.object({
    type: z.literal("workspace.mergePr"),
    requestId: id,
    threadId: id,
    number: z.number().int().positive(),
    head: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
  /** Asks GitHub for the state of the pull request at this address, to draw its link. */
  z.object({
    type: z.literal("github.pr"),
    requestId: id,
    url: z.string().max(500),
  }),
  /**
   * Clones a GitHub repository into a new folder, `parent/name`, and makes it a project.
   * `repo` is `owner/name` or its address on github.com.
   */
  z.object({
    type: z.literal("project.clone"),
    requestId: id,
    repo: z.string().trim().min(3).max(500),
    parent: z.string().trim().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  /**
   * Answers a permission request. `followUp` is what the user says with a refusal: the
   * server sends it as their next message once the turn that asked is over, since no
   * message can go to an agent still at work.
   */
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
    followUp: z.string().trim().min(1).max(4000).optional(),
  }),
  /** Answers a question the agent holds its turn on: one answer per question, in order. */
  z.object({
    type: z.literal("question.respond"),
    threadId: id,
    itemId: id,
    answers: z
      .array(
        z.object({
          picks: z.array(z.string().max(500)).max(12),
          text: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
