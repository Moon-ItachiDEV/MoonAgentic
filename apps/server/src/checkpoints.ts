import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

/** How often the size of the write-ahead log is looked at. */
const LOOK_EVERY_MS = 1000;
/** From this size, the log is copied into the database: SQLite's own threshold. */
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
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
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout = 5000");
} catch {}
parentPort.on("message", (message) => {
  if (message === "checkpoint") {
    try {
      db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {}
    parentPort.postMessage("done");
    return;
  }
  try {
    db?.close();
  } catch {}
  Atomics.store(closed, 0, 1);
  Atomics.notify(closed, 0);
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

  /** Copies the log when it is long and changed since the last copy. */
  look(): void {
    if (this.busy) return;
    let changed: number;
    try {
      const stat = statSync(this.wal);
      if (stat.size < CHECKPOINT_BYTES || stat.mtimeMs === this.copied) return;
      changed = stat.mtimeMs;
    } catch {
      return;
    }
    const worker = this.thread();
    if (!worker) {
      // Without a thread of its own, as SQLite would have done: the log must not grow forever.
      try {
        this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        this.copied = changed;
      } catch {}
      return;
    }
    this.busy = true;
    worker.once("message", () => {
      this.busy = false;
      this.copied = changed;
    });
    worker.postMessage("checkpoint");
  }

  private thread(): Worker | undefined {
    if (this.worker || this.failed) return this.worker;
    try {
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: { file: this.file, closed: this.closed },
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
    Atomics.wait(new Int32Array(this.closed), 0, 0, CLOSE_WAIT_MS);
  }
}
