// The black box: what the computer looked like minute by minute, kept by the desktop shell so
// that after a freeze, a restart or a power cut the next start can say what happened. It keeps
// the last hour of measures in `boite-noire.json`, writes what it notices to `boite-noire.log`,
// and at each start compares the last sign of life with when Windows started. Never throws.
import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { redact } from "./redact.ts";

/** Measures kept: one a minute, the last hour. */
export const KEPT_SAMPLES = 60;
/** How often the box takes a measure and writes itself. */
export const SAMPLE_EVERY_MS = 60_000;
/** A measure this late means nothing ran: the computer slept, froze, or MoonAgentic hung. */
export const SILENCE_MS = 5 * 60_000;
/** The journal is set aside past this size, so it never fills the disk. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Free memory under this share of the total: the computer is about to stall. */
export const LOW_MEMORY = 0.1;
/** Free memory under this share: the biggest programs are written down. */
export const WATCH_MEMORY = 0.15;
/** The processor this busy on three measures in a row is saturated. */
export const BUSY_CPU = 90;
/** Free disk space under this is noted. */
export const LOW_DISK = 2 * 1024 ** 3;
/** The measures this close to the end say what led to it. */
const RECENT_MS = 15 * 60_000;
/** Two readings of when Windows started differ by this much at most for the same start. */
const BOOT_SLACK_MS = 60_000;
/** The biggest programs are not listed again before this. */
const TOP_EVERY_MS = 5 * 60_000;

export const BOX_FILE = "boite-noire.json";
export const BOX_LOG = "boite-noire.log";

export interface TopProcess {
  name: string;
  /** Bytes of memory it holds. */
  mem: number;
}

/** One minute of the computer. */
export interface Sample {
  at: number;
  freeMem: number;
  totalMem: number;
  /** Share of the processor used since the last measure, 0 to 100. */
  cpu?: number;
  diskFree?: number;
  /** The computer's own network addresses (IPv4, not loopback). */
  net: string[];
  /** Whether the internet answered: the local network can stay up without it. */
  internet?: boolean;
  /** Where the server stands: ready, restarting, failed… */
  server: string;
  /** The biggest programs, listed when memory runs low. */
  top?: TopProcess[];
}

export type SampleInput = Omit<Sample, "at" | "top" | "internet">;

/** What the box keeps on disk between two runs. */
export interface BoxState {
  version: string;
  pid: number;
  startedAt: number;
  /** When Windows (the computer) last started, as seen by this run. */
  bootAt: number;
  /** The last sign of life. */
  lastAt: number;
  samples: Sample[];
  /** Set when MoonAgentic ended on purpose, with why. */
  stop?: { at: number; reason: string };
  /** An update launched from this run: to which version, and when. */
  updating?: { to: string; at: number };
}

export interface BlackBoxOptions {
  dir: string;
  version: string;
  sample: () => SampleInput;
  /** The biggest programs on the computer, when memory runs low. */
  topProcesses?: () => Promise<TopProcess[]>;
  /** Whether the internet answers now. */
  online?: () => Promise<boolean>;
  pid?: number;
  now?: () => number;
  /** When the computer started. */
  bootAt?: () => number;
}

