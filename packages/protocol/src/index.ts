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

export type TeamRole = "lead" | "coder" | "reviewer" | "tester";

/** One agent and model of a team, by role. */
export interface TeamMember {
  agentId: AgentId;
  model?: string;
}

/** Where a team is; `blocked` once nothing runs and some piece waits on the user. */
export type TeamPhase = "planning" | "coding" | "blocked" | "done" | "failed" | "stopped";

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

export type Item =
  | {
      id: string;
      kind: "user";
      text: string;
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

export interface Snapshot {
  favorites: Favorites;
  requests: PendingRequest[];
  mcpServers: McpServerInfo[];
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
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
  /** Reply to a create request, so the client can navigate to what it made. */
  | { type: "created"; requestId: string; id: string }
  /** Reply to a request that makes nothing new, once it succeeded. */
  | { type: "done"; requestId: string }
  | { type: "error"; requestId?: string; message: string };

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(200_000);
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
    coders: z.number().int().min(1).max(4),
    permissionMode: z.enum(["supervised", "full"]),
  }),
  /** Stops the team, its lead and every coder at work. */
  z.object({ type: z.literal("team.stop"), threadId: id }),
  /** Starts a piece that is blocked, failed or stopped again, its tries counted from zero. */
  z.object({
    type: z.literal("team.retry"),
    threadId: id,
    index: z.number().int().min(0).max(63),
  }),
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
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
