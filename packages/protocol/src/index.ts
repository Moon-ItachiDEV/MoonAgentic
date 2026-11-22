import { z } from "zod";

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
  /** The pull request, or the page to open one, after the last push. */
  prUrl?: string;
  prOpened?: boolean;
}

/** One changed file in a thread's workspace, compared with where its branch started. */
export interface ReviewFile {
  path: string;
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

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  agentId: AgentId;
  status: ThreadStatus;
  permissionMode: PermissionMode;
  /** The model the agent runs, once known. */
  model?: string;
  /** Set when the thread works on its own branch rather than in the project folder. */
  workspace?: Workspace;
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
  | { id: string; kind: "user"; text: string; at: number }
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
  | { id: string; kind: "plan"; entries: PlanEntry[]; at: number };

export type ItemKind = Item["kind"];

/** Favorite model ids per agent, shared by every device. */
export type Favorites = Record<AgentId, string[]>;

export interface Snapshot {
  favorites: Favorites;
  mcpServers: McpServerInfo[];
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "favorites"; favorites: Favorites }
  | { type: "mcpServers"; servers: McpServerInfo[] }
  | { type: "project"; project: Project }
  | { type: "thread"; thread: Thread }
  | { type: "items"; threadId: string; items: Item[] }
  | { type: "item"; threadId: string; item: Item }
  /** Streaming text appended to an existing agent or thought item. */
  | { type: "append"; threadId: string; itemId: string; text: string }
  | { type: "review"; threadId: string; files: ReviewFile[]; error?: string }
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
  }),
  z.object({ type: z.literal("thread.open"), threadId: id }),
  z.object({ type: z.literal("thread.send"), threadId: id, text }),
  z.object({ type: z.literal("thread.cancel"), threadId: id }),
  z.object({
    type: z.literal("thread.setPermissionMode"),
    threadId: id,
    permissionMode: z.enum(["supervised", "full"]),
  }),
  z.object({ type: z.literal("thread.setModel"), threadId: id, model: id }),
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
  /** Starts the agent briefly to learn which models it offers. */
  z.object({ type: z.literal("agent.discover"), agentId: id, projectId: id }),
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
