import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentQuota, QuotaWindow, ServerMessage } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";
import { killTree, spawnPlan } from "./spawn.ts";

/** What a reader finds: the quota without the agent's id and the time, which are added here. */
export type QuotaReading = Omit<AgentQuota, "agentId" | "readAt">;
export type QuotaReader = () => Promise<QuotaReading>;

/** How often every quota is read again while MoonAgentic runs. */
const EVERY_MS = 5 * 60_000;
/** The shortest gap between two reads of one agent: after a turn, or when the user asks. */
const AFTER_TURN_GAP_MS = 60_000;
const ASKED_GAP_MS = 15_000;
const ASK_TIMEOUT_MS = 15_000;

const unreadable = (note: string, link?: string): QuotaReading => ({
  state: "unreadable",
  windows: [],
  extras: [],
  note,
  ...(link ? { link } : {}),
});

const clampPercent = (value: number) => Math.max(0, Math.round(value * 10) / 10);

/** A timestamp from seconds or milliseconds since 1970, or from an ISO date. */
export function toTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Claude Code: the usage its own `/usage` shows, asked with the sign-in it keeps on disk.
// The address is not documented by Anthropic: when it changes, the card says so.

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const CLAUDE_WINDOWS: { key: string; label: string; short: string }[] = [
  { key: "five_hour", label: "Session de 5 h", short: "5 h" },
  { key: "seven_day", label: "Semaine, tous modèles", short: "semaine" },
  { key: "seven_day_opus", label: "Semaine, Opus", short: "semaine Opus" },
  { key: "seven_day_sonnet", label: "Semaine, Sonnet", short: "semaine Sonnet" },
];

const CLAUDE_PLANS: Record<string, string> = {
  pro: "Abonnement Pro",
  max: "Abonnement Max",
  team: "Abonnement Team",
  enterprise: "Abonnement Enterprise",
};

/** Where Claude Code keeps its sign-in, when it keeps it in a file (not on macOS). */
export function claudeCredentialsPath(env = process.env, home = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), ".credentials.json");
}

