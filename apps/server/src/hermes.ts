// Hermes Agent on Discord: the user writes in their own Discord channel, Hermes (running on
// this computer) answers, and through its MCP bridge (`hermes-bridge.ts`) acts in MoonAgentic:
// it talks to a project's coordinator, writes to a thread, plans, answers an agent. Back the
// other way, MoonAgentic tells the channel itself, through a Discord webhook, when a thread is
// done, waits, or has a pull request ready.
//
// Hermes's access is a random token in a file of MoonAgentic's data folder, which the bridge
// reads at each call; only its hash is kept in the settings. Taking the access away deletes
// both: the next call is refused.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HERMES_ALLOW,
  DEFAULT_HERMES_NOTIFY,
  type HermesAction,
  type HermesAllow,
  type HermesNotify,
  type HermesStatus,
  type Item,
  type PendingQuestion,
  type PendingRequest,
  type PlanTask,
  type Project,
  prReady,
  type QuestionAnswer,
  SCHEDULE_REPEATS,
  type Schedule,
  type ScheduleRepeat,
  type ServerMessage,
  type Thread,
} from "@moonagentic/protocol";
import { ASK_WAIT_MS } from "./hermes-tools.ts";

const SETTING = "hermes";
const TOKEN_FILE = "hermes-token";
const BRIDGE = fileURLToPath(new URL("./hermes-bridge.ts", import.meta.url));
/** Actions kept for « Dernières actions ». */
const MAX_LOG = 20;
/** The last call is written down at most this often. */
const SEEN_EVERY_MS = 60_000;
const READ_MESSAGES = 8;
const MAX_READ_MESSAGES = 20;
const READ_CLIP = 1_500;
/** A coordinator's answer handed back to Discord is cut there: Discord shows 2000 at most. */
const ANSWER_CLIP = 6_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Discord's own limit on a message. */
const DISCORD_MAX = 2000;

interface Saved {
  tokenHash?: string;
  lastSeen?: number;
  allow?: Partial<HermesAllow>;
  notify?: Partial<HermesNotify>;
  webhook?: string;
  log?: HermesAction[];
}

/** Hermes's refusal for a call without a valid access: answered 401. */
export class HermesRefused extends Error {
  constructor() {
    super("Accès de Hermes refusé : reconnecte-le dans Réglages › Hermes · Discord.");
  }
}

/** What Hermes needs of the hub. */
export interface HermesHost {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  projects(): Project[];
  threads(): Thread[];
  thread(threadId: string): Thread | undefined;
  items(threadId: string): Item[];
  /** Marks Hermes's message whose answer went back to Discord. */
  markRelayed(threadId: string, itemId: string): void;
  running(threadId: string): boolean;
  whenIdle(threadId: string): Promise<void>;
  /** Sends a message as the user's, from Discord; queued when the agent is at work. */
  sendFromHermes(threadId: string, text: string): "sent" | "queued";
  addPlanCard(input: {
    projectId: string;
    title: string;
    description?: string;
    start?: number;
    due?: number;
  }): PlanTask;
  addSchedule(input: {
    projectId: string;
    title?: string;
    text: string;
    at: number;
    repeat: ScheduleRepeat;
  }): Schedule;
  pendingRequests(): PendingRequest[];
  pendingQuestions(): PendingQuestion[];
  respondToPermission(threadId: string, itemId: string, optionId: string): void;
  respondToQuestion(threadId: string, itemId: string, answers: QuestionAnswer[]): void;
  /** A project nothing may be said of or done in: locked, being removed, or « Discussions ». */
  closed(projectId: string): boolean;
  /** A project whose notices stay on this computer: locked. */
  quiet(projectId: string): boolean;
  broadcast(message: ServerMessage): void;
  /** Where the bridge reaches this server, once it listens. */
  url(): string | undefined;
}

export type WebhookSend = (url: string, init: RequestInit) => Promise<{ status: number }>;

/** True for a Discord webhook address, and nothing else: the server posts only there. */
export function discordWebhook(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(
      url.hostname.toLowerCase(),
    ) &&
    /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)
  );
}

