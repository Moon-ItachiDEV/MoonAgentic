import { DatabaseSync } from "node:sqlite";
import type {
  AgentSetting,
  Item,
  ModelChoice,
  PermissionMode,
  Project,
  SearchHit,
  Thread,
  ThreadStatus,
  Workspace,
} from "@moonagentic/protocol";

export interface AgentModels {
  models: ModelChoice[];
  /** What the agent picks on its own for a new session. */
  current: string;
  /** Its other settings, with the value it picks on its own as `current`. */
  settings?: AgentSetting[];
}

interface ThreadRow {
  id: string;
  project_id: string;
  title: string;
  agent_id: string;
  status: ThreadStatus;
  permission_mode: PermissionMode;
  error: string | null;
  model: string | null;
  workspace: string | null;
  /** JSON of the thread's optional state: settings, usage, canCompact, commands, pinned. */
  extra: string | null;
  acp_session_id: string | null;
  created_at: number;
  updated_at: number;
}

type ThreadExtra = Pick<Thread, "settings" | "usage" | "canCompact" | "commands" | "pinned">;

const extraOf = (thread: ThreadExtra): string | null => {
  const extra: ThreadExtra = {
    ...(thread.settings ? { settings: thread.settings } : {}),
    ...(thread.usage ? { usage: thread.usage } : {}),
    ...(thread.canCompact ? { canCompact: true } : {}),
    ...(thread.commands?.length ? { commands: thread.commands } : {}),
    ...(thread.pinned ? { pinned: true } : {}),
  };
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
};