/** What the start found about the run before it. */
export interface Opening {
  report: string[];
  /** The run before ended without saying so: the time span to look at in Windows' own log. */
  unexpected?: { from: number; to: number; focus: number };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** HH:MM:SS, in this computer's time. */
export const clock = (at: number) => {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
/** DD/MM HH:MM:SS, in this computer's time. */
export const dateClock = (at: number) => {
  const d = new Date(at);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${clock(at)}`;
};
const stamp = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(at)}`;
};

/** A duration as people say it: « 45 s », « 12 min », « 3 h 05 ». */
export function lasted(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad2(min % 60)}`;
}

/** Bytes as « 1,2 Go » or « 640 Mo ». */
export function size(bytes: number): string {
  const go = bytes / 1024 ** 3;
  if (go >= 1) return `${go.toFixed(1).replace(".", ",")} Go`;
  return `${Math.round(bytes / 1024 ** 2)} Mo`;
}

/** Tailscale gives each computer an address in 100.64.0.0/10. */
export function isTailscale(address: string): boolean {
  const m = /^100\.(\d+)\./.exec(address);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

const freeShare = (s: Sample) => (s.totalMem > 0 ? s.freeMem / s.totalMem : 1);

/** One measure on one line. */
export function sampleLine(s: Sample): string {
  const parts = [
    `RAM libre ${size(s.freeMem)} sur ${size(s.totalMem)} (${Math.round(freeShare(s) * 100)} %)`,
  ];
  if (s.cpu !== undefined) parts.push(`processeur ${Math.round(s.cpu)} %`);
  if (s.diskFree !== undefined) parts.push(`disque libre ${size(s.diskFree)}`);
  const tail = s.net.filter(isTailscale);
  const lan = s.net.filter((a) => !isTailscale(a));
  parts.push(
    s.net.length === 0
      ? "aucun réseau"
      : `réseau ${[...lan, ...tail.map((a) => `Tailscale ${a}`)].join(", ")}`,
  );
  if (s.internet === false) parts.push("internet coupé");
  parts.push(`serveur ${s.server}`);
  let line = `${clock(s.at)} · ${parts.join(" · ")}`;
  if (s.top?.length) {
    line += ` · plus gros : ${s.top.map((p) => `${p.name} ${size(p.mem)}`).join(", ")}`;
  }
  return line;
}

/** What the last measures say, in a few words each: memory full, processor saturated… */
export function warningSigns(samples: Sample[]): string[] {
  const signs: string[] = [];
  const last = samples.at(-1);
  if (!last) return signs;
  // The lowest memory of the last 15 minutes says what led to the end; an older low that
  // passed is named apart, so it is not taken for the cause.
  const lowest = (list: Sample[]) =>
    list.reduce<Sample | undefined>(
      (min, s) => (!min || freeShare(s) < freeShare(min) ? s : min),
      undefined,
    );
  const recent = samples.filter((s) => s.at >= last.at - RECENT_MS);
  const lowNow = lowest(recent);
  const lowBefore = lowest(samples.filter((s) => s.at < last.at - RECENT_MS));
  const pct = (s: Sample) => Math.round(freeShare(s) * 100);
  if (lowNow && freeShare(lowNow) < LOW_MEMORY) {
    signs.push(`mémoire presque pleine (${pct(lowNow)} % libre à ${clock(lowNow.at)})`);
  } else if (lowBefore && freeShare(lowBefore) < LOW_MEMORY) {
    signs.push(
      `mémoire presque pleine plus tôt (${pct(lowBefore)} % libre à ${clock(lowBefore.at)}), revenue à ${pct(last)} % à la fin`,
    );
  }
  let run = 0;
  let since: number | undefined;
  for (const s of samples) {
    if ((s.cpu ?? 0) >= BUSY_CPU) {
      run += 1;
      since ??= s.at;
    } else {
      run = 0;
      since = undefined;
    }
  }
  if (run >= 3 && since !== undefined) signs.push(`processeur saturé depuis ${clock(since)}`);
  if (last.diskFree !== undefined && last.diskFree < LOW_DISK) {
    signs.push(`disque presque plein (${size(last.diskFree)} libres)`);
  }
  if (last.net.length === 0) {
    const lost = [...samples].reverse().find((s) => s.net.length > 0);
    signs.push(lost ? `plus aucun réseau après ${clock(lost.at)}` : "aucun réseau");
  } else if (!last.net.some(isTailscale) && samples.some((s) => s.net.some(isTailscale))) {
    signs.push("Tailscale avait perdu son adresse");
  }
  if (last.net.length > 0 && last.internet === false) {
    const up = [...samples].reverse().find((s) => s.internet === true);
    signs.push(up ? `internet coupé après ${clock(up.at)}` : "internet coupé");
  }
  if (last.server !== "prêt" && last.server !== "ready") signs.push(`serveur ${last.server}`);
  return signs;
}

/**
 * What the run before says about how it ended. Its last sign of life is compared with when the
 * computer started: after it, Windows restarted (a freeze, a power cut, an update of Windows);
 * before it, MoonAgentic alone stopped.
 */
export function explainPrevious(
  prev: BoxState | undefined,
  now: { at: number; bootAt: number; version: string },
): Opening {
  const report: string[] = [];
  if (!prev) {
    report.push("Première mise en route de la boîte noire : rien à comparer.");
    return { report };
  }
  const updatedLine = () => {
    if (!prev.updating) return;
    if (prev.version !== now.version) {
      report.push(
        `Mise à jour de ${prev.version} vers ${now.version} réussie : lancée à ${dateClock(prev.updating.at)}, MoonAgentic reparti ${lasted(now.at - prev.updating.at)} après.`,
      );
    } else {
      report.push(
        `La mise à jour vers ${prev.updating.to} lancée à ${dateClock(prev.updating.at)} n'a pas remplacé l'app : toujours ${now.version}.`,
      );
    }
  };
  if (prev.stop) {
    report.push(
      `Arrêt précédent normal à ${dateClock(prev.stop.at)} (${prev.stop.reason}), version ${prev.version}.`,
    );
    updatedLine();
    return { report };
  }
  // Windows started again when its start time moved: the box written by the run before holds
  // the start time it saw. Its last sign of life must also come before that new start (a
  // minute of slack: the start is known to the second, the box to the minute).
  const sameBoot =
    typeof prev.bootAt === "number" && Math.abs(now.bootAt - prev.bootAt) <= BOOT_SLACK_MS;
  const windowsRestarted = !sameBoot && now.bootAt > prev.lastAt - BOOT_SLACK_MS;
  report.push(
    windowsRestarted
      ? "Arrêt précédent INATTENDU : Windows a redémarré sans que MoonAgentic soit prévenu (gel, coupure de courant, bouton maintenu, écran bleu ou redémarrage forcé)."
      : "Arrêt précédent INATTENDU : MoonAgentic s'est arrêté seul, Windows a continué de tourner.",
  );
  report.push(`  Dernier signe de vie : ${dateClock(prev.lastAt)} (version ${prev.version}).`);
  if (windowsRestarted) {
    report.push(
      `  Windows reparti : ${dateClock(now.bootAt)}, soit ${lasted(now.bootAt - prev.lastAt)} sans signe de vie avant le redémarrage.`,
    );
  }
  if (prev.updating) {
    report.push(
      `  Une mise à jour vers ${prev.updating.to} était lancée depuis ${dateClock(prev.updating.at)}.`,
    );
    updatedLine();
  }
  const last = prev.samples.slice(-5);
  if (last.length) {
    report.push("  Dernières mesures :");
    for (const s of last) report.push(`    ${sampleLine(s)}`);
  }
  const signs = warningSigns(prev.samples);
  report.push(
    signs.length
      ? `  Signes relevés : ${signs.join(" ; ")}.`
      : "  Rien d'anormal dans les dernières mesures : le blocage est venu d'un coup.",
  );
  // From a little before the last sign of life to now, three days at most.
  const from = Math.max(prev.lastAt - 15 * 60_000, now.at - 3 * 24 * 3600_000);
  return { report, unexpected: { from, to: now.at, focus: prev.lastAt } };
}

/** What happened between two measures, in the journal's words. */
export function compare(prev: Sample | undefined, next: Sample, slept: boolean): string[] {
  const lines: string[] = [];
  if (!prev) return lines;
  const gap = next.at - prev.at;
  if (gap > SILENCE_MS) {
    lines.push(
      slept
        ? `Aucune mesure pendant ${lasted(gap)} (${clock(prev.at)} → ${clock(next.at)}) : l'ordinateur était en veille.`
        : `Aucune mesure pendant ${lasted(gap)} (${clock(prev.at)} → ${clock(next.at)}) sans mise en veille : Windows ou MoonAgentic était figé.`,
    );
  }
  const hadTail = prev.net.some(isTailscale);
  const hasTail = next.net.some(isTailscale);
  if (prev.net.length > 0 && next.net.length === 0) lines.push("Plus aucun réseau.");
  else if (prev.net.length === 0 && next.net.length > 0) {
    lines.push(`Réseau revenu : ${next.net.join(", ")}.`);
  }
  if (hadTail && !hasTail && next.net.length > 0) lines.push("Tailscale a perdu son adresse.");
  if (!hadTail && hasTail && prev.net.length > 0) lines.push("Tailscale a retrouvé son adresse.");
  const wasLow = freeShare(prev) < LOW_MEMORY;
  const isLow = freeShare(next) < LOW_MEMORY;
  if (!wasLow && isLow) lines.push(`Mémoire presque pleine : ${sampleLine(next)}`);
  if (wasLow && !isLow) lines.push(`Mémoire de nouveau disponible : ${size(next.freeMem)} libres.`);
  if (prev.internet === true && next.internet === false) {
    lines.push("Internet coupé : le réseau local reste là, mais rien ne répond au-dehors.");
  }
  if (prev.internet === false && next.internet === true) lines.push("Internet revenu.");
  if (prev.server !== next.server) lines.push(`Serveur : ${prev.server} → ${next.server}.`);
  return lines;
}