const hash = (token: string) => createHash("sha256").update(token).digest();
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A thread's state in a word, as the user reads it in the app. */
export function stateOf(thread: Thread): string {
  if (thread.held) return "en file";
  if (thread.status === "running") return "au travail";
  if (thread.status === "waiting") return "t'attend";
  if (thread.status === "error") return "en erreur";
  if (thread.archived) return "résolu";
  if (thread.pr?.state === "merged") return "PR fusionnée";
  if (thread.pr && prReady(thread.pr)) return "PR prête à fusionner";
  if (thread.pr?.state === "open") return "PR ouverte";
  return "en pause";
}

/** True when `at` falls on the year, month and day written, none of them overflowing. */
function sameDay(at: number, m: RegExpExecArray): boolean {
  if (Number.isNaN(at)) return false;
  const d = new Date(at);
  return (
    d.getFullYear() === Number(m[1]) &&
    d.getMonth() === Number(m[2]) - 1 &&
    d.getDate() === Number(m[3])
  );
}

/** A day written AAAA-MM-JJ, at midnight on this computer. */
export function dayOf(text: string, key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  const at = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
  if (!m || !sameDay(at, m)) {
    throw new Error(`« ${key} » doit être un jour AAAA-MM-JJ.`);
  }
  return at;
}

/** A time written AAAA-MM-JJTHH:MM, on this computer's clock. */
export function timeOf(text: string, key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  const at = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
    : NaN;
  if (!m || !sameDay(at, m) || Number(m[4]) > 23 || Number(m[5]) > 59) {
    throw new Error(`« ${key} » doit être une date et une heure AAAA-MM-JJTHH:MM.`);
  }
  return at;
}

