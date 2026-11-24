import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactLinks } from "../src/artifacts.ts";
import { Attachments } from "../src/attachments.ts";
import { Devices } from "../src/devices.ts";
import {
  type AgentProcessRef,
  DiagnosticsMonitor,
  formatBytes,
  formatUptime,
  parsePosixPs,
  parseWindowsProcesses,
  type ProcessInfo,
  readLogTail,
  sumProcessTreeBytes,
} from "../src/diagnostics.ts";
import { createHttpServer } from "../src/http.ts";
import type { Hub } from "../src/hub.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tempDirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moonagentic-diag-"));
  const dataDir = path.join(root, "data");
  const logDir = path.join(dataDir, "logs");
  const worktreesDir = path.join(dataDir, "worktrees");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, logDir, worktreesDir };
}

describe("process-tree memory parsing", () => {
  it("parses POSIX ps output (KiB to bytes) and ignores invalid lines", () => {
    const out = [
      "  100     1  102400",
      "  101   100   51200",
      "  bad   line",
      "",
      "  200   101   25600",
    ].join("\n");
    expect(parsePosixPs(out)).toEqual([
      { pid: 100, ppid: 1, bytes: 102400 * 1024 },
      { pid: 101, ppid: 100, bytes: 51200 * 1024 },
      { pid: 200, ppid: 101, bytes: 25600 * 1024 },
    ]);
  });

  it("parses Windows Get-CimInstance CSV output (WorkingSetSize in bytes)", () => {
    const out = [
      "4200,1000,268435456\r",
      "4201,4200,134217728\r",
      "not,a,process\r",
      "4202,4201,0\r",
    ].join("\n");
    expect(parseWindowsProcesses(out)).toEqual([
      { pid: 4200, ppid: 1000, bytes: 268435456 },
      { pid: 4201, ppid: 4200, bytes: 134217728 },
      { pid: 4202, ppid: 4201, bytes: 0 },
    ]);
  });

  it("sums an agent's full descendant tree and guards against PID cycles", () => {
    const procs: ProcessInfo[] = [
      { pid: 10, ppid: 1, bytes: 100_000_000 },
      { pid: 11, ppid: 10, bytes: 50_000_000 },
      { pid: 12, ppid: 11, bytes: 25_000_000 },
      { pid: 99, ppid: 1, bytes: 999_000_000 },
      // Cycle between 30 and 31
      { pid: 30, ppid: 31, bytes: 10 },
      { pid: 31, ppid: 30, bytes: 20 },
    ];
    expect(sumProcessTreeBytes(10, procs)).toEqual({ bytes: 175_000_000, count: 3 });
    expect(sumProcessTreeBytes(999, procs)).toEqual({ bytes: 0, count: 0 });
    expect(sumProcessTreeBytes(30, procs)).toEqual({ bytes: 30, count: 2 });
  });

  it("formats byte sizes and uptimes in French", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(512 * 1024)).toBe("512 Ko");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 Mo");
    expect(formatBytes(16 * 1024 ** 3)).toBe("16,0 Go");
    expect(formatUptime(42)).toBe("42 s");
    expect(formatUptime(125)).toBe("2 min 5 s");
    expect(formatUptime(3_660)).toBe("1 h 1 min");
    expect(formatUptime(90_000)).toBe("1 j 1 h 0 min");
  });
});

