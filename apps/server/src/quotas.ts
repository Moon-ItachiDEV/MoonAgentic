import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentQuota, QuotaWindow, ServerMessage } from "@moonagentic/protocol";
import { findOnPath } from "./agents.ts";
import { killTree, spawnPlan } from "./spawn.ts";

/** What a reader finds: the quota without the agent's id and the time, which are added here. */
export type QuotaReading = Omit<AgentQuota, "agentId" | "readAt"> & {
  /**
   * Temporary failure (network blip, timeout, 429): previous valid figures, if any, are kept
   * instead of being wiped by an unreadable card.
   */
  transient?: boolean;
  /** Minimum delay before polling this agent again automatically (e.g. after a 429). */
  retryAfterMs?: number;
};
export type QuotaReader = (signal?: AbortSignal) => Promise<QuotaReading>;

/** How often every quota is read again while MoonAgentic runs with a client open. */
const EVERY_MS = 5 * 60_000;
/** The shortest gap between two reads of one agent: after a turn, or when the user asks. */
const AFTER_TURN_GAP_MS = 60_000;
const ASKED_GAP_MS = 15_000;
const ASK_TIMEOUT_MS = 15_000;
/** Grace period for `codex app-server` to exit cleanly on EOF before forcing termination. */
const CODEX_EXIT_GRACE_MS = 1_500;
/** Base and ceiling backoffs when an undocumented endpoint rate-limits us (HTTP 429). */
const RATE_LIMIT_BASE_BACKOFF_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** Maximum bytes of stderr retained from `codex app-server` for diagnostics. */
const MAX_STDERR_CHARS = 4_096;

class TransientError extends Error {}

/** Codex answered one request with an error: the other answers still count. */
export class CodexRequestError extends Error {}

const unreadable = (
  note: string,
  extra?: { link?: string; fixed?: boolean; transient?: boolean; retryAfterMs?: number },
): QuotaReading => ({
  state: "unreadable",
  windows: [],
  extras: [],
  note,
  ...(extra?.link ? { link: extra.link } : {}),
  ...(extra?.fixed ? { fixed: true } : {}),
  ...(extra?.transient ? { transient: true } : {}),
  ...(extra?.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
});

const clampPercent = (value: number) => Math.max(0, Math.round(value * 10) / 10);

const lastNonEmptyLine = (text: string): string => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
};

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
// Claude Code: the figures behind its own `/usage`, asked of Claude Code itself through the
// official Agent SDK. Claude Code reads and renews its own sign-in (file, macOS keychain or
// CLAUDE_CODE_OAUTH_TOKEN): MoonAgentic never touches it. No prompt is ever sent, so asking
// costs nothing. The SDK marks this call experimental: when it changes, the card says so.

const CLAUDE_WINDOWS: { key: string; label: string; short: string; model?: string }[] = [
  { key: "five_hour", label: "Session de 5 h", short: "5 h" },
  { key: "seven_day", label: "Semaine, tous modèles", short: "semaine" },
  { key: "seven_day_opus", label: "Semaine, Opus", short: "semaine Opus", model: "Opus" },
  { key: "seven_day_sonnet", label: "Semaine, Sonnet", short: "semaine Sonnet", model: "Sonnet" },
];

const CLAUDE_PLANS: Record<string, string> = {
  pro: "Abonnement Pro",
  max: "Abonnement Max",
  team: "Abonnement Team",
  enterprise: "Abonnement Enterprise",
};

const CLAUDE_PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "AWS",
  anthropicGoogleCloud: "Google Cloud",
  mantle: "Mantle",
  gateway: "une passerelle d'entreprise",
};