export class BlackBox {
  private readonly options: BlackBoxOptions;
  private readonly now: () => number;
  private state: BoxState | undefined;
  private slept = false;
  private busyRun = 0;
  private topAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(options: BlackBoxOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get file(): string {
    return path.join(this.options.dir, BOX_FILE);
  }

  get logFile(): string {
    return path.join(this.options.dir, BOX_LOG);
  }

  /** Reads how the run before ended, writes it down, and starts this run's box. */
  open(): Opening {
    const at = this.now();
    const bootAt = this.options.bootAt?.() ?? at - os.uptime() * 1000;
    const opening = explainPrevious(this.read(), { at, bootAt, version: this.options.version });
    this.log([
      `=== MoonAgentic ${this.options.version} démarre (Windows démarré à ${dateClock(bootAt)}) ===`,
      ...opening.report,
    ]);
    this.state = {
      version: this.options.version,
      pid: this.options.pid ?? process.pid,
      startedAt: at,
      bootAt,
      lastAt: at,
      samples: [],
    };
    this.save();
    return opening;
  }

  /** Takes a measure every minute until `close`. */
  run(every = SAMPLE_EVERY_MS): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
  }

  /** One measure: compared with the last one, then kept. */
  async tick(): Promise<void> {
    if (!this.state || this.state.stop || this.ticking) return;
    this.ticking = true;
    try {
      let input: SampleInput;
      try {
        input = this.options.sample();
      } catch {
        return;
      }
      const sample: Sample = { ...input, at: this.now() };
      // Stopped while the processor or the internet was being asked: nothing more is written.
      const stopped = () => !this.state || !!this.state.stop;
      if (this.options.online && input.net.length > 0) {
        sample.internet = await this.options.online().catch(() => false);
        if (stopped()) return;
      }
      if (
        freeShare(sample) < WATCH_MEMORY &&
        this.options.topProcesses &&
        sample.at - this.topAt >= TOP_EVERY_MS
      ) {
        this.topAt = sample.at;
        const top = await this.options.topProcesses().catch(() => []);
        if (top.length) sample.top = top.slice(0, 5);
      }
      if (stopped()) return;
      const lines = compare(this.state.samples.at(-1), sample, this.slept);
      this.slept = false;
      this.busyRun = (sample.cpu ?? 0) >= BUSY_CPU ? this.busyRun + 1 : 0;
      if (this.busyRun === 3) lines.push(`Processeur saturé depuis 3 min : ${sampleLine(sample)}`);
      if (sample.top && !lines.some((l) => l.startsWith("Mémoire presque pleine"))) {
        lines.push(`Mémoire basse : ${sampleLine(sample)}`);
      }
      if (lines.length) this.log(lines);
      this.state.samples = [...this.state.samples, sample].slice(-KEPT_SAMPLES);
      this.state.lastAt = sample.at;
      this.save();
    } finally {
      this.ticking = false;
    }
  }