describe("readLogTail", () => {
  it("reads only the end of a file and redacts tokens and API keys", () => {
    const { logDir } = tempDirs();
    const file = path.join(logDir, "sample.log");
    const lines = [
      "08:00:00 démarrage http://localhost:4747/#token=secret-token-123",
      "08:00:01 Authorization: Bearer abcdef1234567890",
      "08:00:02 github ghp_1234567890abcdef and sk-ant-abcdef1234567890",
      "08:00:03 tout va bien",
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const tail = readLogTail(file, 3);
    expect(tail).toHaveLength(3);
    expect(tail[0]).toContain("Bearer …");
    expect(tail[0]).not.toContain("abcdef1234567890");
    expect(tail[1]).toContain("ghp_…");
    expect(tail[1]).toContain("sk-ant-…");
    expect(tail[2]).toBe("08:00:03 tout va bien");

    // Small read cap drops a truncated first line cleanly without crashing.
    const smallTail = readLogTail(file, 10, 40);
    expect(smallTail.at(-1)).toBe("08:00:03 tout va bien");
  });
});

describe("DiagnosticsMonitor", () => {
  it("tracks multi-agent 16 Go RAM peaks, slow events, client errors and respects /lock", async () => {
    const { dataDir, logDir, worktreesDir } = tempDirs();
    writeFileSync(path.join(dataDir, "state.sqlite"), Buffer.alloc(4096));
    writeFileSync(path.join(dataDir, "state.sqlite-wal"), Buffer.alloc(2048));
    mkdirSync(path.join(worktreesDir, "wt-1"));
    mkdirSync(path.join(worktreesDir, "wt-2"));

    let now = new Date("2026-04-15T14:30:00").getTime();
    let locked = false;
    let total = 16 * 1024 ** 3;
    let free = 9 * 1024 ** 3;
    let agents: AgentProcessRef[] = [
      { agentId: "claude", model: "opus", pid: 1000, running: true },
      { agentId: "codex", model: "gpt-5", pid: 2000, running: true },
      { agentId: "gemini", model: "neon", pid: 3000, running: false },
    ];
    const processes: ProcessInfo[] = [
      { pid: 1000, ppid: 1, bytes: 400 * 1024 ** 2 },
      { pid: 1001, ppid: 1000, bytes: 500 * 1024 ** 2 },
      { pid: 2000, ppid: 1, bytes: 600 * 1024 ** 2 },
      { pid: 3000, ppid: 1, bytes: 300 * 1024 ** 2 },
    ];
    const logs: string[] = [];
    const errs: string[] = [];

    const monitor = new DiagnosticsMonitor({
      dataDir,
      logDir,
      worktreesDir,
      appVersion: "0.1.5",
      getAgents: () => agents,
      getRunningTurns: () => agents.filter((a) => a.running).length,
      getStartingAgents: () => 0,
      hasLockedProjects: () => locked,
      sampleProcesses: async () => processes,
      now: () => now,
      memInfo: () => ({ total, free }),
      serverMem: () => ({ rss: 150 * 1024 ** 2, heapUsed: 60 * 1024 ** 2 }),
      log: (l) => logs.push(l),
      error: (l) => errs.push(l),
      sampleIntervalMs: 0,
      lagCheckMs: 0,
    });
    cleanups.push(() => monitor.stop());

    // First sample: 2 active turns / 3 live agents, 7/16 Go used.
    const first = await monitor.sampleNow();
    expect(first.runningTurns).toBe(2);
    expect(first.liveAgents).toBe(3);
    expect(first.worktrees).toBe(2);
    expect(first.agentsTotalBytes).toBe(1800 * 1024 ** 2);
    expect(first.agents[0]).toMatchObject({
      agentId: "claude",
      model: "opus",
      running: true,
      bytes: 900 * 1024 ** 2,
      processes: 2,
    });

    // Second sample: higher RAM pressure (14/16 Go used) with 1 active agent.
    now += 60_000;
    free = 2 * 1024 ** 3;
    agents = [{ agentId: "claude", model: "opus", pid: 1000, running: true }];
    await monitor.sampleNow();

    monitor.recordSlow("git", "git lent (push, 4500 ms)", 4500);
    monitor.recordSlow("agent-exit", "codex arrêté : token=should-hide");
    expect(logs.at(-1)).toContain("git lent (push, 4500 ms)");
    expect(errs.at(-1)).toContain("token=…");
    expect(errs.at(-1)).not.toContain("should-hide");

    // Client error deduplication and redaction.
    expect(
      monitor.recordClientError(
        {
          source: "react",
          message: "Crash Bearer supersecret12345",
          route: "/thread/abc?token=secret999#hash",
          stack: "at App (app.js:1:1)",
        },
        "iPhone",
      ),
    ).toBe(true);
    // Duplicate within 10s is ignored.
    expect(
      monitor.recordClientError(
        { source: "react", message: "Crash Bearer supersecret12345" },
        "iPhone",
      ),
    ).toBe(false);

    // Write today's server and desktop logs to verify inclusion + /lock hiding.
    writeFileSync(
      path.join(logDir, "moonagentic-2026-04-15.log"),
      "14:29:00 [perf] RAM 7,0/16,0 Go\n14:29:05 secret token=abc123\n",
      "utf8",
    );
    writeFileSync(
      path.join(logDir, "desktop-2026-04-15.log"),
      "14:28:00 [renderer] processus arrêté : reason=crashed\n",
      "utf8",
    );

    const unlocked = await monitor.buildReport();
    expect(unlocked.text).toContain("Version : 0.1.5");
    expect(unlocked.text).toContain("RAM totale : 16,0 Go");
    expect(unlocked.text).toContain("Pic multi-agents");
    expect(unlocked.text).toContain("2 actifs / 3 ouverts");
    expect(unlocked.text).toContain("Pic RAM système");
    expect(unlocked.text).toContain("git lent (push, 4500 ms)");
    expect(unlocked.text).toContain("[iPhone / react] (/thread/abc)");
    expect(unlocked.text).toContain("Bearer …");
    expect(unlocked.text).toContain("[Serveur : moonagentic-2026-04-15.log]");
    expect(unlocked.text).toContain("[App de bureau : desktop-2026-04-15.log]");
    expect(unlocked.text).not.toContain("supersecret12345");
    expect(unlocked.text).not.toContain("abc123");
    expect(unlocked.text).not.toContain("secret999");

    // When /lock is active, raw server & desktop logs and agent-exit details are excluded while safe metrics remain.
    locked = true;
    const withLock = await monitor.buildReport();
    expect(withLock.text).toContain("Journaux bruts masqués tant qu'un projet est verrouillé");
    expect(withLock.text).toContain("codex arrêté : détails masqués (/lock)");
    expect(withLock.text).not.toContain("moonagentic-2026-04-15.log");
    expect(withLock.text).not.toContain("desktop-2026-04-15.log");
    expect(withLock.text).toContain("Pic multi-agents");
  });

  it("rate-limits client error reports to 10 per minute", () => {
    const { dataDir, logDir, worktreesDir } = tempDirs();
    const monitor = new DiagnosticsMonitor({
      dataDir,
      logDir,
      worktreesDir,
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => false,
      log: () => undefined,
      error: () => undefined,
      sampleIntervalMs: 0,
      lagCheckMs: 0,
    });
    cleanups.push(() => monitor.stop());

    for (let i = 0; i < 10; i++) {
      expect(monitor.recordClientError({ source: "window", message: `err-${i}` }, "pc")).toBe(true);
    }
    expect(monitor.recordClientError({ source: "window", message: "err-11" }, "pc")).toBe(false);
  });
});

describe("diagnostics HTTP endpoints", () => {
  it("authenticates GET /api/diagnostics and POST /api/client-error", async () => {
    const { dataDir, logDir, worktreesDir } = tempDirs();
    const monitor = new DiagnosticsMonitor({
      dataDir,
      logDir,
      worktreesDir,
      getAgents: () => [],
      getRunningTurns: () => 0,
      getStartingAgents: () => 0,
      hasLockedProjects: () => false,
      sampleProcesses: async () => [],
      log: () => undefined,
      error: () => undefined,
      sampleIntervalMs: 0,
      lagCheckMs: 0,
    });
    cleanups.push(() => monitor.stop());

    const devices = new Devices();
    const hub = {
      attachments: new Attachments(path.join(dataDir, "attachments")),
      artifactLinks: new ArtifactLinks(() => undefined),
      push: { forget: () => undefined },
      lockedThread: () => false,
      connect: () => () => undefined,
      handle: async () => undefined,
    } as unknown as Hub;
    const token = "diag-secret-token";
    const server = createHttpServer({ hub, token, devices, diagnostics: monitor });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Unauthenticated requests are rejected.
    const unauth = await fetch(`${base}/api/diagnostics`);
    expect(unauth.status).toBe(401);

    // Wrong content-type on client-error is rejected.
    const badCt = await fetch(`${base}/api/client-error`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: "oops",
    });
    expect(badCt.status).toBe(415);

    // Valid client error is accepted with 204 and appears in GET /api/diagnostics.
    const posted = await fetch(`${base}/api/client-error`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "window",
        message: "TypeError: cannot read x",
        route: "/settings",
      }),
    });
    expect(posted.status).toBe(204);

    const res = await fetch(`${base}/api/diagnostics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; generatedAt: number };
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.text).toContain("[ordinateur / window] (/settings) TypeError: cannot read x");
  });
});
