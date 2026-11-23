import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newToken } from "../src/http.ts";
import {
  ALREADY_RUNNING,
  ALREADY_RUNNING_LINE,
  lockAddress,
  lockDataDir,
  portFree,
  readOrCreateToken,
  writeFileAtomic,
} from "../src/instance.ts";
import { supervise } from "../src/supervisor.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-instance-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
};

describe("data folder lock", () => {
  it("lets one server hold a data folder at a time, and frees it on release", async () => {
    const dir = tempDir();
    const first = await lockDataDir(dir);
    expect(first).toBeDefined();
    expect(await lockDataDir(dir)).toBeUndefined();
    // Another folder is free.
    const other = await lockDataDir(tempDir());
    expect(other).toBeDefined();
    other?.release();
    first?.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await lockDataDir(dir);
    expect(again).toBeDefined();
    again?.release();
  });

  it.skipIf(process.platform === "win32")(
    "takes over a socket a crashed server left behind",
    async () => {
      const dir = tempDir();
      // A file where the socket was, with nothing listening on it any more.
      writeFileSync(lockAddress(dir), "");
      const lock = await lockDataDir(dir);
      expect(lock).toBeDefined();
      lock?.release();
    },
  );

  it("names the same lock for the same folder whatever its case on Windows", () => {
    expect(lockAddress("C:\\Users\\Moi\\.moonagentic", "win32")).toBe(
      lockAddress("c:\\users\\moi\\.moonagentic", "win32"),
    );
    expect(lockAddress("C:\\Users\\Moi\\.moonagentic", "win32")).toMatch(
      /^\\\\\.\\pipe\\moonagentic-[0-9a-f]{16}$/,
    );
  });

  it("tells a taken port from a free one", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => taken.close());
    const port = (taken.address() as net.AddressInfo).port;
    expect(await portFree(port, "127.0.0.1")).toBe(false);
    taken.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await portFree(port, "127.0.0.1")).toBe(true);
    expect(await portFree(0, "127.0.0.1")).toBe(true);
  });
});

describe("access token file", () => {
  it("makes a token once, then keeps it", () => {
    const file = path.join(tempDir(), "token");
    const token = readOrCreateToken(file, newToken);
    expect(readFileSync(file, "utf8")).toBe(token);
    expect(readOrCreateToken(file, newToken)).toBe(token);
  });

  it("makes a new one when the file is empty or was cut short", () => {
    const warn = console.warn;
    console.warn = () => undefined;
    cleanups.push(() => (console.warn = warn));
    const file = path.join(tempDir(), "token");
    for (const broken of ["", "\n", "Ab3", "\0\0\0\0"]) {
      writeFileSync(file, broken);
      const token = readOrCreateToken(file, newToken);
      expect(token).toMatch(/^[\w-]{32}$/);
      expect(readFileSync(file, "utf8")).toBe(token);
    }
  });

  it("writes a file whole, leaving nothing beside it", () => {
    const file = path.join(tempDir(), "token");
    writeFileAtomic(file, "old");
    writeFileAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("a second MoonAgentic on the same data folder", () => {
  const serverScript = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const run = (dataDir: string) => {
    const child = spawn(
      process.execPath,
      [serverScript, "--data-dir", dataDir, "--port", "0", "--host", "127.0.0.1"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    return { child, output: () => out };
  };
  const ended = (child: ChildProcess) =>
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  it("ends at once with its own code, before the folder's state is touched", async () => {
    const dataDir = tempDir();
    const first = run(dataDir);
    cleanups.push(() => first.child.kill());
    await new Promise<void>((resolve, reject) => {
      first.child.stdout.on("data", () => {
        if (first.output().includes("MoonAgentic est prêt")) resolve();
      });
      first.child.once("exit", () => reject(new Error(first.output())));
    });
    const second = run(dataDir);
    expect(await ended(second.child)).toBe(ALREADY_RUNNING);
    expect(second.output()).toContain(ALREADY_RUNNING_LINE);
    // The first one is still there.
    expect(first.child.exitCode).toBeNull();
  });

  it("is not started again by its supervisor", async () => {
    const dir = tempDir();
    const script = path.join(dir, "server.mjs");
    const runs = path.join(dir, "runs");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(runs)}, "x");
      process.exit(${ALREADY_RUNNING});`,
    );
    const code = await new Promise<number>((resolve) => {
      supervise({
        script,
        args: [],
        logDir: path.join(dir, "logs"),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        exit: resolve,
      });
    });
    expect(code).toBe(ALREADY_RUNNING);
    expect(readFileSync(runs, "utf8")).toBe("x");
  });
});