  /** Something the computer said: going to sleep, waking up, the screen locked… */
  note(text: string, sleeping = false): void {
    if (sleeping) this.slept = true;
    this.log([text]);
    if (this.state) {
      this.state.lastAt = this.now();
      this.save();
    }
  }

  /** An update is about to replace the app. */
  updating(to: string): void {
    if (!this.state) return;
    this.state.updating = { to, at: this.now() };
    this.log([`Mise à jour vers ${to} lancée : MoonAgentic s'arrête pour l'installeur.`]);
    this.save();
  }

  /** The installer could not start: the app stays as it is, no update is under way. */
  updateFailed(reason: string): void {
    if (!this.state?.updating) return;
    this.log([`Mise à jour vers ${this.state.updating.to} abandonnée : ${reason}`]);
    delete this.state.updating;
    this.save();
  }

  /** MoonAgentic ends on purpose: the first reason given stays. */
  stop(reason: string): void {
    if (!this.state || this.state.stop) return;
    this.close();
    const at = this.now();
    this.state.stop = { at, reason };
    this.state.lastAt = at;
    this.log([`Arrêt normal : ${reason}.`]);
    this.save();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Lines written under the last start's report, e.g. what Windows' own log says. */
  append(lines: string[]): void {
    if (lines.length) this.log(lines);
  }

  private read(): BoxState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BoxState>;
      if (
        typeof raw.version !== "string" ||
        typeof raw.lastAt !== "number" ||
        !Array.isArray(raw.samples)
      ) {
        return undefined;
      }
      return raw as BoxState;
    } catch {
      return undefined;
    }
  }

  private save(): void {
    if (!this.state) return;
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const text = JSON.stringify(this.state);
      const tmp = `${this.file}.tmp`;
      try {
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch {
        // Windows can refuse the rename while something reads the file: written in place.
        writeFileSync(this.file, text, { mode: 0o600 });
        rmSync(tmp, { force: true });
      }
    } catch {
      // The box must never stop the app.
    }
  }

  private log(lines: string[]): void {
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.logFile).size > MAX_LOG_BYTES) {
          renameSync(this.logFile, path.join(this.options.dir, "boite-noire.ancien.log"));
        }
      } catch {
        // No journal yet.
      }
      const at = stamp(this.now());
      appendFileSync(this.logFile, lines.map((l) => `${at} ${redact(l)}\n`).join(""), {
        mode: 0o600,
      });
    } catch {
      // Never stop the app for its journal.
    }
  }
}

