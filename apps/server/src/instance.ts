import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The exit code of a server that found another MoonAgentic already running on its data
 * folder: its supervisor does not start it again, as nothing would change.
 */
export const ALREADY_RUNNING = 3;
/** What the server prints then, read by the desktop app. */
export const ALREADY_RUNNING_LINE = "MoonAgentic tourne déjà sur ce dossier de données";

/** Unix socket paths are cut past about 100 bytes. */
const MAX_SOCKET_PATH = 100;

/**
 * Where this data folder's lock listens: a named pipe on Windows, a socket elsewhere. The
 * system frees it when the process ends however it ends, a power cut included, so no lock
 * is ever left behind by a server that is gone.
 */
export function lockAddress(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  let real = dataDir;
  try {
    real = realpathSync.native(dataDir);
  } catch {
    // Not made yet: its name is enough.
  }
  // Windows paths ignore case: C:\Users and c:\users are the same folder.
  const key = platform === "win32" ? real.toLowerCase() : real;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\moonagentic-${hash}`;
  const inside = path.join(dataDir, "instance.sock");
  return Buffer.byteLength(inside) <= MAX_SOCKET_PATH
    ? inside
    : path.join(os.tmpdir(), `moonagentic-${hash}.sock`);
}

const listen = (server: net.Server, address: string) =>
  new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", done);
      reject(error);
    };
    const done = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", done);
    server.listen(address);
  });

/** Whether something answers at a Unix socket left on disk. */
const answers = (address: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(address);
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      // A server too busy to answer is still a server.
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * Holds the data folder for this process, before anything in it is read: a second
 * MoonAgentic on the same folder would otherwise take the first one's running threads for
 * ones a crash left, and stop them. Resolves with a release, or `undefined` when another
 * MoonAgentic holds it already.
 */
export async function lockDataDir(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ release(): void } | undefined> {
  const address = lockAddress(dataDir, platform);
  const server = net.createServer((socket) => socket.end());
  // Holding the lock must not keep the process alive.
  server.unref();
  try {
    await listen(server, address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // A pipe is gone with its process; a socket file outlives it and is checked.
    if (platform === "win32" || (await answers(address))) return undefined;
    rmSync(address, { force: true });
    try {
      await listen(server, address);
    } catch (again) {
      // Another server took it in between.
      if ((again as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
      throw again;
    }
  }
  return { release: () => server.close() };
}

/** Whether the port can be listened on, checked before the data folder is opened. */
export function portFree(port: number, host: string): Promise<boolean> {
  // Port 0 lets the system pick one: there is always one.
  if (port === 0) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** An access token looks like this; anything else in the file is a write that was cut. */
const TOKEN = /^[\w-]{20,}$/;

/**
 * Writes the file whole or not at all: to a file beside it, flushed to disk, then put in
 * its place. A power cut while writing leaves the old file, never an empty or cut one.
 */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const temp = `${file}.tmp`;
  const fd = openSync(temp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/**
 * The access token in `file`, made and written there when there is none yet, or when the
 * one there is empty or cut short (a power cut while it was written by an older version):
 * every link would be refused otherwise, with no way back in.
 */
export function readOrCreateToken(file: string, make: () => string): string {
  let token = "";
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (TOKEN.test(token)) return token;
  if (token) console.warn("Le jeton d'accès était abîmé : un nouveau est créé.");
  token = make();
  writeFileAtomic(file, token);
  return token;
}