/** Reads the `rate_limits` of Claude Code's `/usage` answer; exported for tests. */
export function parseClaudeUsage(body: unknown, plan?: string): QuotaReading {
  const data = (body ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const add = (
    entry: { utilization?: unknown; resets_at?: unknown } | null | undefined,
    names: { label: string; short: string; model?: string },
  ) => {
    if (!entry || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization))
      return;
    const resetsAt = toTime(entry.resets_at);
    windows.push({
      label: names.label,
      short: names.short,
      ...(names.model ? { model: names.model } : {}),
      usedPercent: clampPercent(entry.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };
  for (const w of CLAUDE_WINDOWS) add(data[w.key] as Parameters<typeof add>[0], w);
  // Weekly windows of one model (Fable…), named by Anthropic.
  if (Array.isArray(data.model_scoped)) {
    for (const entry of data.model_scoped as Record<string, unknown>[]) {
      const name = typeof entry?.display_name === "string" ? entry.display_name.trim() : "";
      if (!name || windows.some((w) => w.model?.toLowerCase() === name.toLowerCase())) continue;
      add(entry, { label: `Semaine, ${name}`, short: `semaine ${name}`, model: name });
    }
  }
  const extras: { label: string; value: string }[] = [];
  const extra = data.extra_usage as { is_enabled?: unknown; utilization?: unknown } | undefined;
  if (extra && typeof extra.is_enabled === "boolean") {
    extras.push({
      label: "Crédits en plus",
      value: !extra.is_enabled
        ? "Désactivés"
        : typeof extra.utilization === "number" && Number.isFinite(extra.utilization)
          ? `${Math.round(extra.utilization)} % utilisés`
          : "Activés",
    });
  }
  if (!windows.length) return unreadable("Claude n'a renvoyé aucune limite pour ce compte.");
  return { state: "ok", ...(plan ? { plan } : {}), windows, extras };
}

/** What Claude Code says of its sign-in (`accountInfo()`), the fields read here. */
export interface ClaudeAccount {
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

/** What Claude Code answered: its sign-in and its `/usage` figures; exported for tests. */
export function claudeReading(account: ClaudeAccount, usage: unknown): QuotaReading {
  const answer = (usage ?? {}) as {
    subscription_type?: unknown;
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  const type =
    typeof answer.subscription_type === "string"
      ? answer.subscription_type
      : (account.subscriptionType ?? "");
  const plan = CLAUDE_PLANS[type.toLowerCase()];
  if (answer.rate_limits_available === true) {
    if (answer.rate_limits) return parseClaudeUsage(answer.rate_limits, plan);
    // A subscription whose figures Claude Code could not fetch this time (429, network).
    return unreadable("Claude Code n'a pas pu lire ses limites pour l'instant.", {
      transient: true,
      retryAfterMs: RATE_LIMIT_BASE_BACKOFF_MS,
    });
  }
  const none = (note: string): QuotaReading => ({ state: "none", windows: [], extras: [], note });
  if (account.apiProvider && account.apiProvider !== "firstParty") {
    const provider = CLAUDE_PROVIDERS[account.apiProvider] ?? account.apiProvider;
    return none(`Claude Code passe par ${provider} : payé à l'usage, pas de quota d'abonnement.`);
  }
  if (account.apiKeySource) {
    return none(
      `Claude Code passe par une clé d'API (${account.apiKeySource}) : payé à l'usage, pas de quota d'abonnement.`,
    );
  }
  if (!account.tokenSource) {
    return unreadable("Claude Code n'est pas connecté : lance « claude » puis « /login ».");
  }
  return unreadable(
    "Claude Code ne donne pas les limites de cette connexion : lance « claude » puis « /login » avec ton abonnement.",
  );
}

export type ClaudeProbe = (
  signal: AbortSignal,
) => Promise<{ account: ClaudeAccount; usage: unknown }>;

/**
 * Starts Claude Code through the Agent SDK, asks its sign-in and `/usage`, and stops it.
 * No prompt is sent, no setting, hook or MCP server of the user's is loaded, nothing is saved.
 */
export const probeClaude: ClaudeProbe = async (signal) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  // Stopped while the SDK loaded: start nothing.
  if (signal.aborted) throw new Error("Lecture annulée.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  // The prompt never comes: Claude Code waits, answering only control requests.
  const prompt = (async function* (): AsyncGenerator<never> {
    await new Promise((resolve) =>
      controller.signal.addEventListener("abort", resolve, { once: true }),
    );
  })();
  const session = query({
    prompt,
    options: {
      abortController: controller,
      cwd: os.homedir(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
    },
  });
  try {
    const account = await session.accountInfo();
    const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    return { account, usage };
  } finally {
    signal.removeEventListener("abort", stop);
    controller.abort();
    session.close();
  }
};

export async function readClaudeQuota(
  probe: ClaudeProbe = probeClaude,
  signal?: AbortSignal,
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<QuotaReading> {
  if (signal?.aborted) return unreadable("Lecture annulée.", { transient: true });
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const answer = await Promise.race([probe(controller.signal), timedOut]);
    if (answer === "timeout")
      return unreadable("Claude Code n'a pas répondu à temps.", { transient: true });
    return claudeReading(answer.account ?? {}, answer.usage);
  } catch (error) {
    if (signal?.aborted) return unreadable("Lecture annulée.", { transient: true });
    const why = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    const limited = /\b429\b|rate.?limit/i.test(why);
    return unreadable(`Claude Code n'a pas donné ses limites : ${why}`, {
      transient: true,
      ...(limited ? { retryAfterMs: RATE_LIMIT_BASE_BACKOFF_MS } : {}),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
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
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    const short =
      minutes < 60
        ? `${Math.round(minutes)} min`
        : minutes % 1440 === 0
          ? `${minutes / 1440} j`
          : `${Math.round(minutes / 60)} h`;
    return { label: `Fenêtre de ${short}`, short };
  }
  return { label: fallback, short: fallback.toLowerCase() };
}

/** Reads the answers to `account/read` and `account/rateLimits/read`; exported for tests. */
export function parseCodexLimits(limits: unknown, account?: unknown): QuotaReading {
  const accObj = (account ?? {}) as { account?: { type?: unknown; planType?: unknown } | null };
  const acc = accObj.account;
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
  if (!snapshot) {
    return unreadable(
      acc === null
        ? "Codex n'est pas connecté : lance « codex login »."
        : "Codex n'a renvoyé aucune limite pour ce compte.",
    );
  }
  const windows: QuotaWindow[] = [];
  for (const [key, fallback] of [
    ["primary", "Première limite"],
    ["secondary", "Seconde limite"],
  ] as const) {
    const w = snapshot[key] as
      | { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
      | null
      | undefined;
    if (!w || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
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
  if (!windows.length) {
    return unreadable(
      acc === null
        ? "Codex n'est pas connecté : lance « codex login »."
        : "Codex n'a renvoyé aucune limite pour ce compte.",
    );
  }
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

/**
 * Asks `codex app-server` a few JSON-RPC questions, one JSON object per line. Every request
 * carries `params` (`{}` when there is nothing to say): `account/read` is refused without it.
 * A request Codex refuses gets a `CodexRequestError` as its answer, so the others still count.
 */
export function askCodex(
  codex: { command: string; args: string[] },
  methods: string[],
  timeoutMs = ASK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(new TransientError("Lecture annulée."));
  return new Promise((resolve, reject) => {
    const plan = spawnPlan(codex.command, [...codex.args, "app-server"]);
    const child = spawn(plan.command, plan.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const answers: Record<string, unknown> = {};
    let left = methods.length;
    let initialized = false;
    let buffer = "";
    let stderr = "";
    let exited = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const onAbort = () => finish(new TransientError("Lecture annulée."));
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        void killTree(child, "SIGKILL");
        reject(error);
        return;
      }
      // Close stdin cleanly so `codex app-server` exits on EOF; only force-kill if it lingers.
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (!exited) {
        graceTimer = setTimeout(() => {
          if (!exited) void killTree(child, "SIGKILL");
        }, CODEX_EXIT_GRACE_MS);
        graceTimer.unref();
      }
      resolve(answers);
    };
    const timer = setTimeout(
      () => finish(new TransientError("Codex n'a pas répondu à temps.")),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", () => {
      exited = true;
      clearTimeout(graceTimer);
      if (done) return;
      if (left) {
        const detail = lastNonEmptyLine(stderr);
        finish(
          new TransientError(
            detail
              ? `Codex s'est arrêté sans répondre : ${detail}`
              : "Codex s'est arrêté sans répondre.",
          ),
        );
      } else {
        finish();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: {
          id?: unknown;
          method?: unknown;
          result?: unknown;
          error?: { message?: unknown };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        // Notifications and Codex's own requests to us carry a method: not answers.
        if (typeof message.id !== "number" || message.method !== undefined) continue;
        // Wait for the `initialize` response before sending `initialized` and requests.
        if (message.id === 0) {
          if (initialized) continue;
          if (message.error) {
            const why = typeof message.error.message === "string" ? message.error.message : "";
            return finish(new Error(why || "Codex a refusé l'initialisation."));
          }
          initialized = true;
          write({ method: "initialized" });
          if (left === 0) return finish();
          methods.forEach((method, i) => write({ method, id: i + 1, params: {} }));
          continue;
        }
        const method = methods[message.id - 1];
        if (!method || method in answers) continue;
        if (message.error) {
          const why = typeof message.error.message === "string" ? message.error.message : "";
          answers[method] = new CodexRequestError(why || `Codex a refusé ${method}.`);
        } else {
          answers[method] = message.result;
        }
        if (--left === 0) return finish();
      }
    });
    child.stdin.on("error", () => {});
    write({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "moonagentic", title: "MoonAgentic", version: "0.0.0" } },
    });
  });
}

export async function readCodexQuota(
  codex = findCodex(),
  ask: typeof askCodex = askCodex,
  signal?: AbortSignal,
): Promise<QuotaReading> {
  if (!codex) {
    return unreadable("Commande codex introuvable : installe Codex CLI pour lire ses limites.");
  }
  try {
    const answers = await ask(
      codex,
      ["account/read", "account/rateLimits/read"],
      undefined,
      signal,
    );
    const account = answers["account/read"];
    const limits = answers["account/rateLimits/read"];
    if (limits instanceof CodexRequestError) {
      const acc = account instanceof CodexRequestError ? undefined : account;
      // Not signed in, or on an API key: Codex refuses the limits, and says why in account/read.
      const known = parseCodexLimits(undefined, acc);
      if (known.state === "none" || (acc as { account?: unknown } | undefined)?.account === null)
        return known;
      return unreadable(`Codex n'a pas donné ses limites : ${limits.message.split("\n")[0]}`);
    }
    return parseCodexLimits(limits, account instanceof CodexRequestError ? undefined : account);
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return unreadable(`Codex n'a pas donné ses limites : ${why}`, {
      transient: error instanceof TransientError,
    });
  }
}

// ---------------------------------------------------------------------------------------

/** The agents whose figures cannot be read, and why, in words for the user. */
const FIXED: Record<string, QuotaReading> = {
  antigravity: unreadable(
    "Antigravity n'affiche ses limites que dans son terminal (« /usage » dans agy) : MoonAgentic ne sait pas encore les lire.",
    { fixed: true },
  ),
  cursor: unreadable("Cursor ne donne pas ses compteurs en dehors de son site.", {
    link: "https://cursor.com/settings",
    fixed: true,
  }),
  hermes: {
    state: "none",
    windows: [],
    extras: [],
    fixed: true,
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
    claude: (signal) => readClaudeQuota(undefined, signal),
    codex: (signal) => readCodexQuota(undefined, undefined, signal),
  };
  for (const [id, reading] of Object.entries(FIXED)) readers[id] = () => Promise.resolve(reading);
  if (options.demo) {
    readers.demo = () => Promise.resolve(demoReading());
    readers["demo-2"] = () => {
      const demo = demoReading();
      return Promise.resolve({ ...demo, windows: [demo.windows[1]!] });
    };
  }
  return readers;
}

/**
 * Each agent's subscription quotas, read again every few minutes while a client is open,
 * after a turn, and when the user asks; every client gets them as they change.
 */
export class Quotas {
  private readonly readers: Record<string, QuotaReader>;
  private readonly available: () => string[];
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly active: () => boolean;
  private readonly now: () => number;
  private readonly known = new Map<string, AgentQuota>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly lastAsked = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly controller = new AbortController();
  private everyMs = EVERY_MS;
  private timer: NodeJS.Timeout | undefined;
  private broadcastQueued: Promise<void> | undefined;
  private lastSentJson: string | undefined;
  private closed = false;

  constructor(options: {
    readers: Record<string, QuotaReader>;
    /** The agents installed now. */
    available: () => string[];
    broadcast: (message: ServerMessage) => void;
    /** Whether periodic background polling should run (e.g. at least one client open). */
    active?: () => boolean;
    now?: () => number;
  }) {
    this.readers = options.readers;
    this.available = options.available;
    this.broadcast = options.broadcast;
    this.active = options.active ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  /** Reads every quota when active, then again every `everyMs` while active. */
  start(everyMs = EVERY_MS): void {
    this.everyMs = everyMs;
    if (this.active()) void this.refresh();
    if (everyMs > 0) {
      this.timer = setInterval(() => {
        if (this.active()) void this.refresh();
      }, everyMs);
      this.timer.unref();
    }
  }

  /** Called when a client connects: populates unloaded or stale quotas without spamming. */
  onClientConnect(): void {
    if (this.closed || this.everyMs <= 0) return;
    void this.refresh(undefined, this.everyMs);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.controller.abort();
  }

  /** The quotas of the installed agents that have a reader, in the agents' order. */
  list(): AgentQuota[] {
    return this.wanted().flatMap((id) => {
      const quota = this.known.get(id);
      if (quota) return [quota];
      if (this.reading.has(id)) return [{ agentId: id, state: "loading", windows: [], extras: [] }];
      return [];
    });
  }

  /**
   * Reads again the quota of one agent, or of all; `gapMs` skips an agent read more recently
   * than that. Resolves once the new figures are sent.
   */
  async refresh(agentId?: string, gapMs = 0, force = false): Promise<void> {
    const ids = this.wanted().filter((id) => !agentId || id === agentId);
    await Promise.all(ids.map((id) => this.read(id, gapMs, force)));
    await this.broadcastQueued;
  }

  /** After a turn: the agent's figures have likely moved, or an expired sign-in renewed. */
  afterTurn(agentId: string): void {
    if (!(agentId in this.readers)) return;
    const prev = this.known.get(agentId);
    if (prev?.fixed) return;
    const gap = prev && prev.state !== "ok" ? 0 : AFTER_TURN_GAP_MS;
    void this.refresh(agentId, gap);
  }

  /** When the user asks: not more often than every few seconds, bypassing automatic backoff. */
  asked(agentId?: string): Promise<void> {
    return this.refresh(agentId, ASKED_GAP_MS, true);
  }

  private wanted(): string[] {
    return this.available().filter((id) => id in this.readers);
  }

  private scheduleBroadcast(): void {
    if (this.closed || this.broadcastQueued) return;
    this.broadcastQueued = Promise.resolve().then(() => {
      this.broadcastQueued = undefined;
      if (this.closed) return;
      const quotas = this.list();
      const json = JSON.stringify(quotas);
      if (json === this.lastSentJson) return;
      this.lastSentJson = json;
      this.broadcast({ type: "quotas", quotas });
    });
  }

  private read(id: string, gapMs: number, force = false): Promise<void> {
    const running = this.reading.get(id);
    if (running) return running;
    const existing = this.known.get(id);
    if (existing?.fixed) return Promise.resolve();
    const now = this.now();
    const last = this.lastAsked.get(id);
    if (last !== undefined && now - last < gapMs) return Promise.resolve();
    if (!force) {
      const until = this.retryAt.get(id);
      if (until !== undefined && now < until) return Promise.resolve();
    }
    this.lastAsked.set(id, now);
    const reader = this.readers[id]!;
    const done = reader(this.controller.signal)
      .catch((error: unknown) =>
        unreadable(
          `Lecture impossible : ${error instanceof Error ? error.message : String(error)}`,
          { transient: true },
        ),
      )
      .then((reading) => {
        if (this.closed) return;
        const prev = this.known.get(id);
        const { transient, retryAfterMs, ...clean } = reading;
        if (transient) {
          const count = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, count);
          if (retryAfterMs !== undefined) {
            const expBackoff = Math.min(
              RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (count - 1),
              MAX_BACKOFF_MS,
            );
            this.retryAt.set(id, this.now() + Math.max(retryAfterMs, expBackoff));
          }
        } else {
          this.failures.delete(id);
          this.retryAt.delete(id);
        }
        if (transient && prev?.state === "ok") {
          this.known.set(id, { ...prev, note: clean.note });
        } else {
          const readAt = clean.state === "ok" ? this.now() : undefined;
          this.known.set(id, {
            agentId: id,
            ...clean,
            ...(readAt !== undefined ? { readAt } : {}),
          });
        }
        this.scheduleBroadcast();
      })
      .finally(() => this.reading.delete(id));
    this.reading.set(id, done);
    return done;
  }
}