/** The processor's busy share between two calls, from the time each core spent. */
export function cpuMeter(read: () => os.CpuInfo[] = os.cpus): () => number | undefined {
  const totals = () => {
    let idle = 0;
    let total = 0;
    for (const c of read()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  };
  let last = totals();
  return () => {
    const next = totals();
    const total = next.total - last.total;
    const idle = next.idle - last.idle;
    last = next;
    return total > 0 ? Math.min(100, Math.max(0, (1 - idle / total) * 100)) : undefined;
  };
}

/** What `reachable` needs of a socket: the events it listens to, and to end it. */
export interface Probe {
  once(event: "connect" | "timeout", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
}

/**
 * Whether one of these hosts takes a connection within `timeoutMs`. Once one does, or all
 * failed, every connection still open is ended; each one counts once, whatever it reports.
 */
export function reachable(
  hosts: { host: string; port: number }[] = [
    { host: "1.1.1.1", port: 443 },
    { host: "8.8.8.8", port: 443 },
  ],
  timeoutMs = 4_000,
  open: (to: { host: string; port: number; timeout: number }) => Probe = connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!hosts.length) {
      resolve(false);
      return;
    }
    const probes: Probe[] = [];
    let left = hosts.length;
    let done = false;
    const finish = (ok: boolean) => {
      done = true;
      for (const p of probes) p.destroy();
      resolve(ok);
    };
    for (const { host, port } of hosts) {
      const probe = open({ host, port, timeout: timeoutMs });
      probes.push(probe);
      let settled = false;
      const end = (ok: boolean) => {
        if (settled || done) return;
        settled = true;
        if (ok) finish(true);
        else if (--left <= 0) finish(false);
      };
      probe.once("connect", () => end(true));
      probe.once("timeout", () => end(false));
      probe.once("error", () => end(false));
    }
  });
}

