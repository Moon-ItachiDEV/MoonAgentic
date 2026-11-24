// Runtime crash & performance diagnostics: tracks system + per-agent process-tree RAM,
// event-loop stalls, slow git / agent startups, client UI errors, and builds a redacted
// diagnostic report safe to copy or share (respecting /lock).
import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { redact } from "./supervisor.ts";

type LoopHistogram = ReturnType<typeof monitorEventLoopDelay>;

/** One OS process entry, enough to sum an agent's whole process tree. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  bytes: number;
}

/** One live agent session exposed by Hub — strictly no project names, thread titles or paths. */
export interface AgentProcessRef {
  agentId: string;
  model?: string;
  pid?: number;
  running: boolean;
}

export interface AgentMemSummary {
  agentId: string;
  model?: string;
  running: boolean;
  bytes: number;
  processes: number;
}

export interface PerfSample {
  at: number;
  uptimeSec: number;
  sysTotalBytes: number;
  sysFreeBytes: number;
  sysUsedBytes: number;
  sysUsedRatio: number;
  serverRssBytes: number;
  serverHeapUsedBytes: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  dbBytes: number;
  walBytes: number;
  worktrees: number;
  runningTurns: number;
  liveAgents: number;
  startingAgents: number;
  agentsTotalBytes: number;
  agents: AgentMemSummary[];
}

export type SlowEventKind = "git" | "agent-start" | "event-loop" | "agent-exit";

export interface SlowEvent {
  at: number;
  kind: SlowEventKind;
  detail: string;
  ms?: number;
}

export interface ClientErrorInput {
  source?: unknown;
  message?: unknown;
  stack?: unknown;
  route?: unknown;
}

export interface ClientErrorEntry {
  at: number;
  device: string;
  source: string;
  route?: string;
  message: string;
  stack?: string;
}

export interface DiagnosticsOptions {
  dataDir: string;
  logDir: string;
  worktreesDir: string;
  getAgents: () => AgentProcessRef[];
  getRunningTurns: () => number;
  getStartingAgents: () => number;
  hasLockedProjects: () => boolean;
  appVersion?: string;
  /** Override for deterministic tests. */
  sampleProcesses?: () => Promise<ProcessInfo[]>;
  now?: () => number;
  memInfo?: () => { total: number; free: number };
  serverMem?: () => { rss: number; heapUsed: number };
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Periodic check interval; 0 disables background timers (useful in unit tests). */
  sampleIntervalMs?: number;
  lagCheckMs?: number;
}

const PROCESS_SCAN_TIMEOUT_MS = 5_000;
const PROCESS_SCAN_MAX_BUFFER = 4 * 1024 * 1024;
const SAMPLE_INTERVAL_MS = 60_000;
const ACTIVE_LOG_INTERVAL_MS = 5 * 60_000;
const HIGH_RAM_LOG_INTERVAL_MS = 2 * 60_000;
const LAG_CHECK_MS = 10_000;
const LAG_WARN_MS = 250;
const LAG_LOG_COOLDOWN_MS = 60_000;
const ACTIVITY_DEBOUNCE_MS = 2_000;
const HIGH_RAM_RATIO = 0.8;
const LOW_FREE_RAM_BYTES = 1.5 * 1024 ** 3;
const MAX_HISTORY = 40;
const MAX_SLOW_EVENTS = 40;
const MAX_CLIENT_ERRORS = 30;
const CLIENT_ERROR_WINDOW_MS = 60_000;
const CLIENT_ERROR_MAX_PER_WINDOW = 10;
const CLIENT_ERROR_DEDUP_MS = 10_000;
const MAX_TAIL_READ_BYTES = 256 * 1024;

const pad2 = (n: number) => String(n).padStart(2, "0");
const localDay = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const localTime = (at: number) => {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** Formats a byte count into French human-readable units (Ko / Mo / Go). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} Go`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${Math.round(bytes)} o`;
}

