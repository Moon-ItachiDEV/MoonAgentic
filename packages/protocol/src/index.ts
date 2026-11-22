import { z } from "zod";

export type AgentId = string;

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** Two-letter badge shown in the UI, e.g. "CC". */
  short: string;
  available: boolean;
  /** Why the agent cannot run, shown to the user when `available` is false. */
  hint?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
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

export interface Snapshot {
  agents: AgentInfo[];
  projects: Project[];
  threads: Thread[];
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "project"; project: Project }
  | { type: "thread"; thread: Thread }
  | { type: "items"; threadId: string; items: Item[] }
  | { type: "item"; threadId: string; item: Item }
  /** Streaming text appended to an existing agent or thought item. */
  | { type: "append"; threadId: string; itemId: string; text: string }
  /** Reply to a create request, so the client can navigate to what it made. */
  | { type: "created"; requestId: string; id: string }
  | { type: "error"; requestId?: string; message: string };

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(200_000);

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
    text,
  }),
  z.object({ type: z.literal("thread.open"), threadId: id }),
  z.object({ type: z.literal("thread.send"), threadId: id, text }),
  z.object({ type: z.literal("thread.cancel"), threadId: id }),
  z.object({
    type: z.literal("thread.setPermissionMode"),
    threadId: id,
    permissionMode: z.enum(["supervised", "full"]),
  }),
  z.object({
    type: z.literal("permission.respond"),
    threadId: id,
    itemId: id,
    optionId: id,
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
