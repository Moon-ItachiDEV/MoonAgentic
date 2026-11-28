import { chmodSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Checkpoints } from "./checkpoints.ts";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
  AGENT_STOPPED,
  MAX_PROJECT_MEMORY,
  utf8Bytes,
  type ActivityDay,
  type AgentSetting,
  type Item,
  type ModelChoice,
  type PermissionMode,
  type PlanTask,
  type Project,
  type Schedule,
  type SearchHit,
  type Thread,
  type ThreadStatus,
  type Workspace,
} from "@moonagentic/protocol";
import { isAgentSetting, isModelChoice, isRecord } from "./saved-shapes.ts";

export interface ProjectMemoryRecord {
  text: string;
  updatedAt?: number;
}

const PROJECT_MEMORY_PREFIX = "projectMemory:";

export interface AgentModels {
  models: ModelChoice[];
  /** What the agent picks on its own for a new session. */
  current: string;
  /** Its other settings, with the value it picks on its own as `current`. */
  settings?: AgentSetting[];
  /** Settings observed per model id, when choices (such as reasoning effort) vary by model. */
  modelSettings?: Record<string, AgentSetting[]>;
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
  | "quota"
  | "parentId"
  | "role"
  | "worksIn"
  | "team"
  | "prReview"
  | "plan"
>;

/** Why a turn found at work on start is over: the server stopped under it. */
export const SERVER_STOPPED = "Le serveur s'est arrêté pendant ce tour.";

/** What says where a thread works. */
export type ThreadPlace = Pick<
  Thread,
  "id" | "projectId" | "title" | "workspace" | "worksIn" | "createdAt"
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
    ...(thread.quota ? { quota: thread.quota } : {}),
    ...(thread.parentId ? { parentId: thread.parentId } : {}),
    ...(thread.role ? { role: thread.role } : {}),
    ...(thread.worksIn ? { worksIn: thread.worksIn } : {}),
    ...(thread.team ? { team: thread.team } : {}),
    ...(thread.prReview ? { prReview: thread.prReview } : {}),
    ...(thread.plan?.entries.length ? { plan: thread.plan } : {}),
  };
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
};

export { isRecord };

/** The JSON of a column that holds a record; anything else is a damaged row. */
function recordOf<T>(json: string): T {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("ce n'est pas un objet JSON");
  return value as T;
}