/** The computer's own IPv4 addresses, loopback left out. */
export function addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (!i.internal && i.family === "IPv4") out.push(i.address);
    }
  }
  return out;
}

/** A measure of this computer, the data folder's disk included. */
export function systemSampler(dataDir: string, server: () => string): () => SampleInput {
  const cpu = cpuMeter();
  return () => {
    let diskFree: number | undefined;
    try {
      const s = statfsSync(dataDir);
      diskFree = Number(s.bavail) * Number(s.bsize);
    } catch {
      diskFree = undefined;
    }
    const busy = cpu();
    return {
      freeMem: os.freemem(),
      totalMem: os.totalmem(),
      ...(busy !== undefined ? { cpu: busy } : {}),
      ...(diskFree !== undefined ? { diskFree } : {}),
      net: addresses(),
      server: server(),
    };
  };
}

/**
 * `tasklist /fo csv /nh` read: name and memory of each program, the biggest first. The memory
 * column is written the Windows way of the user's language (« 1 234 567 Ko », « 1,234,567 K »).
 */
export function parseTasklist(output: string): TopProcess[] {
  const byName = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    if (cells.length < 5) continue;
    const kb = Number((cells[4] ?? "").replace(/\D/g, ""));
    if (!cells[0] || !Number.isFinite(kb) || kb <= 0) continue;
    byName.set(cells[0], (byName.get(cells[0]) ?? 0) + kb * 1024);
  }
  return [...byName.entries()].map(([name, mem]) => ({ name, mem })).sort((a, b) => b.mem - a.mem);
}

/** The biggest programs on Windows, each name summed over its processes. */
export function windowsTopProcesses(): Promise<TopProcess[]> {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/fo", "csv", "/nh"],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseTasklist(stdout).slice(0, 5)),
    );
  });
}

/** Windows events that say how a computer stopped, by « provider:id ». */
export const KNOWN_EVENTS: Record<string, string> = {
  "Microsoft-Windows-Kernel-Power:41":
    "redémarrage sans arrêt propre (gel, coupure de courant ou bouton maintenu)",
  "EventLog:6008": "l'arrêt précédent était inattendu",
  "EventLog:6005": "Windows démarre",
  "EventLog:6006": "Windows s'arrête proprement",
  "User32:1074": "redémarrage ou arrêt demandé par un programme",
  "Microsoft-Windows-WER-SystemErrorReporting:1001": "écran bleu (BugCheck)",
  "BugCheck:1001": "écran bleu (BugCheck)",
  "Microsoft-Windows-Resource-Exhaustion-Detector:2004": "mémoire virtuelle presque épuisée",
  "Microsoft-Windows-Kernel-Power:42": "mise en veille",
  "Microsoft-Windows-Kernel-Power:107": "sortie de veille",
  "Microsoft-Windows-Power-Troubleshooter:1": "sortie de veille",
  "Microsoft-Windows-WindowsUpdateClient:19": "mise à jour Windows installée",
  "Microsoft-Windows-WindowsUpdateClient:20": "mise à jour Windows en échec",
  "Microsoft-Windows-WindowsUpdateClient:43": "installation d'une mise à jour Windows",
};

const KNOWN_IDS = [41, 6008, 6005, 6006, 1074, 1001, 2004, 42, 107, 1, 19, 20, 43];

