import { z } from "zod";

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
   * the pull request, or the page to open one when the user's \`gh\` could not.
   */
  shipped?: { url?: string; opened: boolean };
  /** Why the branch could not be pushed or its pull request opened. */
  shipError?: string;
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
  /** Put away: out of the sidebar's lists, its worktree removed until it comes back. */
  archived?: boolean;
  /** Set when the thread works on its own branch rather than in the project folder. */
  workspace?: Workspace;
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
}

export type Item =
  | {
      id: string;
      kind: "user";
      text: string;
      /** Written by the team's engine, not by the user: a member's brief, a fix, a check. */
      byTeam?: true;
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
      /** What the tool asks the user, when it is a question. */
      questions?: ToolQuestion[];
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

/** What MoonAgentic sees of GitHub through the user's own `git` and `gh`; it keeps no token. */
export interface GithubStatus {
  /** `git` is installed. */
  git: boolean;
  /** GitHub CLI (`gh`) is installed. */
  gh: boolean;
  /** The account `gh` is signed in to, when it is. */
  login?: string;
  /**
   * How git proves who it is to github.com when it pushes: `gh` lent for each clone and push
   * (after git's own helpers), or only its own credential helper, or nothing.
   */
  gitAuth: "helper" | "gh" | "none";
  /** Why `gh` could not tell who is signed in, in its own words. */
  error?: string;
}

/** A repository the user can reach on GitHub. */
export interface GithubRepo {
  /** `owner/name`. */
  fullName: string;
  description?: string;
  private: boolean;
  /** Its last push, as a timestamp. */
  pushedAt?: number;
}

export interface Snapshot {
  favorites: Favorites;
  requests: PendingRequest[];
  mcpServers: McpServerInfo[];
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
  plan: PlanTask[];
  schedules: Schedule[];
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "favorites"; favorites: Favorites }
  /** Every permission request still waiting, after one is added or answered. */
  | { type: "requests"; requests: PendingRequest[] }
  | { type: "mcpServers"; servers: McpServerInfo[] }
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
  | {
      type: "shipped";
      requestId: string;
      threadId: string;
      commit?: string;
      url?: string;
      prOpened: boolean;
    }
  | { type: "github"; requestId: string; status: GithubStatus }
  | { type: "githubRepos"; requestId: string; repos: GithubRepo[] }
  /** Reply to a create request, so the client can navigate to what it made. */
  | { type: "created"; requestId: string; id: string }
  /** Reply to a request that makes nothing new, once it succeeded. */
  | { type: "done"; requestId: string }
  | { type: "error"; requestId?: string; message: string };

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(200_000);
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
  z.object({
    type: z.literal("project.create"),
    requestId: id,
    name: z.string().trim().min(1).max(120),
    path: z.string().min(1).max(4096),
  }),
  z.object({
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
    text,
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
  z.object({ type: z.literal("thread.send"), threadId: id, text }),
  z.object({ type: z.literal("thread.cancel"), threadId: id }),
  /** Puts the files back as they were before this message and forgets what came after. */
  z.object({ type: z.literal("thread.restore"), requestId: id, threadId: id, itemId: id }),
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
  /** Asks what `git` and `gh` know of GitHub on the machine running MoonAgentic. */
  z.object({ type: z.literal("github.status"), requestId: id }),
  /** Lists the repositories the signed-in `gh` account can reach, last pushed first. */
  z.object({ type: z.literal("github.repos"), requestId: id }),
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
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