const toThread = (row: ThreadRow): Thread => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  agentId: row.agent_id,
  status: row.status,
  permissionMode: row.permission_mode,
  ...(row.model ? { model: row.model } : {}),
  ...(row.workspace ? { workspace: recordOf<Workspace>(row.workspace) } : {}),
  ...(row.extra ? recordOf<ThreadExtra>(row.extra) : {}),
  ...(row.error ? { error: row.error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const TEXT_ITEMS = new Set(["user", "agent", "thought"]);

/** An item of a timeline, as written: a record with an id and a kind, its text a text. */
function parseItem(data: string): Item {
  const item = recordOf<Record<string, unknown>>(data);
  if (typeof item.id !== "string" || typeof item.kind !== "string") {
    throw new Error("ce n'est pas un élément de fil");
  }
  if (TEXT_ITEMS.has(item.kind) && typeof item.text !== "string") {
    throw new Error("son texte n'est pas un texte");
  }
  return item as unknown as Item;
}

/** The broad kind of a saved value: what its reader relies on before it looks any closer. */
type SettingKind = "array" | "object" | "string" | "number" | "boolean";
const kindOf = (value: unknown): SettingKind | "null" | "other" =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "object" ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ? (typeof value as SettingKind)
        : "other";

/**
 * A write not even tried, because the database refuses writes for now and what waits must
 * be written first. Taken as the refusal itself wherever one is.
 */
export class StorageRefused extends Error {
  readonly trouble: string;
  constructor(trouble: string) {
    super(`${trouble} : rien n'a été enregistré.`);
    this.name = "StorageRefused";
    this.trouble = trouble;
  }
}

/** How long a write waits for another program to let go of the database before it fails. */
export const BUSY_TIMEOUT_MS = 2000;

/**
 * Why the database refused a write, in the user's words, when the cause is outside the
 * server: a full disk, another program holding the file, a disk that cannot be written.
 * Nothing for any other error.
 */
export function storageTrouble(error: unknown): string | undefined {
  if (error instanceof StorageRefused) return error.trouble;
  const failure = error as { code?: unknown; errcode?: unknown } | null;
  if (failure?.code !== "ERR_SQLITE_ERROR" || typeof failure.errcode !== "number") {
    return undefined;
  }
  // The low byte is the kind of failure; the rest only says where it happened.
  switch (failure.errcode & 0xff) {
    case 13:
      return "Disque plein";
    case 5:
    case 6:
      return "Base verrouillée par un autre programme";
    case 8:
    case 10:
    case 14:
      return "Écriture impossible sur le disque";
    default:
      return undefined;
  }
}

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
/** A search fills the index this long at most before it looks; the rest is filled after. */
const SEARCH_INDEX_MS = 30;
/** The fewest letters searched for: the index cuts text in groups of three. */
export const MIN_SEARCH_CHARS = 3;
/** FTS5 `MATCH` query intersecting unique 3-char trigrams so `*`, `?`, `[` still use the index. */
function trigramMatch(text: string): string | undefined {
  if (text.includes("\0")) return undefined;
  const chars = [...text];
  if (chars.length < MIN_SEARCH_CHARS) return undefined;
  const grams: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= chars.length - MIN_SEARCH_CHARS && grams.length < 32; i++) {
    const g = chars.slice(i, i + MIN_SEARCH_CHARS).join("");
    if (seen.has(g)) continue;
    seen.add(g);
    grams.push(`"${g.replace(/"/g, '""')}"`);
  }
  return grams.join(" AND ");
}

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
    dropOlderCopies(file, backup);
  }
  for (let step = version; step < migrations.length; step++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrations[step]!(db);
      db.exec(`PRAGMA user_version = ${step + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      // SQLite may have ended the transaction itself (a full disk): the error to report is
      // the one that stopped the step, not « no transaction is active ».
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Removes the copies earlier migrations left next to the database: each is a whole copy of
 * it, one more at each update of the schema. Only `kept`, the one just made, or else the
 * latest, stays.
 */
export function dropOlderCopies(file: string, kept?: string): void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const copies = entries.flatMap((entry) => {
    const found = /^\.v\d+-(\d+)\.bak$/.exec(entry.slice(name.length));
    if (!entry.startsWith(`${name}.v`) || !found) return [];
    const copy = path.join(dir, entry);
    try {
      return statSync(copy).isFile() ? [{ copy, at: Number(found[1]) }] : [];
    } catch {
      return [];
    }
  });
  // Without one just made, the latest stays: copies left by an earlier version go too.
  const keep = kept ?? copies.sort((a, b) => b.at - a.at)[0]?.copy;
  for (const { copy } of copies) {
    if (copy === keep) continue;
    try {
      unlinkSync(copy);
    } catch {
      // Held by another program for a moment: it goes at the next start.
    }
  }
}

/** How many pages of the database hold nothing. */
export function freePages(db: DatabaseSync): number {
  return (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
}

/**
 * Turns a database made before free pages could be given back into one where they can.
 * Done once, at the first start of this version: the whole file is written again. A disk
 * too full for that, or a file held by another program, leaves it as it was, for next time.
 */
function makeShrinkable(db: DatabaseSync): void {
  const mode = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
  if (mode === 2) return;
  try {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM");
    // VACUUM wrote the whole database to the log: it goes into the file at once.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    console.error("La base n'a pas pu être compactée, ce sera fait au prochain démarrage :", error);
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

/** Pages copied per step of a backup, between which the server's own queries run. */
const BACKUP_PAGES = 256;

/** Durable state: projects, threads and each thread's timeline items. */
export class Store {
  /** What this database already said it could not read, so each is said once. */
  private readonly saidUnreadable = new Set<string>();

  /**
   * What a row or a setting holds, or nothing when it cannot be read: it is left out and said
   * once in the log, instead of stopping the start or every screen that connects. The app
   * writes none of these itself: it takes a damaged file or an edit made by hand.
   */
  private readable<T>(what: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      if (!this.saidUnreadable.has(what)) {
        this.saidUnreadable.add(what);
        const why = error instanceof Error ? error.message : String(error);
        console.error(`Base de données : ${what} est illisible et laissé de côté (${why}).`);
      }
      return undefined;
    }
  }

  /** An item read from the database; nothing for a row that cannot be read, said once. */
  private readItem(data: string): Item | undefined {
    return this.readable("un élément de fil", () => parseItem(data));
  }

  readonly db: DatabaseSync;
  /** The path opened for this database, or `:memory:`. */
  readonly file: string;
  private readonly checkpoints?: Checkpoints;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    // Another program that holds the file for a moment (a copy, a look with an SQLite tool)
    // is waited for, instead of failing the write at once.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Free pages can be given back to the disk: a new database takes it before WAL does.
    this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    // Turning WAL on needs the file to itself, and SQLite does not wait for it there: a
    // database still in its older mode, held for a moment, is asked again for as long.
    const until = Date.now() + BUSY_TIMEOUT_MS;
    for (;;) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        const held = storageTrouble(error) === "Base verrouillée par un autre programme";
        if (!held || Date.now() >= until) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    // In WAL mode, NORMAL syncs the disk at each checkpoint instead of at each write: a
    // streamed reply writes many times a second. A power cut can lose the last writes, never
    // the database.
    this.db.exec(`PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`);
    migrate(this.db, file);
    if (file !== ":memory:") {
      dropOlderCopies(file);
      makeShrinkable(this.db);
      this.checkpoints = new Checkpoints(file, this.db);
    }
  }

  /**
   * Gives up to `pages` free pages back to the disk, all of them without a number; true
   * while some remain. Its copies, made page by page, shrink with it.
   */
  shrink(pages?: number): boolean {
    if (this.db.isTransaction) return false;
    try {
      this.db.exec(`PRAGMA incremental_vacuum${pages === undefined ? "" : `(${pages})`}`);
      return freePages(this.db) > 0;
    } catch {
      // Held by another program, or a full disk: it is given back with the next removal.
      return false;
    }
  }

  /**
   * Whether a write waits for another program to let go of the file. Not while the database
   * is known to be held: each write would freeze the server for the whole wait, one after
   * the other, and they are tried again anyway.
   */
  waitOnHold(wait: boolean): void {
    this.db.exec(`PRAGMA busy_timeout = ${wait ? BUSY_TIMEOUT_MS : 0}`);
  }

  /** Writes one row, to learn whether the database takes writes: throws while it does not. */
  tryWrite(): void {
    this.setSetting("lastWriteCheck", Date.now());
  }

  /**
   * Writes a consistent copy of the whole database to `file`, which must not exist yet. The
   * copy goes a few hundred pages at a time, off the main thread: the server keeps answering
   * while a large database is copied.
   */
  async backup(file: string): Promise<void> {
    await backup(this.db, file, { rate: BACKUP_PAGES });
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
      // The failure that stopped the write is the one to report. SQLite has sometimes ended
      // the transaction itself by then (a full disk, a failed COMMIT), and a ROLLBACK that
      // fails in its turn would hide it behind « no transaction is active ».
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {
        // Nothing left to undo.
      }
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
      muted:
        this.readable(`un abonnement aux notifications`, () => {
          const muted: unknown = JSON.parse(r.muted);
          if (!Array.isArray(muted)) throw new Error("ce n'est pas une liste");
          return muted.filter((id): id is string => typeof id === "string");
        }) ?? [],
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

  /**
   * A saved setting, or `fallback` when there is none or when what is saved is not of the kind
   * its reader relies on: the kind of `fallback` itself (a list, a record, a text…), or `kind`
   * when the fallback is null. A list read as a record, or the reverse, stopped the server at
   * its start or closed every screen as it connected.
   */
  getSetting<T>(key: string, fallback: T, kind?: SettingKind): T {
    const row = this.sql(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined;
    if (!row) return fallback;
    const expected =
      kind ?? (fallback === null || fallback === undefined ? undefined : kindOf(fallback));
    const value = this.readable(`le réglage « ${key} »`, () => {
      const saved: unknown = JSON.parse(row.value);
      // A null saved where a value is optional is the absence of that value.
      if (saved === null && (fallback === null || fallback === undefined)) return saved;
      if (expected && kindOf(saved) !== expected) {
        throw new Error(`${kindOf(saved)} au lieu de ${expected}`);
      }
      return saved;
    });
    return value === undefined ? fallback : (value as T);
  }

  /** A saved list, without the entries `isItem` does not know: they are left out, and said. */
  listSetting<T>(key: string, isItem: (item: unknown) => item is T): T[] {
    const saved = this.getSetting<unknown[]>(key, []);
    const kept = saved.filter(isItem);
    if (kept.length < saved.length) {
      this.readable(`une entrée du réglage « ${key} »`, () => {
        throw new Error("forme inattendue");
      });
    }
    return kept;
  }

  /** A saved record, without the values `isValue` does not know: they are left out, and said. */
  recordSetting<T>(key: string, isValue: (value: unknown) => value is T): Record<string, T> {
    const saved = Object.entries(this.getSetting<Record<string, unknown>>(key, {}));
    const kept = saved.filter((entry): entry is [string, T] => isValue(entry[1]));
    if (kept.length < saved.length) {
      this.readable(`une entrée du réglage « ${key} »`, () => {
        throw new Error("forme inattendue");
      });
    }
    return Object.fromEntries(kept);
  }

  /** Whether anything is saved under this key, readable or not. */
  hasSetting(key: string): boolean {
    return !!this.sql(`SELECT 1 FROM settings WHERE key = ?`).get(key);
  }

  setSetting(key: string, value: unknown): void {
    // Written anew, it will be said again if it is damaged again.
    this.saidUnreadable.delete(`le réglage « ${key} »`);
    this.sql(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  }

  deleteSetting(key: string): void {
    this.sql(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  /** Shared memory notes for one project, across every agent and git worktree. */
  getProjectMemory(projectId: string): ProjectMemoryRecord {
    const saved = this.getSetting<ProjectMemoryRecord | null>(
      `${PROJECT_MEMORY_PREFIX}${projectId}`,
      null,
      "object",
    );
    return saved && typeof saved.text === "string"
      ? {
          text: saved.text,
          ...(typeof saved.updatedAt === "number" ? { updatedAt: saved.updatedAt } : {}),
        }
      : { text: "" };
  }

  /** Saves or clears (when empty) the shared memory notes for one project. */
  setProjectMemory(projectId: string, text: string): ProjectMemoryRecord {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    const key = `${PROJECT_MEMORY_PREFIX}${projectId}`;
    if (!normalized) {
      this.deleteSetting(key);
      return { text: "" };
    }
    if (utf8Bytes(normalized) > MAX_PROJECT_MEMORY) {
      throw new Error(`La mémoire du projet est trop longue (${MAX_PROJECT_MEMORY} octets max).`);
    }
    const record: ProjectMemoryRecord = { text: normalized, updatedAt: Date.now() };
    this.setSetting(key, record);
    return record;
  }

  getAgentModels(agentId: string): AgentModels | undefined {
    const row = this.sql(`SELECT data FROM agent_models WHERE agent_id = ?`).get(agentId) as
      { data: string } | undefined;
    return (
      row &&
      this.readable(`la liste des modèles de ${agentId}`, () => {
        const saved = recordOf<Record<string, unknown>>(row.data);
        if (!Array.isArray(saved.models)) throw new Error("pas de liste de modèles");
        if (typeof saved.current !== "string") throw new Error("pas de modèle courant");
        // A damaged entry is left out, the others kept.
        const settingsOf = (value: unknown): AgentSetting[] | undefined =>
          Array.isArray(value) ? value.filter(isAgentSetting) : undefined;
        const settings = settingsOf(saved.settings);
        const perModel = isRecord(saved.modelSettings)
          ? Object.fromEntries(
              Object.entries(saved.modelSettings).flatMap(([model, list]) => {
                const kept = settingsOf(list);
                return kept ? [[model, kept] as const] : [];
              }),
            )
          : undefined;
        return {
          models: saved.models.filter(isModelChoice),
          current: saved.current,
          ...(settings ? { settings } : {}),
          ...(perModel ? { modelSettings: perModel } : {}),
        };
      })
    );
  }

  setAgentModels(agentId: string, models: AgentModels): void {
    this.sql(
      `INSERT INTO agent_models (agent_id, data) VALUES (?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET data = excluded.data`,
    ).run(agentId, JSON.stringify(models));
  }

  /** Work that was in flight when the server stopped cannot resume, so settle it. */
  recoverAfterRestart(): void {
    // A turn the stop cut short says so, as after a clean stop, with « Reprendre » under it:
    // put back to rest without a word, the half-written answer looked finished.
    this.sql(
      `UPDATE threads SET status = 'error', error = ? WHERE status IN ('running', 'waiting')`,
    ).run(`${AGENT_STOPPED}\n${SERVER_STOPPED}`);
    // A turn cut short is not quiet any more, nor in line.
    this.db.exec(
      // A row whose JSON is damaged is left as it is: SQLite's JSON functions fail on it, and
      // the whole start with them. CASE is what guarantees they are not run on it.
      `UPDATE threads SET extra = NULLIF(json_remove(extra, '$.quietSince', '$.inLine'), '{}') WHERE CASE WHEN json_valid(extra) THEN json_extract(extra, '$.quietSince') IS NOT NULL OR json_extract(extra, '$.inLine') IS NOT NULL END`,
    );
    const pending = this.sql(
      `SELECT thread_id, data FROM items WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.kind') = 'permission' END`,
    ).all() as { thread_id: string; data: string }[];
    for (const row of pending) {
      const item = this.readItem(row.data);
      if (item?.kind === "permission" && item.outcome === null) {
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
    return rows.flatMap((row) => this.readable(`le fil ${row.id}`, () => toThread(row)) ?? []);
  }

  /**
   * Unarchived threads with an open, draft or freshly opened pull request: avoids reading and
   * parsing every thread row on each PR-watch tick. `CASE` guards `json_extract` against damaged
   * JSON rows the same way `recoverAfterRestart` and `listThreadPlaces` do.
   */
  listWatchedPrThreads(): Thread[] {
    const rows = this.sql(
      `SELECT * FROM threads
         WHERE workspace IS NOT NULL
           AND CASE WHEN json_valid(extra)
                    THEN COALESCE(json_extract(extra, '$.archived'), 0) != 1
                    ELSE 1 END
           AND (
             CASE WHEN json_valid(extra)
                  THEN json_extract(extra, '$.pr.state') IN ('open', 'draft')
                  ELSE 0 END
             OR (
               CASE WHEN json_valid(workspace)
                    THEN json_extract(workspace, '$.prOpened') = 1
                    ELSE 0 END
               AND CASE WHEN json_valid(extra)
                        THEN json_extract(extra, '$.pr') IS NULL
                        ELSE 1 END
             )
           )
         ORDER BY updated_at DESC`,
    ).all() as unknown as ThreadRow[];
    return rows.flatMap((row) => this.readable(`le fil ${row.id}`, () => toThread(row)) ?? []);
  }

  /**
   * Where each thread works, without the rest: what a removal looks at, thread by thread.
   * Reading every thread whole held the server 40 ms with 2 000 of them.
   */
  listThreadPlaces(): ThreadPlace[] {
    const rows = this.sql(
      `SELECT id, project_id, title, workspace, created_at,
              CASE WHEN json_valid(extra) THEN json_extract(extra, '$.worksIn') END AS works_in
         FROM threads ORDER BY updated_at DESC`,
    ).all() as unknown as {
      id: string;
      project_id: string;
      title: string;
      workspace: string | null;
      created_at: number;
      works_in: unknown;
    }[];
    return rows.flatMap(
      (row) =>
        this.readable(`le fil ${row.id}`, (): ThreadPlace => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
          ...(row.workspace ? { workspace: recordOf<Workspace>(row.workspace) } : {}),
          ...(typeof row.works_in === "string" ? { worksIn: row.works_in } : {}),
          createdAt: row.created_at,
        })) ?? [],
    );
  }

  getThread(id: string): Thread | undefined {
    const row = this.sql(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && this.readable(`le fil ${row.id}`, () => toThread(row));
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
        | "prReview"
        | "summary"
        | "plan"
      >
    > & {
      held?: string | null;
      /** The messages that wait, whole; an empty list clears them. */
      queue?: Thread["queue"];
      /** The thread's goal now; null drops it. */
      goal?: Thread["goal"] | null;
      /** « Corriger tout seul » now; null turns it off. */
      prWatch?: Thread["prWatch"] | null;
      /** What it does about a quota that ran out; null: nothing any more. */
      quota?: Thread["quota"] | null;
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
    const {
      pr,
      held,
      queue,
      goal,
      prWatch,
      quota,
      quietSince,
      inLine,
      error: _error,
      ...rest
    } = patch;
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
    if (quota === null) delete next.quota;
    else if (quota) next.quota = quota;
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

  /** Puts the thread in another project: it then works in that project's folder. */
  moveThread(id: string, projectId: string): Thread {
    this.sql(`UPDATE threads SET project_id = ? WHERE id = ?`).run(projectId, id);
    const moved = this.getThread(id);
    if (!moved) throw new Error(`Unknown thread ${id}`);
    return moved;
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

  /** Whether an answer of the thread, as it is written down, holds this text. */
  answerHolds(threadId: string, text: string): boolean {
    // Looked for as JSON writes it, then checked in the answer itself.
    const rows = this.sql(
      `SELECT data FROM items WHERE thread_id = ? AND instr(data, ?) > 0 ORDER BY seq DESC`,
    ).all(threadId, JSON.stringify(text).slice(1, -1)) as { data: string }[];
    return rows.some((r) => {
      const item = this.readItem(r.data);
      return item?.kind === "agent" && item.text.includes(text);
    });
  }

  /** Whether a tool of this thread says it made this image, written exactly so. */
  toolMade(threadId: string, ref: string): boolean {
    const rows = this.sql(
      `SELECT data FROM items WHERE thread_id = ? AND instr(data, ?) > 0 ORDER BY seq DESC`,
    ).all(threadId, JSON.stringify(ref).slice(1, -1)) as { data: string }[];
    return rows.some((r) => {
      const item = this.readItem(r.data);
      return item?.kind === "tool" && Array.isArray(item.images) && item.images.includes(ref);
    });
  }

  /** The thread's last message from the user and what came after it; all of it without one. */
  lastTurnItems(threadId: string): Item[] {
    const { seq } = this.sql(
      `SELECT MAX(seq) AS seq FROM items WHERE thread_id = ? AND json_extract(data, '$.kind') = 'user'`,
    ).get(threadId) as { seq: number | null };
    const rows = this.sql(
      `SELECT data FROM items WHERE thread_id = ? AND seq >= ? ORDER BY seq`,
    ).all(threadId, seq ?? 0) as { data: string }[];
    return rows.flatMap((r) => this.readItem(r.data) ?? []);
  }

  listItems(threadId: string): Item[] {
    const rows = this.sql(`SELECT data FROM items WHERE thread_id = ? ORDER BY seq`).all(
      threadId,
    ) as { data: string }[];
    return rows.flatMap((r) => this.readItem(r.data) ?? []);
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
    size = PAGE_ITEMS,
  ): { items: Item[]; first: number; earlier: number } {
    const seqOf = (sql: string, ...params: (string | number)[]) =>
      (this.sql(sql).get(...params) as { seq: number | null } | undefined)?.seq ?? undefined;
    // The first item of a page of them; none when there is less than a page.
    let from =
      seqOf(
        `SELECT seq FROM items WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
        threadId,
        before,
        size - 1,
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
    return { items: rows.flatMap((r) => this.readItem(r.data) ?? []), first, earlier: n };
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
    const item = row && this.readItem(row.data);
    return item && row && { item, seq: row.seq };
  }

  lastItem(threadId: string): Item | undefined {
    const row = this.sql(
      `SELECT data FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`,
    ).get(threadId) as { data: string } | undefined;
    return row && this.readItem(row.data);
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
   * Brings the index up to date before a search, when the database takes writes: one it
   * refuses (a full disk, another program holding it) leaves the search to what is indexed.
   */
  private indexSearchIfWritable(): void {
    try {
      // The latest first, for a while only: the first time after an update, all of them
      // took 23 s. The rest is done in the background.
      this.indexSearch(SEARCH_INDEX_MS);
    } catch (error) {
      if (!storageTrouble(error)) throw error;
    }
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
           WHERE d.stale = 1 ORDER BY d.n DESC LIMIT ?`,
      ).all(INDEX_BATCH) as { n: number; data: string }[];
      if (!stale.length) return false;
      this.transaction(() => {
        for (const row of stale) {
          const item = this.readItem(row.data);
          const text = item?.kind === "user" || item?.kind === "agent" ? fold(item.text) : "";
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
   * Projects in `hidden` (locked ones) are excluded before `LIMIT` so they neither leak nor
   * push visible hits out of the result set.
   */
  searchItems(query: string, limit = 30, hidden: string[] = []): SearchHit[] {
    const folded = fold(query);
    // Shorter than 3 chars, the index names nothing and every message would be read.
    const match = trigramMatch(folded);
    if (!match) return [];
    // What was written since the index was last filled is found too.
    this.indexSearchIfWritable();
    // Every character is taken literally, `*`, `?` and `[` included: the trigram index
    // narrows candidates in descending order, and `instr` verifies the exact substring.
    const rows = (
      hidden.length
        ? this.sql(
            `SELECT i.thread_id, i.id, i.data
               FROM search_fts
               JOIN search_docs d ON d.n = search_fts.rowid
               JOIN threads t ON t.id = d.thread_id
               JOIN items i ON i.thread_id = d.thread_id AND i.id = d.item_id
              WHERE search_fts MATCH ?
                AND instr(search_fts.text, ?) > 0
                AND t.project_id NOT IN (${hidden.map(() => "?").join(", ")})
              ORDER BY search_fts.rowid DESC
              LIMIT ?`,
          ).all(match, folded, ...hidden, limit)
        : this.sql(
            `SELECT i.thread_id, i.id, i.data FROM (
               SELECT rowid AS n FROM search_fts
                WHERE search_fts MATCH ? AND instr(text, ?) > 0
                ORDER BY rowid DESC LIMIT ?
             ) hit
             JOIN search_docs d ON d.n = hit.n
             JOIN items i ON i.thread_id = d.thread_id AND i.id = d.item_id
             ORDER BY hit.n DESC`,
          ).all(match, folded, limit)
    ) as { thread_id: string; id: string; data: string }[];
    return rows.flatMap((row): SearchHit[] => {
      const item = this.readItem(row.data);
      if (item?.kind !== "user" && item?.kind !== "agent") return [];
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
   * Messages from the user or an agent inside one project's top-level threads that match all
   * space-separated terms in `query`: the latest `perThread` of each of the `threads` threads
   * that named them last. A thread that names them often takes no other thread's place.
   * Coordinator and team sub-threads are excluded, and no other project is ever touched.
   */
  searchProjectItems(
    projectId: string,
    query: string,
    threads = 10,
    perThread = 3,
    excludeThreadId?: string,
  ): SearchHit[] {
    const terms = [...new Set(fold(query).trim().split(/\s+/).filter(Boolean))].slice(0, 6);
    if (!terms.length) return [];
    // Drive the trigram index with the longest term (most selective), then require every other term.
    const ordered = [...terms].sort((a, b) => [...b].length - [...a].length);
    const primary = ordered[0]!;
    const match = trigramMatch(primary);
    if (!match) return [];
    const rest = ordered.slice(1);
    this.indexSearchIfWritable();
    const extraClauses = rest.map(() => `AND instr(search_fts.text, ?) > 0`).join("\n            ");
    const excludeClause = excludeThreadId ? `AND t.id != ?` : "";
    const params: (string | number)[] = [
      match,
      primary,
      ...rest,
      projectId,
      ...(excludeThreadId ? [excludeThreadId] : []),
      perThread,
      threads * perThread,
    ];
    // Each match is numbered within its thread, the latest first, and only the first few of
    // each thread are opened: at most `perThread` rows a thread, so `threads` threads fit.
    const rows = this.sql(
      `SELECT i.thread_id, i.id, i.data
         FROM (
           SELECT d.thread_id AS thread_id, d.item_id AS item_id, search_fts.rowid AS n,
                  ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY search_fts.rowid DESC) AS nth,
                  MAX(search_fts.rowid) OVER (PARTITION BY d.thread_id) AS latest
             FROM search_fts
             JOIN search_docs d ON d.n = search_fts.rowid
             JOIN threads t ON t.id = d.thread_id
            WHERE search_fts MATCH ?
              AND instr(search_fts.text, ?) > 0
            ${extraClauses}
              AND t.project_id = ?
              ${excludeClause}
              AND CASE WHEN json_valid(t.extra) THEN json_extract(t.extra, '$.parentId') IS NULL
                       ELSE t.extra IS NULL END
              AND CASE WHEN json_valid(t.extra)
                       THEN COALESCE(json_extract(t.extra, '$.kind'), '') != 'coordinator'
                       ELSE t.extra IS NULL END
         ) hit
         JOIN items i ON i.thread_id = hit.thread_id AND i.id = hit.item_id
        WHERE hit.nth <= ?
        ORDER BY hit.latest DESC, hit.n DESC
        LIMIT ?`,
    ).all(...params) as { thread_id: string; id: string; data: string }[];
    const foldedQuery = fold(query).trim();
    return rows.flatMap((row): SearchHit[] => {
      const item = this.readItem(row.data);
      if (item?.kind !== "user" && item?.kind !== "agent") return [];
      const focus = fold(item.text).includes(foldedQuery) ? query : primary;
      return [
        {
          threadId: row.thread_id,
          itemId: row.id,
          kind: item.kind,
          snippet: snippet(item.text, focus),
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
  /** The threads of the projects in `hidden` (locked ones) are left out. */
  activityDays(since: number, offsetMs: number, hidden: string[] = []): ActivityDay[] {
    const rows = this.sql(
      `SELECT CAST((json_extract(data, '$.at') - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS count
         FROM items
         WHERE json_extract(data, '$.kind') IN ('user', 'agent')
           AND json_extract(data, '$.byTeam') IS NOT 1
           AND json_extract(data, '$.at') >= ?${
             hidden.length
               ? ` AND thread_id NOT IN (SELECT id FROM threads WHERE project_id IN (${hidden
                   .map(() => "?")
                   .join(", ")}))`
               : ""
           }
         GROUP BY day
         ORDER BY day`,
    ).all(offsetMs, since, ...hidden) as { day: number; count: number }[];
    return rows.map((row) => ({ day: Number(row.day), count: Number(row.count) }));
  }

  /** When the first thread still kept was started, if any. */
  firstThreadAt(hidden: string[] = []): number | undefined {
    const row = this.sql(
      `SELECT MIN(created_at) AS first FROM threads${
        hidden.length ? ` WHERE project_id NOT IN (${hidden.map(() => "?").join(", ")})` : ""
      }`,
    ).get(...hidden) as { first: number | null } | undefined;
    return row?.first ?? undefined;
  }

  listPlanTasks(): PlanTask[] {
    const rows = this.sql(`SELECT id, data FROM plan_tasks ORDER BY created_at, number`).all() as {
      id: string;
      data: string;
    }[];
    return rows.flatMap(
      (r) =>
        this.readable(`la carte ${r.id} du planificateur`, () => recordOf<PlanTask>(r.data)) ?? [],
    );
  }

  getPlanTask(id: string): PlanTask | undefined {
    const row = this.sql(`SELECT data FROM plan_tasks WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return (
      row && this.readable(`la carte ${id} du planificateur`, () => recordOf<PlanTask>(row.data))
    );
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
    const rows = this.sql(`SELECT id, data FROM schedules ORDER BY created_at, id`).all() as {
      id: string;
      data: string;
    }[];
    return rows.flatMap(
      (r) => this.readable(`la tâche planifiée ${r.id}`, () => recordOf<Schedule>(r.data)) ?? [],
    );
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.sql(`SELECT data FROM schedules WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row && this.readable(`la tâche planifiée ${id}`, () => recordOf<Schedule>(row.data));
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

  /** Deletes the thread and its timeline, and gives the room they took back to the disk. */
  deleteThread(id: string): void {
    this.sql(`DELETE FROM threads WHERE id = ?`).run(id);
    this.shrink();
  }

  /** Deletes up to `limit` of the thread's messages, the latest first; true while some remain. */
  deleteSomeItems(threadId: string, limit: number): boolean {
    const { changes } = this.sql(
      `DELETE FROM items WHERE thread_id = ? AND seq IN (
         SELECT seq FROM items WHERE thread_id = ? ORDER BY seq DESC LIMIT ?
       )`,
    ).run(threadId, threadId, limit);
    return Number(changes) >= limit;
  }

  /**
   * Deletes the project, its threads, their timelines, and its shared memory, and gives the
   * room they took back to the disk.
   */
  deleteProject(id: string): void {
    this.deleteSetting(`${PROJECT_MEMORY_PREFIX}${id}`);
    this.sql(`DELETE FROM projects WHERE id = ?`).run(id);
    this.shrink();
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
    return removed.flatMap((r) => this.readItem(r.data) ?? []);
  }

  close(): void {
    this.checkpoints?.close();
    this.db.close();
  }
}
