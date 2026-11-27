// On Windows a process tree is stopped by taskkill, which is given a number: the one Windows
// gives again to the next process started, once the first is gone.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree } from "../src/spawn.ts";

/** What taskkill was asked, which is kept instead of being done. */
const asked = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const real = actual.execFile as (...call: unknown[]) => unknown;
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    if (file !== "taskkill") return real(file, args, ...rest);
    asked.push(args);
    (rest.at(-1) as (error: Error | null) => void)(null);
    return undefined;
  }) as unknown as typeof actual.execFile;
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const started: ChildProcess[] = [];
afterEach(() => {
  asked.length = 0;
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

function start(script: string) {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  started.push(child);
  return child;
}

describe("killTree, on Windows", () => {
  it("asks taskkill for the whole tree of a process that still runs", async () => {
    const child = start("setInterval(() => {}, 1000)");
    await killTree(child, "SIGTERM", "win32");
    expect(asked).toEqual([["/pid", String(child.pid), "/T", "/F"]]);
  });

  it("asks nothing for a process already gone: its number may be another one's by now", async () => {
    const child = start("");
    await once(child, "exit");
    // As a probe of an MCP server did: once when it ends, once more a moment later.
    await killTree(child, "SIGTERM", "win32");
    await killTree(child, "SIGKILL", "win32");
    expect(asked).toEqual([]);
  });
});