/** Formats a duration in seconds as `Xh Ym` or `Ym Zs`. */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days} j ${hours} h ${mins} min`;
  if (hours > 0) return `${hours} h ${mins} min`;
  if (mins > 0) return `${mins} min ${secs} s`;
  return `${secs} s`;
}

/** Parses `ps -eo pid=,ppid=,rss=` output on Linux/macOS (rss is in KiB). */
export function parsePosixPs(output: string): ProcessInfo[] {
  const list: ProcessInfo[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const rssKiB = Number(m[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKiB)) continue;
    list.push({ pid, ppid, bytes: rssKiB * 1024 });
  }
  return list;
}

/** Parses `PID,PPID,WorkingSetSize` CSV lines from Windows `Get-CimInstance Win32_Process`. */
export function parseWindowsProcesses(output: string): ProcessInfo[] {
  const list: ProcessInfo[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const bytes = Number(m[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(bytes)) continue;
    list.push({ pid, ppid, bytes });
  }
  return list;
}

/** Sums memory across `rootPid` and every descendant process, guarded against PID cycles. */
export function sumProcessTreeBytes(
  rootPid: number,
  processes: ProcessInfo[],
): { bytes: number; count: number } {
  const byPid = new Map<number, ProcessInfo>();
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    let kids = children.get(proc.ppid);
    if (!kids) {
      kids = [];
      children.set(proc.ppid, kids);
    }
    kids.push(proc.pid);
  }
  if (!byPid.has(rootPid)) return { bytes: 0, count: 0 };
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  let bytes = 0;
  let count = 0;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const proc = byPid.get(pid);
    if (!proc) continue;
    bytes += Math.max(0, proc.bytes);
    count += 1;
    for (const kid of children.get(pid) ?? []) {
      if (!visited.has(kid)) {
        visited.add(kid);
        queue.push(kid);
      }
    }
  }
  return { bytes, count };
}

/** Reads the OS process table once, non-blocking and with a short timeout; returns [] on error. */
export function sampleProcessTable(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    const command = platform === "win32" ? "powershell.exe" : "ps";
    const args =
      platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize)" }',
          ]
        : ["-eo", "pid=,ppid=,rss="];
    execFile(
      command,
      args,
      {
        timeout: PROCESS_SCAN_TIMEOUT_MS,
        maxBuffer: PROCESS_SCAN_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || !stdout) return resolve([]);
        resolve(platform === "win32" ? parseWindowsProcesses(stdout) : parsePosixPs(stdout));
      },
    );
  });
}

function fileSizeSafe(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function countDirEntriesSafe(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Reads only the tail of a log file (capped at `maxReadBytes`) so a large daily log never
 * spikes memory, redacting every line as defense-in-depth.
 */
export function readLogTail(
  file: string,
  maxLines = 120,
  maxReadBytes = MAX_TAIL_READ_BYTES,
): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    const start = Math.max(0, size - maxReadBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    const text = buf.subarray(0, read).toString("utf8");
    const lines = text.split(/\r?\n/);
    // If we started mid-file, drop the first line which may be truncated mid-character.
    if (start > 0 && lines.length > 0) lines.shift();
    return lines
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .map((line) => redact(line));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function ramPressureLabel(usedRatio: number, freeBytes: number): string {
  if (usedRatio >= 0.9 || freeBytes < 1024 ** 3) return "critique (risque de swap / lenteurs)";
  if (usedRatio >= HIGH_RAM_RATIO || freeBytes < 2 * 1024 ** 3) return "élevée";
  if (usedRatio >= 0.65) return "soutenue";
  return "confortable";
}

function formatSampleLine(sample: PerfSample, prefix = "[perf]"): string {
  const pct = Math.round(sample.sysUsedRatio * 100);
  const ram = `RAM ${formatBytes(sample.sysUsedBytes)}/${formatBytes(sample.sysTotalBytes)} (${pct} %, libre ${formatBytes(sample.sysFreeBytes)})`;
  const srv = `serveur ${formatBytes(sample.serverRssBytes)}`;
  const agentParts = sample.agents.map(
    (a) =>
      `${a.agentId}${a.model ? `/${a.model}` : ""} ${formatBytes(a.bytes)}${a.running ? "" : " (veille)"}`,
  );
  const agents =
    sample.liveAgents > 0 || sample.runningTurns > 0 || sample.startingAgents > 0
      ? `agents ${sample.runningTurns} actif${sample.runningTurns > 1 ? "s" : ""} / ${sample.liveAgents} ouvert${sample.liveAgents > 1 ? "s" : ""}${sample.startingAgents > 0 ? ` (+${sample.startingAgents} démarrage)` : ""}${sample.agentsTotalBytes > 0 ? ` (${formatBytes(sample.agentsTotalBytes)}${agentParts.length ? " : " + agentParts.join(", ") : ""})` : ""}`
      : "agents 0";
  const lag = `boucle p99 ${Math.round(sample.eventLoopP99Ms)} ms`;
  return `${prefix ? `${prefix} ` : ""}${ram} · ${srv} · ${agents} · ${lag}`;
}

function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return redact(value.replace(/\r\n/g, "\n")).trim().slice(0, max);
}

function sanitizeRoute(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.split(/[?#]/)[0]?.trim().slice(0, 80);
  return clean ? redact(clean) : undefined;
}

const nsToMs = (ns: number) => (Number.isFinite(ns) && ns > 0 ? ns / 1e6 : 0);

/**
 * Monitors server/multi-agent memory pressure, event-loop stalls, slow operations and UI
 * errors, writing concise `[perf]` and `[client-error]` lines to the daily server log and
 * building redacted diagnostic reports on demand.
 */
export class DiagnosticsMonitor {
  private readonly options: DiagnosticsOptions;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;
  private readonly sampleProcesses: () => Promise<ProcessInfo[]>;
  private readonly memInfo: () => { total: number; free: number };
  private readonly serverMem: () => { rss: number; heapUsed: number };

  private readonly history: PerfSample[] = [];
  private readonly slowEvents: SlowEvent[] = [];
  private readonly clientErrors: ClientErrorEntry[] = [];
  private readonly clientErrorTimes: number[] = [];

  private peakRam: PerfSample | undefined;
  private peakMultiAgent: PerfSample | undefined;
  private peakServerRssBytes = 0;
  private peakAgentsBytes = 0;
  private peakLagMs = 0;
  private lastLagP99Ms = 0;
  private lastLagMaxMs = 0;

  private lastActiveLogAt = 0;
  private lastHighRamLogAt = 0;
  private lastLagLogAt = 0;
  private loggedMaxConcurrency = 0;

  private inFlightProcessScan: Promise<ProcessInfo[]> | undefined;
  private histogram: LoopHistogram | undefined;
  private lagTimer: NodeJS.Timeout | undefined;
  private sampleTimer: NodeJS.Timeout | undefined;
  private activityTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: DiagnosticsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.log = options.log ?? ((line) => console.log(line));
    this.logError = options.error ?? ((line) => console.error(line));
    this.sampleProcesses = options.sampleProcesses ?? (() => sampleProcessTable());
    this.memInfo = options.memInfo ?? (() => ({ total: os.totalmem(), free: os.freemem() }));
    this.serverMem =
      options.serverMem ??
      (() => {
        const m = process.memoryUsage();
        return { rss: m.rss, heapUsed: m.heapUsed };
      });

    const lagMs = options.lagCheckMs ?? LAG_CHECK_MS;
    if (lagMs > 0) {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.lagTimer = setInterval(() => this.checkLag(), lagMs);
      this.lagTimer.unref();
    }

    const sampleMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    if (sampleMs > 0) {
      this.sampleTimer = setInterval(() => {
        void this.periodicCheck();
      }, sampleMs);
      this.sampleTimer.unref();
    }
  }

  /** Stops all timers and event-loop monitoring cleanly. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.lagTimer);
    clearInterval(this.sampleTimer);
    clearTimeout(this.activityTimer);
    this.histogram?.disable();
  }

  private checkLag(): void {
    if (!this.histogram || this.closed) return;
    const p99 = nsToMs(this.histogram.percentile(99));
    const max = nsToMs(this.histogram.max);
    this.histogram.reset();
    this.lastLagP99Ms = p99;
    this.lastLagMaxMs = max;
    if (max > this.peakLagMs) this.peakLagMs = max;
    const at = this.now();
    if (max >= LAG_WARN_MS && at - this.lastLagLogAt >= LAG_LOG_COOLDOWN_MS) {
      this.lastLagLogAt = at;
      this.recordSlow(
        "event-loop",
        `gel boucle d'événements : max ${Math.round(max)} ms (p99 ${Math.round(p99)} ms)`,
        Math.round(max),
      );
    }
  }

  /** Called when turns start or finish so multi-agent bursts are captured even if brief. */
  onActivityChanged(): void {
    if (this.closed) return;
    const running = this.options.getRunningTurns();
    const agents = this.options.getAgents().length;
    const active = Math.max(running, agents);
    if (active < 2 && active <= this.loggedMaxConcurrency) return;
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined;
      if (this.closed) return;
      void this.captureActivityPeak();
    }, ACTIVITY_DEBOUNCE_MS);
    this.activityTimer.unref();
  }

  private async captureActivityPeak(): Promise<void> {
    const sample = await this.sampleNow();
    const concurrency = Math.max(sample.runningTurns, sample.liveAgents);
    const at = sample.at;
    const highRam =
      sample.sysUsedRatio >= HIGH_RAM_RATIO || sample.sysFreeBytes < LOW_FREE_RAM_BYTES;
    if (highRam && at - this.lastHighRamLogAt >= HIGH_RAM_LOG_INTERVAL_MS) {
      this.lastHighRamLogAt = at;
      this.lastActiveLogAt = at;
      this.log(formatSampleLine(sample, "[perf] ALERTE RAM"));
      return;
    }
    if (concurrency >= 2 && concurrency > this.loggedMaxConcurrency) {
      this.loggedMaxConcurrency = concurrency;
      this.lastActiveLogAt = at;
      this.log(formatSampleLine(sample, "[perf] pic multi-agents"));
    }
  }

  private async periodicCheck(): Promise<void> {
    if (this.closed) return;
    const { total, free } = this.memInfo();
    const usedRatio = total > 0 ? Math.max(0, (total - free) / total) : 0;
    const highRam = usedRatio >= HIGH_RAM_RATIO || free < LOW_FREE_RAM_BYTES;
    const liveAgents = this.options.getAgents().length;
    const runningTurns = this.options.getRunningTurns();
    const active = liveAgents > 0 || runningTurns > 0;
    const at = this.now();

    // Completely idle with comfortable RAM: zero process scans, zero log spam.
    if (!active && !highRam) return;

    const needsHighRamLog = highRam && at - this.lastHighRamLogAt >= HIGH_RAM_LOG_INTERVAL_MS;
    const needsActiveLog = active && at - this.lastActiveLogAt >= ACTIVE_LOG_INTERVAL_MS;
    const concurrency = Math.max(runningTurns, liveAgents);
    const isNewPeak = concurrency >= 2 && concurrency > this.loggedMaxConcurrency;

    if (!needsHighRamLog && !needsActiveLog && !isNewPeak) {
      // Still sample quietly while active so peaks stay accurate without flooding logs.
      if (active) await this.sampleNow();
      return;
    }

    const sample = await this.sampleNow();
    if (needsHighRamLog) {
      this.lastHighRamLogAt = sample.at;
      this.lastActiveLogAt = sample.at;
      this.log(formatSampleLine(sample, "[perf] ALERTE RAM"));
    } else if (isNewPeak) {
      this.loggedMaxConcurrency = concurrency;
      this.lastActiveLogAt = sample.at;
      this.log(formatSampleLine(sample, "[perf] pic multi-agents"));
    } else if (needsActiveLog) {
      this.lastActiveLogAt = sample.at;
      this.log(formatSampleLine(sample, "[perf]"));
    }
  }

  private scanProcessesOnce(): Promise<ProcessInfo[]> {
    this.inFlightProcessScan ??= this.sampleProcesses()
      .catch(() => [])
      .finally(() => {
        this.inFlightProcessScan = undefined;
      });
    return this.inFlightProcessScan;
  }

  /** Collects a live performance & multi-agent memory sample and updates session peaks. */
  async sampleNow(options?: { forceProcessScan?: boolean }): Promise<PerfSample> {
    const at = this.now();
    const { total, free } = this.memInfo();
    const sysTotalBytes = Math.max(0, total);
    const sysFreeBytes = Math.max(0, Math.min(free, sysTotalBytes));
    const sysUsedBytes = Math.max(0, sysTotalBytes - sysFreeBytes);
    const sysUsedRatio = sysTotalBytes > 0 ? sysUsedBytes / sysTotalBytes : 0;
    const mem = this.serverMem();
    const refs = this.options.getAgents();
    const runningTurns = this.options.getRunningTurns();
    const startingAgents = this.options.getStartingAgents();

    const needsProcessScan = options?.forceProcessScan || refs.some((r) => r.pid !== undefined);
    const processes = needsProcessScan ? await this.scanProcessesOnce() : [];

    const agents: AgentMemSummary[] = refs.map((ref) => {
      const tree =
        ref.pid !== undefined ? sumProcessTreeBytes(ref.pid, processes) : { bytes: 0, count: 0 };
      return {
        agentId: ref.agentId,
        ...(ref.model ? { model: ref.model } : {}),
        running: ref.running,
        bytes: tree.bytes,
        processes: tree.count,
      };
    });
    const agentsTotalBytes = agents.reduce((sum, a) => sum + a.bytes, 0);

    const dbPath = path.join(this.options.dataDir, "state.sqlite");
    const sample: PerfSample = {
      at,
      uptimeSec: Math.max(0, Math.floor((at - this.startedAt) / 1000)),
      sysTotalBytes,
      sysFreeBytes,
      sysUsedBytes,
      sysUsedRatio,
      serverRssBytes: mem.rss,
      serverHeapUsedBytes: mem.heapUsed,
      eventLoopP99Ms: this.lastLagP99Ms,
      eventLoopMaxMs: this.lastLagMaxMs,
      dbBytes: fileSizeSafe(dbPath),
      walBytes: fileSizeSafe(`${dbPath}-wal`),
      worktrees: countDirEntriesSafe(this.options.worktreesDir),
      runningTurns,
      liveAgents: refs.length,
      startingAgents,
      agentsTotalBytes,
      agents,
    };

    this.history.push(sample);
    if (this.history.length > MAX_HISTORY) this.history.shift();

    if (mem.rss > this.peakServerRssBytes) this.peakServerRssBytes = mem.rss;
    if (agentsTotalBytes > this.peakAgentsBytes) this.peakAgentsBytes = agentsTotalBytes;
    if (!this.peakRam || sample.sysUsedRatio > this.peakRam.sysUsedRatio) {
      this.peakRam = sample;
    }
    if (
      !this.peakMultiAgent ||
      sample.runningTurns > this.peakMultiAgent.runningTurns ||
      (sample.runningTurns === this.peakMultiAgent.runningTurns &&
        sample.liveAgents > this.peakMultiAgent.liveAgents) ||
      (sample.runningTurns === this.peakMultiAgent.runningTurns &&
        sample.liveAgents === this.peakMultiAgent.liveAgents &&
        sample.sysUsedBytes > this.peakMultiAgent.sysUsedBytes)
    ) {
      this.peakMultiAgent = sample;
    }

    return sample;
  }

  /** Records a slow operation or unexpected agent exit in memory and in the daily log. */
  recordSlow(kind: SlowEventKind, detail: string, ms?: number): void {
    const clean = sanitizeText(detail, 300);
    if (!clean) return;
    const entry: SlowEvent = {
      at: this.now(),
      kind,
      detail: clean,
      ...(ms !== undefined ? { ms } : {}),
    };
    this.slowEvents.push(entry);
    if (this.slowEvents.length > MAX_SLOW_EVENTS) this.slowEvents.shift();
    if (kind === "agent-exit") this.logError(`[agent-exit] ${clean}`);
    else this.log(`[perf] ${clean}`);
  }

  /** Records a browser / phone UI error, rate-limited and redacted before logging. */
  recordClientError(input: ClientErrorInput, device: string): boolean {
    const at = this.now();
    const message = sanitizeText(input.message, 400);
    if (!message) return false;
    const source = sanitizeText(input.source, 32) || "ui";
    const stack = sanitizeText(input.stack, 1500) || undefined;
    const route = sanitizeRoute(input.route);
    const cleanDevice = sanitizeText(device, 60) || "client";

    // Prune rate window.
    while (
      this.clientErrorTimes.length > 0 &&
      at - this.clientErrorTimes[0]! > CLIENT_ERROR_WINDOW_MS
    ) {
      this.clientErrorTimes.shift();
    }
    if (this.clientErrorTimes.length >= CLIENT_ERROR_MAX_PER_WINDOW) return false;

    const last = this.clientErrors.at(-1);
    if (
      last &&
      last.source === source &&
      last.message === message &&
      at - last.at < CLIENT_ERROR_DEDUP_MS
    ) {
      return false;
    }

    this.clientErrorTimes.push(at);
    const entry: ClientErrorEntry = {
      at,
      device: cleanDevice,
      source,
      ...(route ? { route } : {}),
      message,
      ...(stack ? { stack } : {}),
    };
    this.clientErrors.push(entry);
    if (this.clientErrors.length > MAX_CLIENT_ERRORS) this.clientErrors.shift();

    const firstLine = message.split("\n")[0] ?? message;
    this.logError(
      `[client-error] (${cleanDevice}, ${source}${route ? `, ${route}` : ""}) ${firstLine}`,
    );
    return true;
  }

  /** Builds a complete, redacted plain-text diagnostic report ready to copy or download. */
  async buildReport(): Promise<{ text: string; generatedAt: number }> {
    const current = await this.sampleNow({ forceProcessScan: true });
    const generatedAt = current.at;
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model?.trim() ?? "inconnu";
    const locked = this.options.hasLockedProjects();
    const lines: string[] = [];

    lines.push("=== MoonAgentic — Diagnostic ===");
    lines.push(`Généré le : ${new Date(generatedAt).toISOString()}`);
    if (this.options.appVersion) lines.push(`Version : ${this.options.appVersion}`);
    lines.push(
      `Machine : ${process.platform} ${os.release()} (${process.arch}) · Node ${process.version}`,
    );
    lines.push(
      `CPU : ${cpus.length} cœurs (${cpuModel}) · RAM totale : ${formatBytes(current.sysTotalBytes)}`,
    );
    lines.push(`Uptime serveur : ${formatUptime(current.uptimeSec)}`);

    lines.push("");
    lines.push("--- État actuel ---");
    lines.push(
      `RAM système : ${formatBytes(current.sysUsedBytes)} / ${formatBytes(current.sysTotalBytes)} (${Math.round(current.sysUsedRatio * 100)} %, libre ${formatBytes(current.sysFreeBytes)}) — charge ${ramPressureLabel(current.sysUsedRatio, current.sysFreeBytes)}`,
    );
    lines.push(
      `Serveur MoonAgentic : RSS ${formatBytes(current.serverRssBytes)} · heap ${formatBytes(current.serverHeapUsedBytes)}`,
    );
    lines.push(
      `Stockage : base ${formatBytes(current.dbBytes)} · WAL ${formatBytes(current.walBytes)} · worktrees ${current.worktrees}`,
    );
    lines.push(
      `Boucle d'événements : p99 ${Math.round(current.eventLoopP99Ms)} ms · max fenêtre ${Math.round(current.eventLoopMaxMs)} ms · pic session ${Math.round(this.peakLagMs)} ms`,
    );
    lines.push(
      `Agents : ${current.runningTurns} tour${current.runningTurns > 1 ? "s" : ""} actif${current.runningTurns > 1 ? "s" : ""} · ${current.liveAgents} session${current.liveAgents > 1 ? "s" : ""} ouverte${current.liveAgents > 1 ? "s" : ""}${current.startingAgents > 0 ? ` · ${current.startingAgents} en démarrage` : ""} · RAM agents cumulée ${formatBytes(current.agentsTotalBytes)}`,
    );
    if (current.agents.length > 0) {
      for (const a of current.agents) {
        const label = a.model ? `${a.agentId} (${a.model})` : a.agentId;
        const state = a.running ? "au travail" : "en veille";
        const procs = a.processes > 0 ? `, ${a.processes} proc.` : "";
        lines.push(`  - ${label} : ${formatBytes(a.bytes)} (${state}${procs})`);
      }
    }

    lines.push("");
    lines.push("--- Pics observés depuis le démarrage (multi-agents / RAM) ---");
    if (this.peakMultiAgent) {
      lines.push(
        `Pic multi-agents (${localTime(this.peakMultiAgent.at)}) : ${formatSampleLine(this.peakMultiAgent, "")}`,
      );
    }
    if (this.peakRam) {
      lines.push(
        `Pic RAM système (${localTime(this.peakRam.at)}) : ${formatSampleLine(this.peakRam, "")}`,
      );
    }
    lines.push(
      `Pic RAM serveur : ${formatBytes(this.peakServerRssBytes)} · Pic RAM agents cumulée : ${formatBytes(this.peakAgentsBytes)} · Pic gel boucle : ${Math.round(this.peakLagMs)} ms`,
    );

    if (this.history.length > 1) {
      lines.push("");
      lines.push("--- Historique récent de charge ---");
      for (const s of this.history.slice(-15)) {
        lines.push(`${localTime(s.at)} ${formatSampleLine(s, "")}`);
      }
    }

    lines.push("");
    lines.push("--- Lenteurs et incidents serveur ---");
    if (this.slowEvents.length === 0) {
      lines.push("Aucun incident ou lenteur notable depuis le démarrage.");
    } else {
      for (const ev of this.slowEvents.slice(-20)) {
        const detail =
          locked && ev.kind === "agent-exit"
            ? `${ev.detail.split(":")[0]?.trim() ?? "agent"} : détails masqués (/lock)`
            : ev.detail;
        lines.push(`${localTime(ev.at)} [${ev.kind}] ${detail}`);
      }
    }

    lines.push("");
    lines.push("--- Erreurs côté interface (navigateur / téléphone) ---");
    if (this.clientErrors.length === 0) {
      lines.push("Aucune erreur interface signalée depuis le démarrage.");
    } else {
      for (const err of this.clientErrors.slice(-15)) {
        const route = err.route ? ` (${err.route})` : "";
        lines.push(`${localTime(err.at)} [${err.device} / ${err.source}]${route} ${err.message}`);
        if (err.stack) {
          const stackLines = err.stack.split("\n").slice(0, 6);
          for (const sl of stackLines) lines.push(`    ${sl}`);
        }
      }
    }

    lines.push("");
    lines.push("--- Extraits des journaux du jour ---");
    if (locked) {
      lines.push(
        "Journaux bruts masqués tant qu'un projet est verrouillé (/lock). Déverrouille tes projets si tu souhaites les inclure.",
      );
    } else {
      const day = localDay(generatedAt);
      const serverLog = readLogTail(path.join(this.options.logDir, `moonagentic-${day}.log`), 120);
      const desktopLog = readLogTail(path.join(this.options.logDir, `desktop-${day}.log`), 60);
      if (serverLog.length > 0) {
        lines.push(`[Serveur : moonagentic-${day}.log]`);
        lines.push(...serverLog);
      } else {
        lines.push(
          `[Serveur : aucun fichier moonagentic-${day}.log trouvé dans le dossier des journaux]`,
        );
      }
      if (desktopLog.length > 0) {
        lines.push("");
        lines.push(`[App de bureau : desktop-${day}.log]`);
        lines.push(...desktopLog);
      }
    }

    // Final redaction pass as defense-in-depth.
    const text = lines.map((line) => redact(line)).join("\n") + "\n";
    return { text, generatedAt };
  }
}