/** Reads what Anthropic answered; exported for tests. */
export function parseClaudeUsage(body: unknown, plan?: string): QuotaReading {
  const data = (body ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  for (const w of CLAUDE_WINDOWS) {
    const entry = data[w.key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!entry || typeof entry.utilization !== "number") continue;
    const resetsAt = toTime(entry.resets_at);
    windows.push({
      label: w.label,
      short: w.short,
      usedPercent: clampPercent(entry.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const extras: { label: string; value: string }[] = [];
  const extra = data.extra_usage as { is_enabled?: unknown; utilization?: unknown } | undefined;
  if (extra && typeof extra.is_enabled === "boolean") {
    extras.push({
      label: "Crédits en plus",
      value: !extra.is_enabled
        ? "Désactivés"
        : typeof extra.utilization === "number"
          ? `${Math.round(extra.utilization)} % utilisés`
          : "Activés",
    });
  }
  if (!windows.length) return unreadable("Claude n'a renvoyé aucune limite pour ce compte.");
  return { state: "ok", ...(plan ? { plan } : {}), windows, extras };
}

export async function readClaudeQuota(
  file = claudeCredentialsPath(),
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<QuotaReading> {
  let oauth: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: typeof oauth };
    if (!saved.claudeAiOauth) {
      return {
        state: "none",
        windows: [],
        extras: [],
        note: "Claude Code passe par une clé d'API : payé à l'usage, pas de quota d'abonnement.",
      };
    }
    oauth = saved.claudeAiOauth;
  } catch {
    return unreadable(
      process.platform === "darwin"
        ? "Sur macOS, Claude Code garde sa connexion dans le trousseau : MoonAgentic ne la lit pas."
        : "Connexion de Claude Code introuvable : lance « claude » puis « /login » avec ton abonnement.",
    );
  }
  const token = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const expiresAt = toTime(oauth.expiresAt);
  if (!token || (expiresAt && expiresAt <= now)) {
    return unreadable(
      "La connexion de Claude Code a expiré : elle se renouvelle à sa prochaine réponse.",
    );
  }
  const type = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : "";
  const plan = CLAUDE_PLANS[type.toLowerCase()];
  let response: Response;
  try {
    response = await fetcher(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
  } catch {
    return unreadable("Claude n'a pas répondu : pas de réseau, ou trop lent.");
  }
  if (response.status === 401 || response.status === 403) {
    return unreadable(
      "La connexion de Claude Code a expiré : elle se renouvelle à sa prochaine réponse.",
    );
  }
  if (!response.ok)
    return unreadable(`Claude a refusé de donner ses limites (${response.status}).`);
  try {
    return parseClaudeUsage(await response.json(), plan);
  } catch {
    return unreadable("Claude a répondu dans une forme que MoonAgentic ne connaît pas.");
  }
}

// ---------------------------------------------------------------------------------------
// Codex: its own `codex app-server`, asked for the limits its `/status` shows.

const CODEX_PLANS: Record<string, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
};

/** Names a window from its length: 5 h and a week are the ones ChatGPT plans have. */
function codexWindowName(minutes: unknown, fallback: string): { label: string; short: string } {
  if (minutes === 300) return { label: "Session de 5 h", short: "5 h" };
  if (minutes === 10_080) return { label: "Semaine", short: "semaine" };
  if (typeof minutes === "number" && minutes > 0) {
    const short = minutes % 1440 === 0 ? `${minutes / 1440} j` : `${Math.round(minutes / 60)} h`;
    return { label: `Fenêtre de ${short}`, short };
  }
  return { label: fallback, short: fallback.toLowerCase() };
}

/** Reads the answers to `account/read` and `account/rateLimits/read`; exported for tests. */
export function parseCodexLimits(limits: unknown, account?: unknown): QuotaReading {
  const acc = ((account ?? {}) as { account?: { type?: unknown; planType?: unknown } }).account;
  if (acc?.type === "apiKey") {
    return {
      state: "none",
      windows: [],
      extras: [],
      note: "Codex passe par une clé d'API : payé à l'usage, pas de quota d'abonnement.",
    };
  }
  const result = (limits ?? {}) as {
    rateLimits?: Record<string, unknown>;
    rateLimitsByLimitId?: Record<string, Record<string, unknown>>;
  };
  const snapshot = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (!snapshot) return unreadable("Codex n'a renvoyé aucune limite pour ce compte.");
  const windows: QuotaWindow[] = [];
  for (const [key, fallback] of [
    ["primary", "Première limite"],
    ["secondary", "Seconde limite"],
  ] as const) {
    const w = snapshot[key] as
      | { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
      | null
      | undefined;
    if (!w || typeof w.usedPercent !== "number") continue;
    const resetsAt = toTime(w.resetsAt);
    windows.push({
      ...codexWindowName(w.windowDurationMins, fallback),
      usedPercent: clampPercent(w.usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const extras: { label: string; value: string }[] = [];
  const credits = snapshot.credits as
    { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined;
  if (credits?.unlimited === true) extras.push({ label: "Crédits", value: "Illimités" });
  else if (typeof credits?.balance === "string" && credits.balance)
    extras.push({ label: "Crédits", value: credits.balance });
  const planType = snapshot.planType ?? acc?.planType;
  const plan = typeof planType === "string" ? CODEX_PLANS[planType.toLowerCase()] : undefined;
  if (!windows.length) return unreadable("Codex n'a renvoyé aucune limite pour ce compte.");
  return { state: "ok", ...(plan ? { plan } : {}), windows, extras };
}

/**
 * The `codex` command. npm puts a `.cmd` on Windows; its script is run with this Node instead
 * when it is where npm leaves it, so no command line goes through cmd.exe.
 */
export function findCodex(): { command: string; args: string[] } | undefined {
  const found = findOnPath("codex");
  if (!found) return undefined;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    const script = path.join(
      path.dirname(found),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (existsSync(script)) return { command: process.execPath, args: [script] };
  }
  return { command: found, args: [] };
}

/** Asks `codex app-server` a few JSON-RPC questions, one JSON object per line. */
export function askCodex(
  codex: { command: string; args: string[] },
  methods: string[],
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const plan = spawnPlan(codex.command, [...codex.args, "app-server"]);
    const child = spawn(plan.command, plan.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const answers: Record<string, unknown> = {};
    let left = methods.length;
    let buffer = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void killTree(child, "SIGKILL");
      if (error) reject(error);
      else resolve(answers);
    };
    const timer = setTimeout(() => finish(new Error("Codex n'a pas répondu à temps.")), timeoutMs);
    child.on("error", (error) => finish(error));
    child.on("exit", () =>
      finish(left ? new Error("Codex s'est arrêté sans répondre.") : undefined),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (typeof message.id !== "number" || message.id === 0) continue;
        const method = methods[message.id - 1];
        if (!method || method in answers) continue;
        if (message.error) {
          const why = typeof message.error.message === "string" ? message.error.message : "";
          return finish(new Error(why || `Codex a refusé ${method}.`));
        }
        answers[method] = message.result;
        if (--left === 0) finish();
      }
    });
    const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("error", () => {});
    write({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "moonagentic", title: "MoonAgentic", version: "0.0.0" } },
    });
    write({ method: "initialized" });
    methods.forEach((method, i) => write({ method, id: i + 1 }));
  });
}

export async function readCodexQuota(
  codex = findCodex(),
  ask: typeof askCodex = askCodex,
): Promise<QuotaReading> {
  if (!codex) {
    return unreadable("Commande codex introuvable : installe Codex CLI pour lire ses limites.");
  }
  try {
    const answers = await ask(codex, ["account/read", "account/rateLimits/read"]);
    return parseCodexLimits(answers["account/rateLimits/read"], answers["account/read"]);
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return unreadable(`Codex n'a pas donné ses limites : ${why}`);
  }
}

// ---------------------------------------------------------------------------------------

/** The agents whose figures cannot be read, and why, in words for the user. */
const FIXED: Record<string, QuotaReading> = {
  antigravity: unreadable(
    "Antigravity n'affiche ses limites que dans son terminal (« /usage » dans agy) : MoonAgentic ne sait pas encore les lire.",
  ),
  cursor: unreadable(
    "Cursor ne donne pas ses compteurs en dehors de son site.",
    "https://cursor.com/settings",
  ),
  hermes: {
    state: "none",
    windows: [],
    extras: [],
    note: "Hermes paie à l'usage avec ta clé de fournisseur : il n'y a pas de quota d'abonnement à suivre.",
  },
};

/** The demo agents' figures, for tests and trying the screen: shown only with --demo. */
const demoReading = (): QuotaReading => {
  const hour = 3_600_000;
  return {
    state: "ok",
    plan: "Agent de démo",
    windows: [
      { label: "Session de 5 h", short: "5 h", usedPercent: 86, resetsAt: Date.now() + 2 * hour },
      { label: "Semaine", short: "semaine", usedPercent: 31, resetsAt: Date.now() + 80 * hour },
    ],
    extras: [],
  };
};

export function defaultReaders(options: { demo: boolean }): Record<string, QuotaReader> {
  const readers: Record<string, QuotaReader> = {
    claude: () => readClaudeQuota(),
    codex: () => readCodexQuota(),
  };
  for (const [id, reading] of Object.entries(FIXED)) readers[id] = () => Promise.resolve(reading);
  if (options.demo) {
    readers.demo = () => Promise.resolve(demoReading());
    readers["demo-2"] = () =>
      Promise.resolve({ ...demoReading(), windows: [demoReading().windows[1]!] });
  }
  return readers;
}

/**
 * Each agent's subscription quotas, read again every few minutes, after a turn, and when the
 * user asks; every client gets them as they change.
 */
export class Quotas {
  private readonly readers: Record<string, QuotaReader>;
  private readonly available: () => string[];
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly now: () => number;
  private readonly known = new Map<string, AgentQuota>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly lastAsked = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: {
    readers: Record<string, QuotaReader>;
    /** The agents installed now. */
    available: () => string[];
    broadcast: (message: ServerMessage) => void;
    now?: () => number;
  }) {
    this.readers = options.readers;
    this.available = options.available;
    this.broadcast = options.broadcast;
    this.now = options.now ?? Date.now;
  }

  /** Reads every quota now, then again every `everyMs`. */
  start(everyMs = EVERY_MS): void {
    void this.refresh();
    if (everyMs > 0) {
      this.timer = setInterval(() => void this.refresh(), everyMs);
      this.timer.unref();
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  /** The quotas of the installed agents that have a reader, in the agents' order. */
  list(): AgentQuota[] {
    return this.wanted().flatMap((id) => {
      const quota = this.known.get(id);
      return quota ? [quota] : [];
    });
  }

  /**
   * Reads again the quota of one agent, or of all; `gapMs` skips an agent read more recently
   * than that. Resolves once the new figures are sent.
   */
  async refresh(agentId?: string, gapMs = 0): Promise<void> {
    const ids = this.wanted().filter((id) => !agentId || id === agentId);
    await Promise.all(ids.map((id) => this.read(id, gapMs)));
  }

  /** After a turn: the agent's figures have likely moved. */
  afterTurn(agentId: string): void {
    if (agentId in this.readers) void this.refresh(agentId, AFTER_TURN_GAP_MS);
  }

  /** When the user asks: not more often than every few seconds. */
  asked(agentId?: string): Promise<void> {
    return this.refresh(agentId, ASKED_GAP_MS);
  }

  private wanted(): string[] {
    return this.available().filter((id) => id in this.readers);
  }

  private read(id: string, gapMs: number): Promise<void> {
    const running = this.reading.get(id);
    if (running) return running;
    const last = this.lastAsked.get(id);
    if (last !== undefined && this.now() - last < gapMs) return Promise.resolve();
    this.lastAsked.set(id, this.now());
    const reader = this.readers[id]!;
    const done = reader()
      .catch((error: unknown) =>
        unreadable(
          `Lecture impossible : ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .then((reading) => {
        if (this.closed) return;
        this.known.set(id, { agentId: id, ...reading, readAt: this.now() });
        this.broadcast({ type: "quotas", quotas: this.list() });
      })
      .finally(() => this.reading.delete(id));
    this.reading.set(id, done);
    return done;
  }
}
