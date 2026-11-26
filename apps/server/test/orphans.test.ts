// Audit of 2026-11-25, N11: a server ended brutally (killed, or ended by its supervisor when
// it no longer answered) stops nobody. Its agents end when their input does: the demo agent
// of a coordinator, which started MoonAgentic's MCP bridge, lived on with it.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const AGENT = fileURLToPath(new URL("../src/demo-agent.ts", import.meta.url));
const BRIDGE = fileURLToPath(new URL("../src/coordinator-bridge.ts", import.meta.url));

/** The processes started by `pid`, at any depth. */
function descendants(pid: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const ppid = /PPid:\s+(\d+)/.exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1];
      parents.set(Number(name), Number(ppid));
    } catch {
      // gone meanwhile
    }
  }
  const found: number[] = [];
  const walk = (parent: number) => {
    for (const [child, of] of parents) {
      if (of !== parent) continue;
      found.push(child);
      walk(child);
    }
  };
  walk(pid);
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform !== "linux")("an agent whose server is gone", () => {
  it("ends, and its MCP bridge with it, once its input ends", async () => {
    const agent = spawn(process.execPath, [AGENT], { stdio: ["pipe", "pipe", "ignore"] });
    const answers = new Map<number, (result: unknown) => void>();
    createInterface({ input: agent.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown };
      if (message.id !== undefined && !message.method) answers.get(message.id)?.(message.result);
    });
    let next = 0;
    const ask = (method: string, params: unknown) =>
      new Promise<unknown>((resolve) => {
        next += 1;
        answers.set(next, resolve);
        agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
      });
    try {
      await ask("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = (await ask("session/new", {
        cwd: os.tmpdir(),
        mcpServers: [{ name: "moonagentic", command: process.execPath, args: [BRIDGE], env: [] }],
      })) as { sessionId: string };
      // Lists the threads: the agent starts its bridge for that, and keeps it.
      await ask("session/prompt", { sessionId, prompt: [{ type: "text", text: "/fils" }] });
      const started = descendants(agent.pid!);
      expect(started.length).toBeGreaterThan(0);

      // As when the server is killed: the agent's input ends, and nobody stops it.
      agent.stdin.end();
      const until = Date.now() + 5_000;
      while ((alive(agent.pid!) || started.some(alive)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(agent.pid!)).toBe(false);
      expect(started.filter(alive)).toEqual([]);
    } finally {
      for (const pid of [agent.pid!, ...descendants(agent.pid!)])
        if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 20_000);
});
