import { chmodSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  AgentSetting,
  Item,
  ModelChoice,
  PermissionMode,
  PlanTask,
  Project,
  Schedule,
  SearchHit,
  ActivityDay,
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

type ThreadExtra = Pick<
  Thread,
  | "settings"
  | "usage"
  | "canCompact"
  | "commands"
  | "pinned"
  | "unread"
  | "quietSince"
  | "inLine"
  | "archived"
  | "pr"
  | "summary"
  | "kind"
  | "openedBy"
  | "taskKey"
  | "held"
  | "queue"
  | "goal"
  | "prWatch"
  | "parentId"
  | "role"
  | "worksIn"
  | "team"
>;

const extraOf = (thread: ThreadExtra): string | null => {
  const extra: ThreadExtra = {
    ...(thread.settings ? { settings: thread.settings } : {}),
    ...(thread.usage ? { usage: thread.usage } : {}),
    ...(thread.canCompact ? { canCompact: true } : {}),
    ...(thread.commands?.length ? { commands: thread.commands } : {}),
    ...(thread.pinned ? { pinned: true } : {}),
    ...(thread.unread ? { unread: true } : {}),
    ...(thread.quietSince ? { quietSince: thread.quietSince } : {}),
    ...(thread.inLine ? { inLine: true } : {}),
    ...(thread.archived ? { archived: true } : {}),
    ...(thread.pr ? { pr: thread.pr } : {}),
    ...(thread.summary ? { summary: thread.summary } : {}),
    ...(thread.kind ? { kind: thread.kind } : {}),
    ...(thread.openedBy ? { openedBy: thread.openedBy } : {}),
    ...(thread.taskKey ? { taskKey: thread.taskKey } : {}),
    ...(thread.held ? { held: thread.held } : {}),
    ...(thread.queue?.length ? { queue: thread.queue } : {}),
    ...(thread.goal ? { goal: thread.goal } : {}),
    ...(thread.prWatch ? { prWatch: thread.prWatch } : {}),
    ...(thread.parentId ? { parentId: thread.parentId } : {}),
    ...(thread.role ? { role: thread.role } : {}),
    ...(thread.worksIn ? { worksIn: thread.worksIn } : {}),
    ...(thread.team ? { team: thread.team } : {}),
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

/** How many items of a timeline a screen gets at a time. */
export const PAGE_ITEMS = 120;
/** How far back a page may start to begin with the user's message of its first turn. */
const PAGE_TURN_REACH = 400;
/** How many items come with the one a page was asked to reach, before it. */
const PAGE_BEFORE_REACHED = 10;

/** Text kept before and after a match: little before, so the match shows on one line. */
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 90;

/** Text without case or accents, so « etat » finds « État ». */
export const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The text around the first match, on one line. */
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

/**
 * The schema's history, one step per version, kept in `PRAGMA user_version`. A step is
 * only ever added at the end: a database is brought up to date by the steps it has not run.
 */
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 1. The schema before it had a version (jalons 1 to 6a): written so that a database of
  // that time, which may lack the later columns, ends up the same.
  (db) => {
    db.exec(`
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
    const threadColumns = db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[];
    for (const column of ["model", "workspace", "extra"]) {
      if (!threadColumns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
      }
    }
  },
  // 2. The planner's cards (jalon 8a). A project's numbers go on from `plan_next`.
  (db) => {
    db.exec(`
      CREATE TABLE plan_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX plan_tasks_by_project ON plan_tasks(project_id, number);
      ALTER TABLE projects ADD COLUMN plan_next INTEGER NOT NULL DEFAULT 1;
    `);
  },
  // 3. The tasks planned for later (jalon 8c).
  (db) => {
    db.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },
  // 4. The search's own index (V2), so finding a message no longer reads every message.
  // `search_docs` numbers each message that can be found, in the order they were written,
  // and says whether the index has its latest text; `search_fts` holds that text, folded,
  // cut in groups of three letters so any part of a word is found. Which messages hold a
  // group is all it keeps (`detail = none`): half the size, and the text itself settles
  // the rest. The index is filled outside this step, a little at a time.
  (db) => {
    // Only what the user or an agent said; a team's own messages to its agents are left out.
    const found = `json_extract(NEW.data, '$.kind') IN ('user', 'agent')
      AND json_extract(NEW.data, '$.byTeam') IS NOT 1`;
    // A message written again, as an answer that grows, is only marked: its text is
    // indexed later, once, instead of at each write.
    const mark = `
      UPDATE search_docs SET stale = 1
        WHERE thread_id = NEW.thread_id AND item_id = NEW.id AND stale = 0;
      INSERT INTO search_docs (thread_id, item_id) SELECT NEW.thread_id, NEW.id
        WHERE NOT EXISTS (
          SELECT 1 FROM search_docs WHERE thread_id = NEW.thread_id AND item_id = NEW.id
        );`;
    db.exec(`
      CREATE TABLE search_docs (
        n INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 1,
        UNIQUE (thread_id, item_id)
      );
      CREATE INDEX search_docs_stale ON search_docs(n) WHERE stale = 1;
      CREATE VIRTUAL TABLE search_fts USING fts5(
        text, tokenize = 'trigram case_sensitive 1', detail = none
      );
      CREATE TRIGGER items_search_insert AFTER INSERT ON items WHEN ${found} BEGIN ${mark} END;
      CREATE TRIGGER items_search_update AFTER UPDATE OF data ON items WHEN ${found}
        BEGIN ${mark} END;
      -- Fires for a thread's or a project's messages too, deleted with it.
      CREATE TRIGGER items_search_delete AFTER DELETE ON items BEGIN
        DELETE FROM search_fts WHERE rowid = (
          SELECT n FROM search_docs WHERE thread_id = OLD.thread_id AND item_id = OLD.id
        );
        DELETE FROM search_docs WHERE thread_id = OLD.thread_id AND item_id = OLD.id;
      END;
      INSERT INTO search_docs (thread_id, item_id)
        SELECT thread_id, id FROM items
          WHERE json_extract(data, '$.kind') IN ('user', 'agent')
            AND json_extract(data, '$.byTeam') IS NOT 1
          ORDER BY json_extract(data, '$.at'), rowid;
    `);
  },
  // 5. The home page's activity map counts messages per day: an index of when each message
  // was written, holding only what the user or an agent said, so counting reads that index
  // alone, never the messages themselves.
  (db) => {
    db.exec(`
      CREATE INDEX items_activity_at ON items(json_extract(data, '$.at'))
        WHERE json_extract(data, '$.kind') IN ('user', 'agent')
          AND json_extract(data, '$.byTeam') IS NOT 1;
    `);
  },
  // 6. The devices paired with this MoonAgentic, each with a token of its own. Only a hash of
  // the token is kept: a copy of the database opens nothing.
  (db) => {
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER
      );
    `);
  },
  // 7. Where Web Push reaches the devices that asked for it: the push service's address and
  // the keys the browser gave to encrypt for it. A revoked device's go with it.
  (db) => {
    db.exec(`
      CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        device_id TEXT,
        muted TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
    `);
  },
];

/** How many messages the search's index takes in one write. */
const INDEX_BATCH = 100;

/**
 * Brings the database up to the schema this version knows, one step at a time, each in a
 * transaction. A database that holds data is copied first, next to it, so an update that
 * goes wrong loses nothing. A database from a newer MoonAgentic is left untouched.
 */
export function migrate(
  db: DatabaseSync,
  file: string,
  migrations: ((db: DatabaseSync) => void)[] = MIGRATIONS,
): void {
  const version = (db.prepare(`PRAGMA user_version`).get() as { user_version: number })
    .user_version;
  if (version > migrations.length) {
    throw new Error(
      `Cette base de données vient d'une version plus récente de MoonAgentic (schéma ${version}, celle-ci s'arrête au ${migrations.length}). Mets MoonAgentic à jour pour l'ouvrir.`,
    );
  }
  if (version === migrations.length) return;
  const tables = db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)
    .get() as {
    n: number;
  };
  if (tables.n > 0 && file !== ":memory:") {
    const backup = `${file}.v${version}-${Date.now()}.bak`;
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    // Only its owner reads a database backup.
    if (process.platform !== "win32") chmodSync(backup, 0o600);
  }
  for (let step = version; step < migrations.length; step++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrations[step]!(db);
      db.exec(`PRAGMA user_version = ${step + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A paired device as kept: never its token, only the token's hash. */
/** Where Web Push reaches one browser, as kept. */
export interface PushSubscriptionRow {
  endpoint: string;
  /** The browser's public key and secret, base64url, to encrypt for it. */
  p256dh: string;
  auth: string;
  /** The paired device it belongs to; none for the computer itself. */
  deviceId?: string;
  /** The projects it stays quiet about. */
  muted: string[];
  createdAt: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen?: number;
}

/** Durable state: projects, threads and each thread's timeline items. */
export class Store {
  readonly db: DatabaseSync;
  /** The path opened for this database, or `:memory:`. */
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
    migrate(this.db, file);
  }

  /** Writes a consistent copy of the whole database to `file`, which must not exist yet. */
  backup(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  }

  private readonly statements = new Map<string, StatementSync>();

  /** Each query is prepared once, then reused: a streamed reply writes many times a second. */
  private sql(query: string): StatementSync {
    let statement = this.statements.get(query);
    if (!statement) {
      statement = this.db.prepare(query);
      this.statements.set(query, statement);
    }
    return statement;
  }

  /** Runs `work` as one write: all of it lands, or none of it. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The paired devices, oldest first. */
  listDevices(): DeviceRow[] {
    return (
      this.sql(
        `SELECT id, name, token_hash, created_at, last_seen FROM devices ORDER BY created_at, id`,
      ).all() as {
        id: string;
        name: string;
        token_hash: string;
        created_at: number;
        last_seen: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      tokenHash: r.token_hash,
      createdAt: r.created_at,
      ...(r.last_seen !== null ? { lastSeen: r.last_seen } : {}),
    }));
  }

  addDevice(device: DeviceRow): void {
    this.sql(
      `INSERT INTO devices (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).run(device.id, device.name, device.tokenHash, device.createdAt, device.lastSeen ?? null);
  }

  touchDevice(id: string, at: number): void {
    this.sql(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(at, id);
  }

  /** True when there was such a device. Where Web Push reached it goes with it. */
  removeDevice(id: string): boolean {
    this.sql(`DELETE FROM push_subscriptions WHERE device_id = ?`).run(id);
    return Number(this.sql(`DELETE FROM devices WHERE id = ?`).run(id).changes) > 0;
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return (
      this.sql(
        `SELECT endpoint, p256dh, auth, device_id, muted, created_at FROM push_subscriptions
         ORDER BY created_at, endpoint`,
      ).all() as {
        endpoint: string;
        p256dh: string;
        auth: string;
        device_id: string | null;
        muted: string;
        created_at: number;
      }[]
    ).map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      ...(r.device_id ? { deviceId: r.device_id } : {}),
      muted: JSON.parse(r.muted) as string[],
      createdAt: r.created_at,
    }));
  }

  /** Adds it, or replaces the one with the same address. */
  savePushSubscription(row: PushSubscriptionRow): void {
    this.sql(
      `INSERT OR REPLACE INTO push_subscriptions
         (endpoint, p256dh, auth, device_id, muted, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.endpoint,
      row.p256dh,
      row.auth,
      row.deviceId ?? null,
      JSON.stringify(row.muted),
      row.createdAt,
    );
  }

  /** True when there was one at that address. */
  removePushSubscription(endpoint: string): boolean {
    return (
      Number(this.sql(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint).changes) >
      0
    );
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.sql(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.sql(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  }

  getAgentModels(agentId: string): AgentModels | undefined {
    const row = this.sql(`SELECT data FROM agent_models WHERE agent_id = ?`).get(agentId) as
      { data: string } | undefined;
    return row && (JSON.parse(row.data) as AgentModels);
  }

  setAgentModels(agentId: string, models: AgentModels): void {
    this.sql(
      `INSERT INTO agent_models (agent_id, data) VALUES (?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET data = excluded.data`,
    ).run(agentId, JSON.stringify(models));
  }

  /** Work that was in flight when the server stopped cannot resume, so settle it. */
  recoverAfterRestart(): void {
    this.db.exec(`UPDATE threads SET status = 'idle' WHERE status IN ('running', 'waiting')`);
    // A turn cut short is not quiet any more, nor in line.
    this.db.exec(
      `UPDATE threads SET extra = NULLIF(json_remove(extra, '$.quietSince', '$.inLine'), '{}') WHERE json_extract(extra, '$.quietSince') IS NOT NULL OR json_extract(extra, '$.inLine') IS NOT NULL`,
    );
    const pending = this.sql(
      `SELECT thread_id, data FROM items WHERE json_extract(data, '$.kind') = 'permission'`,
    ).all() as { thread_id: string; data: string }[];
    for (const row of pending) {
      const item = JSON.parse(row.data) as Item;
      if (item.kind === "permission" && item.outcome === null) {
        this.putItem(row.thread_id, { ...item, outcome: "cancelled" });
      }
    }
  }

  listProjects(): Project[] {
    const rows = this.sql(
      `SELECT id, name, path, created_at FROM projects ORDER BY created_at`,
    ).all() as { id: string; name: string; path: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path, createdAt: r.created_at }));
  }

  getProject(id: string): Project | undefined {
    const r = this.sql(`SELECT id, name, path, created_at FROM projects WHERE id = ?`).get(id) as
      { id: string; name: string; path: string; created_at: number } | undefined;
    return r && { id: r.id, name: r.name, path: r.path, createdAt: r.created_at };
  }

  renameProject(id: string, name: string): void {
    this.sql(`UPDATE projects SET name = ? WHERE id = ?`).run(name, id);
  }

  addProject(project: Project): void {
    this.sql(`INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`).run(
      project.id,
      project.name,
      project.path,
      project.createdAt,
    );
  }

  listThreads(): Thread[] {
    const rows = this.sql(
      `SELECT * FROM threads ORDER BY updated_at DESC`,
    ).all() as unknown as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): Thread | undefined {
    const row = this.sql(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && toThread(row);
  }

  addThread(thread: Thread): void {
    this.sql(
      `INSERT INTO threads (id, project_id, title, agent_id, status, permission_mode, model, workspace, extra, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
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
        | "unread"
        | "archived"
        | "team"
        | "summary"
      >
    > & {
      held?: string | null;
      /** The messages that wait, whole; an empty list clears them. */
      queue?: Thread["queue"];
      /** The thread's goal now; null drops it. */
      goal?: Thread["goal"] | null;
      /** « Corriger tout seul » now; null turns it off. */
      prWatch?: Thread["prWatch"] | null;
      quietSince?: number | null;
      inLine?: true | null;
      error?: string | null;
      pr?: Thread["pr"] | null;
    },
  ): Thread {
    const current = this.getThread(id);
    if (!current) throw new Error(`Unknown thread ${id}`);
    // Only activity moves a thread up the sidebar, not a settings change.
    const active = patch.status !== undefined || patch.title !== undefined;
    const { pr, held, queue, goal, prWatch, quietSince, inLine, error: _error, ...rest } = patch;
    const next: Thread = {
      ...current,
      ...rest,
      updatedAt: active ? Date.now() : current.updatedAt,
    };
    if (held === null) delete next.held;
    else if (held) next.held = held;
    if (queue?.length) next.queue = queue;
    else if (queue) delete next.queue;
    if (goal === null) delete next.goal;
    else if (goal) next.goal = goal;
    if (prWatch === null) delete next.prWatch;
    else if (prWatch) next.prWatch = prWatch;
    if (inLine === null) delete next.inLine;
    else if (inLine) next.inLine = true;
    if (quietSince === null) delete next.quietSince;
    else if (quietSince) next.quietSince = quietSince;
    if (pr === null) delete next.pr;
    else if (pr) next.pr = pr;
    const error = patch.error === undefined ? (current.error ?? null) : patch.error;
    this.sql(
      `UPDATE threads SET status = ?, agent_id = ?, permission_mode = ?, title = ?, model = ?, workspace = ?, extra = ?, error = ?, updated_at = ? WHERE id = ?`,
    ).run(
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
    const row = this.sql(`SELECT acp_session_id FROM threads WHERE id = ?`).get(threadId) as
      { acp_session_id: string | null } | undefined;
    return row?.acp_session_id ?? null;
  }

  /** Null forgets the agent's session, so the thread's next turn starts a new one. */
  setSessionId(threadId: string, sessionId: string | null): void {
    this.sql(`UPDATE threads SET acp_session_id = ? WHERE id = ?`).run(sessionId, threadId);
  }

  listItems(threadId: string): Item[] {
    const rows = this.sql(`SELECT data FROM items WHERE thread_id = ? ORDER BY seq`).all(
      threadId,
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Item);
  }

  /**
   * The end of the timeline, or the stretch that ends just before the item numbered
   * `before`: about a page of items, starting where a turn starts when that is near, and
   * going back as far as the item `reach` when one is given. `earlier` counts what is
   * before it.
   */
  pageItems(
    threadId: string,
    before: number = Number.MAX_SAFE_INTEGER,
    reach?: string,
  ): { items: Item[]; first: number; earlier: number } {
    const seqOf = (sql: string, ...params: (string | number)[]) =>
      (this.sql(sql).get(...params) as { seq: number | null } | undefined)?.seq ?? undefined;
    // The first item of a page of them; none when there is less than a page.
    let from =
      seqOf(
        `SELECT seq FROM items WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
        threadId,
        before,
        PAGE_ITEMS - 1,
      ) ?? 0;
    if (reach !== undefined) {
      const reached = seqOf(
        `SELECT seq FROM items WHERE thread_id = ? AND id = ?`,
        threadId,
        reach,
      );
      // With a little of what was said just before it.
      if (reached !== undefined) from = Math.min(from, reached - PAGE_BEFORE_REACHED);
    }
    // A page that starts with the user's message reads better than one cut inside a turn.
    from =
      seqOf(
        `SELECT MAX(seq) AS seq FROM items WHERE thread_id = ? AND seq <= ? AND seq > ?
           AND json_extract(data, '$.kind') = 'user'`,
        threadId,
        from,
        from - PAGE_TURN_REACH,
      ) ?? from;
    const rows = this.sql(
      `SELECT seq, data FROM items WHERE thread_id = ? AND seq >= ? AND seq < ? ORDER BY seq`,
    ).all(threadId, from, before) as { seq: number; data: string }[];
    const first = rows[0]?.seq ?? (before === Number.MAX_SAFE_INTEGER ? 0 : before);
    const { n } = this.sql(`SELECT count(*) AS n FROM items WHERE thread_id = ? AND seq < ?`).get(
      threadId,
      first,
    ) as { n: number };
    return { items: rows.map((r) => JSON.parse(r.data) as Item), first, earlier: n };
  }

  getItem(threadId: string, id: string): Item | undefined {
    return this.getItemAt(threadId, id)?.item;
  }

  /** The item and its number in the timeline. */
  getItemAt(threadId: string, id: string): { item: Item; seq: number } | undefined {
    const row = this.sql(`SELECT seq, data FROM items WHERE thread_id = ? AND id = ?`).get(
      threadId,
      id,
    ) as { seq: number; data: string } | undefined;
    return row && { item: JSON.parse(row.data) as Item, seq: row.seq };
  }

  lastItem(threadId: string): Item | undefined {
    const row = this.sql(
      `SELECT data FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`,
    ).get(threadId) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Item);
  }

  /**
   * Inserts the item at the end of the timeline, or replaces it in place; returns its
   * number in the timeline.
   */
  putItem(threadId: string, item: Item): number {
    const row = this.sql(
      `INSERT INTO items (thread_id, id, seq, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE thread_id = ?), ?)
         ON CONFLICT (thread_id, id) DO UPDATE SET data = excluded.data
         RETURNING seq`,
    ).get(threadId, item.id, threadId, JSON.stringify(item)) as { seq: number };
    return row.seq;
  }

  /**
   * Puts in the search's index the messages written since it was last brought up to date.
   * With a time allowance it stops once it is spent and returns true: there is more to do.
   */
  indexSearch(allowanceMs: number = Infinity): boolean {
    const until = performance.now() + allowanceMs;
    for (;;) {
      const stale = this.sql(
        `SELECT d.n, i.data FROM search_docs d
           JOIN items i ON i.thread_id = d.thread_id AND i.id = d.item_id
           WHERE d.stale = 1 ORDER BY d.n LIMIT ?`,
      ).all(INDEX_BATCH) as { n: number; data: string }[];
      if (!stale.length) return false;
      this.transaction(() => {
        for (const row of stale) {
          const item = JSON.parse(row.data) as Item;
          const text = item.kind === "user" || item.kind === "agent" ? fold(item.text) : "";
          this.sql(`DELETE FROM search_fts WHERE rowid = ?`).run(row.n);
          if (text) this.sql(`INSERT INTO search_fts (rowid, text) VALUES (?, ?)`).run(row.n, text);
          this.sql(`UPDATE search_docs SET stale = 0 WHERE n = ?`).run(row.n);
        }
      });
      if (stale.length < INDEX_BATCH) return false;
      if (performance.now() >= until) return true;
    }
  }

  /**
   * Messages from the user or an agent that contain `query`, the latest written first. A
   * team's own messages to its agents are left out: they are long, and not the user's words.
   */
  searchItems(query: string, limit = 30): SearchHit[] {
    // What was written since the index was last filled is found too.
    this.indexSearch();
    // The folded text is looked for as it is, `*`, `?` and `[` included. From three letters
    // the index names the few messages to look in; shorter, the folded texts are read, the
    // latest first, until enough are found. No message is opened either way but those shown.
    const pattern = `*${fold(query).replace(/[*?[]/g, (c) => `[${c}]`)}*`;
    const rows = this.sql(
      `SELECT i.thread_id, i.id, i.data FROM (
           SELECT rowid AS n FROM search_fts WHERE text GLOB ? ORDER BY rowid DESC LIMIT ?
         ) hit
         JOIN search_docs d ON d.n = hit.n
         JOIN items i ON i.thread_id = d.thread_id AND i.id = d.item_id
         ORDER BY hit.n DESC`,
    ).all(pattern, limit) as { thread_id: string; id: string; data: string }[];
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

  /**
   * Messages from the user or an agent written on each day since `since`, counted by the day
   * they fall on once shifted by `offsetMs` (the client's time zone). A team's own briefs
   * are left out, as in search.
   */
  /** Messages per day since `since`, read from `items_activity_at` (its conditions, word for word). */
  activityDays(since: number, offsetMs: number): ActivityDay[] {
    const rows = this.sql(
      `SELECT CAST((json_extract(data, '$.at') - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS count
         FROM items
         WHERE json_extract(data, '$.kind') IN ('user', 'agent')
           AND json_extract(data, '$.byTeam') IS NOT 1
           AND json_extract(data, '$.at') >= ?
         GROUP BY day
         ORDER BY day`,
    ).all(offsetMs, since) as { day: number; count: number }[];
    return rows.map((row) => ({ day: Number(row.day), count: Number(row.count) }));
  }

  /** When the first thread still kept was started, if any. */
  firstThreadAt(): number | undefined {
    const row = this.sql(`SELECT MIN(created_at) AS first FROM threads`).get() as
      { first: number | null } | undefined;
    return row?.first ?? undefined;
  }

  listPlanTasks(): PlanTask[] {
    const rows = this.sql(`SELECT data FROM plan_tasks ORDER BY created_at, number`).all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as PlanTask);
  }

  getPlanTask(id: string): PlanTask | undefined {
    const row = this.sql(`SELECT data FROM plan_tasks WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row && (JSON.parse(row.data) as PlanTask);
  }

  /** Takes the project's next card number: a number is never given twice. */
  nextPlanNumber(projectId: string): number {
    return this.transaction(() => {
      const row = this.sql(`SELECT plan_next FROM projects WHERE id = ?`).get(projectId) as
        { plan_next: number } | undefined;
      if (!row) throw new Error("Projet introuvable.");
      this.sql(`UPDATE projects SET plan_next = ? WHERE id = ?`).run(row.plan_next + 1, projectId);
      return row.plan_next;
    });
  }

  putPlanTask(task: PlanTask): void {
    this.sql(
      `INSERT INTO plan_tasks (id, project_id, number, data, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    ).run(task.id, task.projectId, task.number, JSON.stringify(task), task.createdAt);
  }

  deletePlanTask(id: string): void {
    this.sql(`DELETE FROM plan_tasks WHERE id = ?`).run(id);
  }

  listSchedules(): Schedule[] {
    const rows = this.sql(`SELECT data FROM schedules ORDER BY created_at, id`).all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Schedule);
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.sql(`SELECT data FROM schedules WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row && (JSON.parse(row.data) as Schedule);
  }

  putSchedule(schedule: Schedule): void {
    this.sql(
      `INSERT INTO schedules (id, project_id, data, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    ).run(schedule.id, schedule.projectId, JSON.stringify(schedule), schedule.createdAt);
  }

  deleteSchedule(id: string): void {
    this.sql(`DELETE FROM schedules WHERE id = ?`).run(id);
  }

  /** Deletes the thread and its timeline. */
  deleteThread(id: string): void {
    this.sql(`DELETE FROM threads WHERE id = ?`).run(id);
  }

  /** Deletes the project, its threads and their timelines. */
  deleteProject(id: string): void {
    this.sql(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  /** Removes the item and every item after it; returns what was removed. */
  removeItemsFrom(threadId: string, id: string): Item[] {
    const from = `(SELECT seq FROM items WHERE thread_id = ? AND id = ?)`;
    const removed = this.sql(
      `SELECT data FROM items WHERE thread_id = ? AND seq >= ${from} ORDER BY seq`,
    ).all(threadId, threadId, id) as { data: string }[];
    this.sql(`DELETE FROM items WHERE thread_id = ? AND seq >= ${from}`).run(
      threadId,
      threadId,
      id,
    );
    return removed.map((r) => JSON.parse(r.data) as Item);
  }

  close(): void {
    this.db.close();
  }
}