const toThread = (row: ThreadRow): Thread => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  agentId: row.agent_id,
  status: row.status,
  permissionMode: row.permission_mode,
  ...(row.model ? { model: row.model } : {}),
  ...(row.workspace ? { workspace: JSON.parse(row.workspace) as Workspace } : {}),
  ...(row.extra ? (JSON.parse(row.extra) as ThreadExtra) : {}),
  ...(row.error ? { error: row.error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Text kept before and after a match: little before, so the match shows on one line. */
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 90;

/** The text around the first match, on one line. */
/** Text without case or accents, so « etat » finds « État ». */
export const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const folded = fold(flat);
  // Folding keeps each letter in place, except in rare scripts: then the start will do.
  const found = folded.length === flat.length ? folded.indexOf(fold(query)) : -1;
  const at = found === -1 ? flat.toLowerCase().indexOf(query.toLowerCase()) : found;
  if (at === -1) return flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER);
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + query.length + SNIPPET_AFTER);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Durable state: projects, threads and each thread's timeline items. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.function("moon_fold", { deterministic: true }, (text) =>
      typeof text === "string" ? fold(text) : null,
    );
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        error TEXT,
        acp_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (thread_id, id)
      );
      CREATE INDEX IF NOT EXISTS items_by_seq ON items(thread_id, seq);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_models (
        agent_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    const threadColumns = this.db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[];
    for (const column of ["model", "workspace", "extra"]) {
      if (!threadColumns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
      }
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  getAgentModels(agentId: string): AgentModels | undefined {
    const row = this.db.prepare(`SELECT data FROM agent_models WHERE agent_id = ?`).get(agentId) as
      { data: string } | undefined;
    return row && (JSON.parse(row.data) as AgentModels);
  }

  setAgentModels(agentId: string, models: AgentModels): void {
    this.db
      .prepare(
        `INSERT INTO agent_models (agent_id, data) VALUES (?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET data = excluded.data`,
      )
      .run(agentId, JSON.stringify(models));
  }

  /** Work that was in flight when the server stopped cannot resume, so settle it. */
  recoverAfterRestart(): void {
    this.db.exec(`UPDATE threads SET status = 'idle' WHERE status IN ('running', 'waiting')`);
    const pending = this.db
      .prepare(
        `SELECT thread_id, data FROM items WHERE json_extract(data, '$.kind') = 'permission'`,
      )
      .all() as { thread_id: string; data: string }[];
    for (const row of pending) {
      const item = JSON.parse(row.data) as Item;
      if (item.kind === "permission" && item.outcome === null) {
        this.putItem(row.thread_id, { ...item, outcome: "cancelled" });
      }
    }
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(`SELECT id, name, path, created_at FROM projects ORDER BY created_at`)
      .all() as { id: string; name: string; path: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path, createdAt: r.created_at }));
  }

  getProject(id: string): Project | undefined {
    const r = this.db
      .prepare(`SELECT id, name, path, created_at FROM projects WHERE id = ?`)
      .get(id) as { id: string; name: string; path: string; created_at: number } | undefined;
    return r && { id: r.id, name: r.name, path: r.path, createdAt: r.created_at };
  }

  addProject(project: Project): void {
    this.db
      .prepare(`INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`)
      .run(project.id, project.name, project.path, project.createdAt);
  }

  listThreads(): Thread[] {
    const rows = this.db
      .prepare(`SELECT * FROM threads ORDER BY updated_at DESC`)
      .all() as unknown as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as
      ThreadRow | undefined;
    return row && toThread(row);
  }

  addThread(thread: Thread): void {
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, model, workspace, extra, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.agentId,
        thread.status,
        thread.permissionMode,
        thread.model ?? null,
        thread.workspace ? JSON.stringify(thread.workspace) : null,
        extraOf(thread),
        thread.createdAt,
        thread.updatedAt,
      );
  }

  updateThread(
    id: string,
    patch: Partial<
      Pick<
        Thread,
        | "status"
        | "agentId"
        | "permissionMode"
        | "title"
        | "model"
        | "workspace"
        | "settings"
        | "usage"
        | "canCompact"
        | "commands"
        | "pinned"
      >
    > & {
      error?: string | null;
    },
  ): Thread {
    const current = this.getThread(id);
    if (!current) throw new Error(`Unknown thread ${id}`);
    // Only activity moves a thread up the sidebar, not a settings change.
    const active = patch.status !== undefined || patch.title !== undefined;
    const next = { ...current, ...patch, updatedAt: active ? Date.now() : current.updatedAt };
    const error = patch.error === undefined ? (current.error ?? null) : patch.error;
    this.db
      .prepare(
        `UPDATE threads SET status = ?, agent_id = ?, permission_mode = ?, title = ?, model = ?, workspace = ?, extra = ?, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.agentId,
        next.permissionMode,
        next.title,
        next.model ?? null,
        next.workspace ? JSON.stringify(next.workspace) : null,
        extraOf(next),
        error,
        next.updatedAt,
        id,
      );
    return this.getThread(id)!;
  }

  getSessionId(threadId: string): string | null {
    const row = this.db.prepare(`SELECT acp_session_id FROM threads WHERE id = ?`).get(threadId) as
      { acp_session_id: string | null } | undefined;
    return row?.acp_session_id ?? null;
  }

  /** Null forgets the agent's session, so the thread's next turn starts a new one. */
  setSessionId(threadId: string, sessionId: string | null): void {
    this.db.prepare(`UPDATE threads SET acp_session_id = ? WHERE id = ?`).run(sessionId, threadId);
  }

  listItems(threadId: string): Item[] {
    const rows = this.db
      .prepare(`SELECT data FROM items WHERE thread_id = ? ORDER BY seq`)
      .all(threadId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item);
  }

  getItem(threadId: string, id: string): Item | undefined {
    const row = this.db
      .prepare(`SELECT data FROM items WHERE thread_id = ? AND id = ?`)
      .get(threadId, id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Item);
  }

  lastItem(threadId: string): Item | undefined {
    const row = this.db
      .prepare(`SELECT data FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(threadId) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Item);
  }

  /** Inserts the item at the end of the timeline, or replaces it in place. */
  putItem(threadId: string, item: Item): void {
    this.db
      .prepare(
        `INSERT INTO items (thread_id, id, seq, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE thread_id = ?), ?)
         ON CONFLICT (thread_id, id) DO UPDATE SET data = excluded.data`,
      )
      .run(threadId, item.id, threadId, JSON.stringify(item));
  }

  /** Messages from the user or an agent that contain `query`, newest first. */
  searchItems(query: string, limit = 30): SearchHit[] {
    const pattern = `%${fold(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT items.thread_id, items.id, items.data FROM items
         JOIN threads ON threads.id = items.thread_id
         WHERE json_extract(items.data, '$.kind') IN ('user', 'agent')
           AND moon_fold(json_extract(items.data, '$.text')) LIKE ? ESCAPE '\\'
         ORDER BY threads.updated_at DESC, items.seq DESC
         LIMIT ?`,
      )
      .all(pattern, limit) as { thread_id: string; id: string; data: string }[];
    return rows.flatMap((row): SearchHit[] => {
      const item = JSON.parse(row.data) as Item;
      if (item.kind !== "user" && item.kind !== "agent") return [];
      return [
        {
          threadId: row.thread_id,
          itemId: row.id,
          kind: item.kind,
          snippet: snippet(item.text, query),
        },
      ];
    });
  }

  /** Removes the item and every item after it; returns what was removed. */
  removeItemsFrom(threadId: string, id: string): Item[] {
    const from = `(SELECT seq FROM items WHERE thread_id = ? AND id = ?)`;
    const removed = this.db
      .prepare(`SELECT data FROM items WHERE thread_id = ? AND seq >= ${from} ORDER BY seq`)
      .all(threadId, threadId, id) as { data: string }[];
    this.db
      .prepare(`DELETE FROM items WHERE thread_id = ? AND seq >= ${from}`)
      .run(threadId, threadId, id);
    return removed.map((r) => JSON.parse(r.data) as Item);
  }

  close(): void {
    this.db.close();
  }
}
