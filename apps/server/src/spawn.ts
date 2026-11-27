import { type ChildProcess, execFile } from "node:child_process";

export interface SpawnPlan {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const BATCH_FILE = /\.(cmd|bat)$/i;
/** Characters cmd.exe gives a meaning to, even between quotes. */
const CMD_SPECIAL = /["%^!&|<>\r\n]/;
/** No space, comma, semicolon or equals sign either: a command file splits its arguments on them. */
const PLAIN_ARG = /^[\w./:@\\-]+$/;

/**
 * How to start a command. Windows only runs `.cmd` and `.bat` files, which is how npm
 * installs a CLI, through cmd.exe, and Node refuses to do that on its own. cmd.exe reads
 * its command line as a script, so only plain words are let through: anything else is
 * refused rather than escaped.
 */
export function spawnPlan(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? "cmd.exe",
): SpawnPlan {
  if (platform !== "win32" || !BATCH_FILE.test(command)) return { command, args };
  if (CMD_SPECIAL.test(command) || !args.every((arg) => PLAIN_ARG.test(arg))) {
    throw new Error(`Impossible de lancer ${command} sans risque avec ces arguments.`);
  }
  return {
    command: comspec,
    // With /s, cmd.exe drops the outer quotes and runs what is between them as typed.
    args: ["/d", "/s", "/c", `"${[`"${command}"`, ...args].join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Stops a process and everything it started: an agent's adapter starts the agent's own
 * CLI and its MCP servers, which would otherwise live on. On Unix the process must have
 * been spawned `detached`, so that it leads a group the signal can reach. Resolves once
 * the request to stop is made, which on Windows is once the tree is gone.
 */
export function killTree(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (platform === "win32") {
    // Once Node has seen it end, its number is free, and Windows soon gives it to another
    // process: taskkill would end that one and all it started, with code 1 and not a word.
    // A probe of an MCP server asked a second time two seconds late, for a server always
    // gone by then; a `git push` of another test ended that way at that very second (CI,
    // 2026-11-27). Nothing the process had started can be found through it once it is gone.
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    // Windows has no signals: taskkill ends the whole tree at once. Its own end is waited
    // for, since the process it was given can be gone a moment before the ones it started.
    return new Promise((resolve) => {
      const args = ["/pid", String(pid), "/T", "/F"];
      execFile("taskkill", args, { windowsHide: true, timeout: 15_000 }, (error) => {
        if (error) child.kill();
        resolve();
      });
    });
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
  return Promise.resolve();
}
