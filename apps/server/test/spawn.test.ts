import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath } from "../src/agents.ts";
import { AgentSession } from "../src/session.ts";
import { killTree, spawnPlan } from "../src/spawn.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-spawn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("spawnPlan", () => {
  it("starts programs as they are, and Windows command files through cmd.exe", () => {
    expect(spawnPlan("/usr/bin/agy", ["acp"], "linux")).toEqual({
      command: "/usr/bin/agy",
      args: ["acp"],
    });
    expect(spawnPlan("C:\\outils\\agy.exe", ["acp"], "win32", "cmd.exe")).toEqual({
      command: "C:\\outils\\agy.exe",
      args: ["acp"],
    });
    expect(spawnPlan("C:\\Program Files\\npm\\agent.CMD", ["acp"], "win32", "cmd.exe")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\npm\\agent.CMD" acp"'],
      windowsVerbatimArguments: true,
    });
  });

  it("refuses anything cmd.exe could read as a command of its own", () => {
    for (const arg of ["a & calc", "%PATH%", 'a"b', "a b", "a|b", "^", ""]) {
      expect(() => spawnPlan("C:\\npm\\agent.cmd", [arg], "win32")).toThrow();
    }
    expect(() => spawnPlan("C:\\a&b\\agent.cmd", ["acp"], "win32")).toThrow();
    expect(() => spawnPlan("C:\\%TEMP%\\agent.bat", ["acp"], "win32")).toThrow();
  });
});

describe("findOnPath", () => {
  it("does not take a folder for a program", () => {
    const dir = tempDir();
    const ext = process.platform === "win32" ? ".exe" : "";
    mkdirSync(path.join(dir, "premier", `outil${ext}`), { recursive: true });
    mkdirSync(path.join(dir, "second"));
    writeFileSync(path.join(dir, "second", `outil${ext}`), "", { mode: 0o755 });
    const found = findOnPath(
      "outil",
      [path.join(dir, "premier"), path.join(dir, "second")].join(path.delimiter),
    );
    expect(found).toBe(path.join(dir, "second", `outil${ext}`));
  });
});

describe("killTree", () => {
  it("stops a process together with what it started", async () => {
    const dir = tempDir();
    const script = path.join(dir, "parent.mjs");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       console.log(child.pid);
       setInterval(() => {}, 1000);`,
    );
    const parent = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    const grandchild = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    expect(alive(grandchild)).toBe(true);

    const exited = new Promise((resolve) => parent.once("exit", resolve));
    killTree(parent, "SIGKILL");
    await exited;
    await expect.poll(() => alive(grandchild), { timeout: 10_000 }).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("on Windows", () => {
  it("starts an agent installed as a .cmd file, and stops it whole", async () => {
    const dir = tempDir();
    const agent = fileURLToPath(new URL("../src/demo-agent.ts", import.meta.url));
    const cmd = path.join(dir, "agent.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${agent}" %*\r\n`);

    const session = await AgentSession.start({
      launch: { command: cmd, args: ["acp"] },
      cwd: dir,
      previousSessionId: null,
      handlers: {
        onUpdate: () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    });
    expect(session.sessionId).toBeTruthy();
    await session.close();
  });
});