/** The lines a thread's change is worth on Discord, as the user set it. */
export function discordNotices(
  was: Thread,
  now: Thread,
  notify: HermesNotify,
  project: string,
): string[] {
  if (now.archived || now.parentId || now.kind === "coordinator") return [];
  const lines: string[] = [];
  const head = (what: string) => `**${what}** · ${project}\n${now.title}`;
  if (notify.waiting && now.status === "waiting" && was.status !== "waiting") {
    lines.push(head("Attend ta réponse"));
  }
  if (
    notify.done &&
    was.status === "running" &&
    now.status === "idle" &&
    !now.queue?.length &&
    !now.held
  ) {
    lines.push(head("Fil terminé"));
  }
  if (notify.prReady && now.pr && prReady(now.pr) && !(was.pr && prReady(was.pr))) {
    lines.push(`${head(`PR #${now.pr.number} prête à fusionner`)}\n<${now.pr.url}>`);
  }
  return lines;
}

/** Hermes: its access, what it may do, what it did, and the notices sent to Discord. */
export class Hermes {
  private readonly host: HermesHost;
  private readonly tokenFile: string | undefined;
  private readonly sendWebhook: WebhookSend;
  private lastSeenSaved = 0;
  /** Each thread as last seen, to tell what changed. */
  private readonly seenThreads = new Map<string, Thread>();

  constructor(host: HermesHost, dataDir: string | undefined, send?: WebhookSend) {
    this.host = host;
    this.tokenFile = dataDir ? path.join(dataDir, TOKEN_FILE) : undefined;
    this.sendWebhook =
      send ??
      (async (url, init) => {
        const res = await fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        return res;
      });
  }

  private saved(): Saved {
    const value = this.host.getSetting<unknown>(SETTING, {});
    return typeof value === "object" && value !== null ? (value as Saved) : {};
  }

  private save(patch: Partial<Saved>): void {
    this.host.setSetting(SETTING, { ...this.saved(), ...patch });
  }

  private announce(): void {
    this.host.broadcast({ type: "hermes", hermes: this.status() });
  }

  allow(): HermesAllow {
    return { ...DEFAULT_HERMES_ALLOW, ...this.saved().allow };
  }

  notify(): HermesNotify {
    return { ...DEFAULT_HERMES_NOTIFY, ...this.saved().notify };
  }

  /** The lines for Hermes's `config.yaml`, under `mcp_servers:`. */
  config(): string {
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const url = this.host.url() ?? "http://127.0.0.1:4747";
    const lines = [
      "  moonagentic:",
      `    command: ${quote(process.execPath)}`,
      `    args: [${[BRIDGE, url, this.tokenFile ?? TOKEN_FILE].map(quote).join(", ")}]`,
    ];
    // In the desktop app, this program is Electron, which acts as Node only when told.
    if (process.env.ELECTRON_RUN_AS_NODE) lines.push("    env:", "      ELECTRON_RUN_AS_NODE: '1'");
    lines.push(`    timeout: ${Math.ceil(ASK_WAIT_MS / 1000) + 120}`, "    connect_timeout: 60");
    return lines.join("\n");
  }

  status(): HermesStatus {
    const saved = this.saved();
    return {
      connected: !!saved.tokenHash,
      ...(saved.lastSeen ? { lastSeen: saved.lastSeen } : {}),
      allow: this.allow(),
      notify: this.notify(),
      webhook: !!saved.webhook,
      config: this.config(),
      log: saved.log ?? [],
    };
  }

  /** Gives Hermes a new access, in place of the old one. */
  connect(): void {
    if (!this.tokenFile)
      throw new Error("Pas de dossier de données : Hermes ne peut pas être connecté.");
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.tokenFile, `${token}\n`, { mode: 0o600 });
    this.save({ tokenHash: hash(token).toString("hex") });
    this.announce();
  }

  /** Takes Hermes's access away. */
  cut(): void {
    if (this.tokenFile && existsSync(this.tokenFile)) rmSync(this.tokenFile, { force: true });
    const { tokenHash: _gone, ...rest } = this.saved();
    this.host.setSetting(SETTING, rest);
    this.announce();
  }

  set(change: {
    allow?: Partial<HermesAllow> | undefined;
    notify?: Partial<HermesNotify> | undefined;
    webhook?: string | null | undefined;
  }): void {
    const saved = this.saved();
    const next: Saved = { ...saved };
    if (change.allow) next.allow = { ...this.allow(), ...change.allow };
    if (change.notify) next.notify = { ...this.notify(), ...change.notify };
    if (change.webhook === null || change.webhook === "") delete next.webhook;
    else if (change.webhook !== undefined) {
      if (!discordWebhook(change.webhook)) {
        throw new Error(
          "Ce n'est pas l'adresse d'un webhook Discord (https://discord.com/api/webhooks/…).",
        );
      }
      next.webhook = change.webhook.trim();
    }
    this.host.setSetting(SETTING, next);
    this.announce();
  }

  /** Posts on the Discord channel; does nothing without a webhook. */
  async post(content: string): Promise<void> {
    const webhook = this.saved().webhook;
    if (!webhook) return;
    const res = await this.sendWebhook(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: clip(content, DISCORD_MAX),
        username: "MoonAgentic",
        // Nobody is pinged by what a thread is called.
        allowed_mentions: { parse: [] },
      }),
    });
    if (res.status === 404 || res.status === 401) {
      throw new Error(
        "Discord ne connaît plus ce webhook : recrée-le et colle sa nouvelle adresse.",
      );
    }
    if (res.status >= 400) throw new Error(`Discord a répondu ${res.status}.`);
  }

  async test(): Promise<void> {
    if (!this.saved().webhook) throw new Error("Aucun webhook Discord n'est réglé.");
    await this.post("MoonAgentic est bien relié à ce salon.");
  }

  /** Remembers the threads as they are, so only what changes from now on is told. */
  know(threads: Thread[]): void {
    for (const thread of threads) this.seenThreads.set(thread.id, thread);
  }

  threadRemoved(threadId: string): void {
    this.seenThreads.delete(threadId);
  }

  /** Called with each thread as it changes: tells Discord what the user asked to hear. */
  threadChanged(now: Thread): void {
    const was = this.seenThreads.get(now.id);
    this.seenThreads.set(now.id, now);
    if (!was || !this.saved().webhook || this.host.quiet(now.projectId)) return;
    const project = this.host.projects().find((p) => p.id === now.projectId);
    if (!project) return;
    for (const line of discordNotices(was, now, this.notify(), project.name)) {
      this.post(line).catch((error: unknown) =>
        console.error("Discord :", error instanceof Error ? error.message : error),
      );
    }
  }

  private check(given: string): void {
    const saved = this.saved().tokenHash;
    if (!saved || !given) throw new HermesRefused();
    const want = Buffer.from(saved, "hex");
    const got = hash(given);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new HermesRefused();
  }

  private record(what: string, project?: Project): void {
    const log = [
      { what, ...(project ? { project: project.name } : {}), at: Date.now() },
      ...(this.saved().log ?? []),
    ].slice(0, MAX_LOG);
    this.lastSeenSaved = Date.now();
    this.save({ log, lastSeen: this.lastSeenSaved });
    this.announce();
  }

  private seen(): void {
    const now = Date.now();
    if (now - this.lastSeenSaved < SEEN_EVERY_MS) return;
    this.lastSeenSaved = now;
    this.save({ lastSeen: now });
    this.announce();
  }

  /** One tool call from Hermes's bridge. */
  async call(token: string, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    this.check(token);
    this.seen();
    const input =
      typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    const str = (key: string, max: number) => {
      const value = input[key];
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value !== "string" || value.length > max)
        throw new Error(`« ${key} » doit être un texte d'au plus ${max} caractères.`);
      return value.trim() || undefined;
    };
    const need = (key: string, max: number) => {
      const value = str(key, max);
      if (!value) throw new Error(`« ${key} » est requis.`);
      return value;
    };
    const allow = this.allow();
    const may = (what: keyof HermesAllow, label: string) => {
      if (!allow[what]) {
        throw new Error(
          `L'utilisateur n'a pas autorisé Hermes à ${label} (Réglages › Hermes · Discord).`,
        );
      }
    };
    const open = () => this.host.projects().filter((p) => !p.archived && !this.host.closed(p.id));
    const projectOf = () => {
      const asked = need("project", 200);
      const all = open();
      const found =
        all.find((p) => p.id === asked) ??
        all.find((p) => fold(p.name) === fold(asked)) ??
        all.filter((p) => fold(p.name).includes(fold(asked))).at(0);
      if (!found) {
        throw new Error(
          `Aucun projet « ${asked} ». Projets : ${all.map((p) => p.name).join(", ") || "aucun"}.`,
        );
      }
      return found;
    };
    const work = (projectId: string) =>
      this.host
        .threads()
        .filter(
          (t) =>
            t.projectId === projectId && !t.parentId && t.kind !== "coordinator" && !t.archived,
        );
    const threadOf = () => {
      const id = need("thread_id", 200);
      const thread = this.host.thread(id);
      if (!thread || !open().some((p) => p.id === thread.projectId)) {
        throw new Error("Ce fil n'existe pas.");
      }
      return thread;
    };
    const projectNamed = (id: string) => this.host.projects().find((p) => p.id === id);

    switch (tool) {
      case "list_projects":
        return open().map((p) => {
          const threads = work(p.id);
          return {
            project: p.name,
            project_id: p.id,
            working: threads.filter((t) => t.status === "running").length,
            waiting: threads.filter((t) => t.status === "waiting").length,
            coordinator: this.host
              .threads()
              .some((t) => t.projectId === p.id && t.kind === "coordinator"),
          };
        });
      case "project_status": {
        const project = projectOf();
        const asks = new Set(this.host.pendingRequests().map((r) => r.threadId));
        return {
          project: project.name,
          threads: work(project.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 30)
            .map((t) => ({
              thread_id: t.id,
              title: t.title,
              state: stateOf(t),
              ...(asks.has(t.id) ? { asks_permission: true } : {}),
              ...(t.pr ? { pr: t.pr.url } : {}),
              updated: new Date(t.updatedAt).toISOString(),
            })),
        };
      }
      case "read_thread": {
        const thread = threadOf();
        const limitRaw = input.limit;
        const limit =
          typeof limitRaw === "number" && Number.isInteger(limitRaw)
            ? Math.min(MAX_READ_MESSAGES, Math.max(1, limitRaw))
            : READ_MESSAGES;
        const messages = this.host.items(thread.id).flatMap((i) =>
          (i.kind === "user" && !i.byTeam) || i.kind === "agent"
            ? [
                {
                  from:
                    i.kind === "agent"
                      ? "agent"
                      : i.from === "coordinator"
                        ? "coordinateur"
                        : "utilisateur",
                  text: clip(i.text, READ_CLIP),
                },
              ]
            : [],
        );
        return {
          title: thread.title,
          state: stateOf(thread),
          ...(thread.pr ? { pr: thread.pr.url } : {}),
          last_messages: messages.slice(-limit),
        };
      }
      case "ask_coordinator": {
        may("coordinators", "écrire aux coordinateurs");
        const project = projectOf();
        const message = need("message", 20_000);
        const coordinator = this.host
          .threads()
          .find((t) => t.projectId === project.id && t.kind === "coordinator");
        if (!coordinator) {
          throw new Error(
            `Le projet « ${project.name} » n'a pas encore de coordinateur : ouvre ce projet une fois dans MoonAgentic.`,
          );
        }
        const asked = Date.now();
        const how = this.host.sendFromHermes(coordinator.id, message);
        this.record("Message au coordinateur", project);
        return await this.answerOf(coordinator.id, message, asked, how, signal);
      }
      case "message_thread": {
        may("threads", "écrire dans un fil");
        const thread = threadOf();
        // A coordinator is written to only as « Écrire aux coordinateurs » allows, and a
        // team's piece only by its lead.
        if (thread.kind === "coordinator") may("coordinators", "écrire aux coordinateurs");
        if (thread.parentId) {
          throw new Error("Ce fil fait partie d'une équipe : écris à son fil principal.");
        }
        if (thread.archived) throw new Error("Ce fil est résolu : rouvre-le dans MoonAgentic.");
        const how = this.host.sendFromHermes(thread.id, need("message", 20_000));
        this.record(`Message au fil · ${thread.title}`, projectNamed(thread.projectId));
        return how === "sent"
          ? { sent_to: thread.title }
          : { queued_for: thread.title, delivered: "à la fin du tour en cours" };
      }
      case "add_plan_card": {
        may("plan", "planifier");
        const project = projectOf();
        const title = need("title", 200);
        const description = str("description", 5_000);
        const start = str("start", 20);
        const due = str("due", 20);
        const card = this.host.addPlanCard({
          projectId: project.id,
          title,
          ...(description ? { description } : {}),
          ...(start ? { start: dayOf(start, "start") } : {}),
          ...(due ? { due: dayOf(due, "due") } : {}),
        });
        this.record(`Carte ajoutée au Planner · ${title}`, project);
        return { added: `#${card.number} ${card.title}`, project: project.name };
      }
      case "schedule_task": {
        may("plan", "planifier");
        const project = projectOf();
        const text = need("message", 20_000);
        const title = str("title", 200);
        const repeat = need("repeat", 20);
        if (!(SCHEDULE_REPEATS as readonly string[]).includes(repeat)) {
          throw new Error(`« repeat » doit être l'un de : ${SCHEDULE_REPEATS.join(", ")}.`);
        }
        const at = timeOf(need("when", 30), "when");
        const schedule = this.host.addSchedule({
          projectId: project.id,
          ...(title ? { title } : {}),
          text,
          at,
          repeat: repeat as ScheduleRepeat,
        });
        this.record(`Tâche planifiée · ${schedule.title}`, project);
        return {
          planned: schedule.title,
          project: project.name,
          next: new Date(schedule.nextAt).toISOString(),
          repeat,
        };
      }
      case "list_requests": {
        const where = (threadId: string) => {
          const thread = this.host.threads().find((t) => t.id === threadId);
          return thread && !this.host.closed(thread.projectId)
            ? {
                thread_id: thread.id,
                thread: thread.title,
                project: projectNamed(thread.projectId)?.name,
              }
            : undefined;
        };
        return {
          permissions: this.host.pendingRequests().flatMap((r) => {
            const at = where(r.threadId);
            return at
              ? [
                  {
                    ...at,
                    request_id: r.itemId,
                    asks: r.title,
                    options: r.options.map((o) => ({ option_id: o.optionId, label: o.name })),
                  },
                ]
              : [];
          }),
          questions: this.host.pendingQuestions().flatMap((q) => {
            const at = where(q.threadId);
            return at
              ? [
                  {
                    ...at,
                    request_id: q.itemId,
                    questions: q.questions.map((x) => ({
                      question: x.question,
                      options: x.options,
                    })),
                  },
                ]
              : [];
          }),
        };
      }
      case "answer_request": {
        may("requests", "répondre aux demandes des agents");
        const thread = threadOf();
        const itemId = need("request_id", 200);
        const optionId = str("option_id", 200);
        const project = projectNamed(thread.projectId);
        if (optionId) {
          this.host.respondToPermission(thread.id, itemId, optionId);
          this.record(`Autorisation répondue · ${thread.title}`, project);
          return { answered: thread.title };
        }
        const raw = input.answers;
        if (!Array.isArray(raw) || !raw.every((a) => typeof a === "string")) {
          throw new Error(
            "Donne « option_id » pour une autorisation, ou « answers » pour une question.",
          );
        }
        const asked = this.host
          .pendingQuestions()
          .find((q) => q.itemId === itemId && q.threadId === thread.id);
        if (!asked) throw new Error("Cette question n'attend plus de réponse.");
        const answers: QuestionAnswer[] = asked.questions.map((q, i) => {
          const said = (raw[i] as string | undefined)?.trim() ?? "";
          const picked = q.options.find((o) => fold(o) === fold(said));
          return picked ? { picks: [picked] } : { picks: [], text: said };
        });
        this.host.respondToQuestion(thread.id, itemId, answers);
        this.record(`Question répondue · ${thread.title}`, project);
        return { answered: thread.title };
      }
      default:
        throw new Error(`Outil inconnu : ${tool}`);
    }
  }

  /**
   * Waits for the coordinator to answer the message Hermes sent at `asked`, and gives back
   * what it said and the threads it opened. Comes back at once when the coordinator waits for
   * the user, or ended on an error; past {@link ASK_WAIT_MS}, says it still works.
   */
  private async answerOf(
    threadId: string,
    text: string,
    asked: number,
    how: "sent" | "queued",
    signal?: AbortSignal,
  ): Promise<unknown> {
    const deadline = asked + ASK_WAIT_MS;
    /** Hermes's message and what came after it, up to the next message to the agent. */
    const mine = () => {
      const items = this.host.items(threadId);
      const index = items.findLastIndex(
        (i) => i.kind === "user" && i.from === "hermes" && i.text === text && i.at >= asked - 1000,
      );
      if (index < 0) return undefined;
      const rest = items.slice(index + 1);
      const next = rest.findIndex((i) => i.kind === "user");
      return { message: items[index]!, after: next < 0 ? rest : rest.slice(0, next) };
    };
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
      });
    const queuedNote = how === "queued" ? { waited_for_previous_turn: true } : {};
    for (;;) {
      if (signal?.aborted) return { stopped: true };
      const thread = this.host.thread(threadId);
      if (!thread) throw new Error("Le coordinateur a été supprimé.");
      if (thread.status === "waiting") {
        return {
          waiting_for_user: true,
          ...(thread.queue?.some((m) => m.from === "hermes" && m.text === text)
            ? { message_queued: true }
            : {}),
          note: "Le coordinateur attend une autorisation ou une réponse : voir list_requests, ou MoonAgentic.",
        };
      }
      // The timeline is read only once the coordinator stops: not each second of its turn.
      if (!this.host.running(threadId)) {
        const found = mine();
        if (found) {
          if (thread.status === "error") {
            throw new Error(
              `Le coordinateur s'est arrêté sur une erreur : ${thread.error ?? "sans détail"}`,
            );
          }
          const answer = found.after
            .filter((i): i is Extract<Item, { kind: "agent" }> => i.kind === "agent")
            .map((i) => i.text)
            .join("\n\n")
            .trim();
          const opened = found.after.flatMap((i) =>
            i.kind === "opened" ? [{ thread_id: i.threadId, title: i.title }] : [],
          );
          this.host.markRelayed(threadId, found.message.id);
          return {
            answer: clip(answer || "(pas de réponse écrite)", ANSWER_CLIP),
            ...(opened.length ? { opened_threads: opened } : {}),
            ...queuedNote,
          };
        }
        // Still in the queue with the coordinator stopped: the turn before ended on an error
        // or was stopped, and the user looks at it before what waits goes on.
        if (thread.queue?.some((m) => m.from === "hermes" && m.text === text)) {
          return {
            message_queued: true,
            note:
              thread.status === "error"
                ? `Le tour précédent du coordinateur s'est arrêté sur une erreur (${thread.error ?? "sans détail"}) : le message partira quand l'utilisateur l'aura regardée dans MoonAgentic.`
                : "Le message attend dans la file du coordinateur : il partira depuis MoonAgentic.",
          };
        }
      }
      if (Date.now() >= deadline) {
        return {
          still_working: true,
          note: "Le coordinateur travaille encore : redemande avec project_status ou read_thread dans un moment.",
        };
      }
      await pause(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }
}