/**
 * The PowerShell that lists, from Windows' System log, what happened between two times:
 * errors and warnings, and the events of {@link KNOWN_EVENTS}. Times are numbers: nothing
 * else reaches the script.
 */
export function windowsEventsScript(from: number, to: number): string {
  const iso = (at: number) => new Date(Math.round(at)).toISOString();
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$from = [datetime]::Parse('${iso(from)}').ToLocalTime()`,
    `$to = [datetime]::Parse('${iso(to)}').ToLocalTime()`,
    `$ids = @(${KNOWN_IDS.join(",")})`,
    // The known events by their ids, and the errors and warnings, each asked of the event log
    // with its own filter (fast, and nothing else in the way): the known ones all, the others
    // the oldest and the latest 200, so a long night cannot push the moment of the freeze out.
    "$known = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = $ids; StartTime = $from; EndTime = $to }",
    "$bad = @(Get-WinEvent -Oldest -FilterHashtable @{ LogName = 'System'; Level = 1,2,3; StartTime = $from; EndTime = $to })",
    "$bad = if ($bad.Count -gt 400) { $bad[0..199] + $bad[($bad.Count - 200)..($bad.Count - 1)] } else { $bad }",
    "$events = @($known) + @($bad) | Sort-Object RecordId -Unique",
    "@($events | ForEach-Object { [pscustomobject]@{",
    "  at = $_.TimeCreated.ToUniversalTime().ToString('o');",
    "  id = $_.Id; provider = $_.ProviderName; level = $_.Level;",
    '  message = ("$($_.Message)" -split "`r?`n")[0] } }) | ConvertTo-Json -Compress',
  ].join("\n");
}

const LEVELS: Record<number, string> = { 1: "critique", 2: "erreur", 3: "avertissement" };

/** Windows' events as journal lines, oldest first, the known ones named. */
export function parseWindowsEvents(json: string, max = 60, focus?: number): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json.trim() || "[]");
  } catch {
    return [];
  }
  const list = (Array.isArray(raw) ? raw : [raw]).filter(
    (e): e is { at: string; id: number; provider: string; level: number; message?: string } =>
      !!e && typeof e === "object" && typeof (e as { at?: unknown }).at === "string",
  );
  const events = list
    .map((e) => ({ ...e, time: Date.parse(e.at) }))
    .filter((e) => Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
  const known = (e: { provider: string; id: number }) => KNOWN_EVENTS[`${e.provider}:${e.id}`];
  // Known events always shown; the others fill what is left, the nearest to the moment looked
  // at first (the last sign of life), or the latest without one.
  const keep = new Set(events.filter(known));
  const order =
    focus === undefined
      ? [...events].reverse()
      : [...events].sort((a, b) => Math.abs(a.time - focus) - Math.abs(b.time - focus));
  for (const e of order) {
    if (keep.size >= max) break;
    keep.add(e);
  }
  return events
    .filter((e) => keep.has(e))
    .map((e) => {
      const name = known(e);
      const level = LEVELS[e.level] ? ` [${LEVELS[e.level]}]` : "";
      const message = (e.message ?? "").trim().slice(0, 240);
      const short = e.provider.replace(/^Microsoft-Windows-/, "");
      return `    ${dateClock(e.time)} ${short} ${e.id}${level} · ${name ?? message}${
        name && message ? ` — ${message}` : ""
      }`;
    });
}

/** What Windows' System log says between two times, as journal lines. */
export function windowsEvents(from: number, to: number, focus?: number): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsEventsScript(from, to)],
      { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve([`  Journal de Windows illisible : ${error.message.split("\n")[0]}`]);
          return;
        }
        const lines = parseWindowsEvents(stdout, 60, focus);
        resolve([
          `  Journal de Windows (${dateClock(from)} → ${dateClock(to)}) :`,
          ...(lines.length ? lines : ["    aucun événement notable."]),
        ]);
      },
    );
  });
}
