import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

/** How often the size of the write-ahead log is looked at. */
const LOOK_EVERY_MS = 1000;
/** From this size, the log is copied into the database: SQLite's own threshold. */
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
/**
 * From this many free pages, a look gives as many back to the disk: a few milliseconds of
 * work each time, where all of a large removal at once would hold the server.
 */
export const SHRINK_PAGES = 1024;
/** The longest a closing database waits for the copy under way. */
const CLOSE_WAIT_MS = 10_000;

/**
 * Its own connection to the database, on a thread of its own, that copies the log into it
 * when asked. Plain JavaScript, so that it runs wherever the server runs.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const closed = new Int32Array(workerData.closed);
let db;
const open = () => {
  if (db) return db;
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_size_limit = " + workerData.sizeLimit);
  return db;
};
const notifyClosed = () => {
  Atomics.store(closed, 0, 1);
  Atomics.notify(closed, 0);
};
process.once("exit", notifyClosed);
parentPort.on("message", (message) => {
  if (message === "checkpoint" || message === "truncate") {
    let ok = false;
    let busy = 1;
    try {
      const conn = open();
      const row = conn.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      busy = Number(row?.busy ?? 0);
      if (busy === 0 && message === "truncate") {
        // Shrink an overgrown WAL file without waiting on active readers.
        conn.exec("PRAGMA busy_timeout = 0");
        try {
          const shrunk = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          busy = Number(shrunk?.busy ?? 0);
        } finally {
          conn.exec("PRAGMA busy_timeout = 1000");
        }
      }
      ok = true;
    } catch {
      try {
        db?.close();
      } catch {}
      db = undefined;
    }
    parentPort.postMessage({ ok, busy });
    return;
  }
  try {
    db?.close();
  } catch {}
  db = undefined;
  notifyClosed();
  parentPort.close();
});
`;

/**
 * Copies the write-ahead log into the database away from the server's thread. SQLite does
 * it on the write that makes the log long enough, and waits there for the disk: on a
 * Windows disk, that held the server two seconds in the middle of a thread's removal.
 */
export class Checkpoints {
  private readonly wal: string;
  private readonly timer: NodeJS.Timeout;
  private readonly closed = new SharedArrayBuffer(4);
  private worker?: Worker;
  /** A copy under way, or a thread that could not start: the server's thread does it then. */
  private busy = false;
  private failed = false;
  /** When the log last changed, as seen before the last copy. */
  private copied = 0;
  /** How many rows the server had changed at the last look. */
  private seen = -1;

  private readonly file: string;
  private readonly db: DatabaseSync;

  constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.db = db;
    this.wal = `${file}-wal`;
    // A log grown big by one long write is cut back to this once copied.
    db.exec(`PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = ${CHECKPOINT_BYTES * 2}`);
    this.timer = setInterval(() => this.look(), LOOK_EVERY_MS);
    this.timer.unref();
  }

  /**
   * Copies the log when it is long and changed since the last copy. An overgrown log is cut back
   * only once nothing has written to it since the last look: cutting it waits for every write,
   * and on a Windows disk a write waited longer than the server's patience, and failed.
   */
  look(): void {
    this.shrink();
    if (this.busy) return;
    let changed: number;
    let quiet: boolean;
    let size: number;
    try {
      const stat = statSync(this.wal);
      // Every write is the server's, on this connection: the count of rows it changed says if
      // it wrote, where a file's time can lag behind its writes.
      const writes = Number(
        (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
      );
      quiet = writes === this.seen;
      this.seen = writes;
      size = stat.size;
      changed = stat.mtimeMs;
    } catch {
      return;
    }
    if (size < CHECKPOINT_BYTES) return;
    const cut = quiet && size > CHECKPOINT_BYTES * 2;
    if (changed === this.copied && !cut) return;
    const mode = cut ? "truncate" : "checkpoint";
    const worker = this.thread();
    if (!worker) {
      // Without a thread of its own, as SQLite would have done: the log must not grow forever.
      try {
        const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as
          { busy?: number } | undefined;
        if (!row?.busy) this.copied = changed;
      } catch {}
      return;
    }
    this.busy = true;
    worker.once("message", (reply: { ok?: boolean; busy?: number }) => {
      this.busy = false;
      if (reply?.ok && !reply.busy) this.copied = changed;
    });
    worker.postMessage(mode);
  }

  /** Gives free pages back to the disk, a stretch at a time, when many are left. */
  private shrink(): void {
    if (this.db.isTransaction) return;
    try {
      const { freelist_count: free } = this.db.prepare("PRAGMA freelist_count").get() as {
        freelist_count: number;
      };
      if (free >= SHRINK_PAGES) this.db.exec(`PRAGMA incremental_vacuum(${SHRINK_PAGES})`);
    } catch {
      // Held by another program, or a full disk: tried again at the next look.
    }
  }

  private thread(): Worker | undefined {
    if (this.worker || this.failed) return this.worker;
    try {
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: {
          file: this.file,
          closed: this.closed,
          sizeLimit: CHECKPOINT_BYTES * 2,
        },
      });
      worker.unref();
      const gone = () => {
        if (this.worker === worker) this.worker = undefined;
        this.busy = false;
        this.failed = true;
      };
      worker.on("error", gone);
      worker.on("exit", gone);
      this.worker = worker;
    } catch {
      this.failed = true;
    }
    return this.worker;
  }

  /** Stops copying; the thread's connection is closed before this returns. */
  close(): void {
    clearInterval(this.timer);
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    worker.removeAllListeners();
    worker.on("error", () => undefined);
    worker.postMessage("close");
    // The database's folder may be removed right after: on Windows, an open file stops it.
    if (Atomics.wait(new Int32Array(this.closed), 0, 0, CLOSE_WAIT_MS) === "timed-out") {
      void worker.terminate();
    }
  }
}
