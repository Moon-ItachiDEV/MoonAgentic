// What the iPhone widgets show (see `extras/scriptable/MoonAgentic.js`): the quotas, the threads
// that wait or work, and Hermes. Read-only, small, and nothing of a locked project.
import type {
  AgentInfo,
  AgentQuota,
  HermesStatus,
  PendingQuestion,
  PendingRequest,
  Project,
  QuotaWindow,
  Schedule,
  Thread,
} from "@moonagentic/protocol";

/** Where the widgets read, with a paired device's token. */
export const WIDGET_PATH = "/api/widget";

/** Threads listed at most: a large widget shows four. */
const MAX_THREADS = 6;
/** Hermes's last actions and next tasks listed at most: a medium widget shows four. */
const MAX_LINES = 4;
/** How long Hermes's last action, or its last finished turn, stays its state. */
export const RECENT_MS = 10 * 60_000;

export interface WidgetWindow {
  /** « Session de 5 h », « Semaine, Opus ». */
  label: string;
  /** « 5 h », « semaine ». */
  short: string;
  /** Share used, 0 to 100 and past it. */
  used: number;
  resetsAt?: number;
}

export interface WidgetAgent {
  id: string;
  name: string;
  /** The session window first, then the week's, then the others. */
  windows: WidgetWindow[];
  /** The place in `windows` of the fullest one: the one that stops the agent first. */
  tight: number;
}

export interface WidgetThread {
  title: string;
  project: string;
  /** The model's name, or else the agent's. */
  by: string;
  state: "waiting" | "running";
  /** Since when it waits or works, when this server saw it start. */
  since?: number;
}

/**
 * Hermes in a word.
 * `asks`: one of its own threads waits for the user's answer. `waiting`: a thread waits and
 * Discord was told so. `working`: one of its threads is at work. `error`: its last turn failed.
 * `acted`: it just did something here from Discord. `done`: it just finished a turn.
 * `off`: it has no access to this MoonAgentic. `rest`: nothing of the above.
 */
export interface WidgetHermes {
  state: "asks" | "waiting" | "working" | "error" | "acted" | "done" | "off" | "rest";
  /** The thread's title, the request's, or the action's words. */
  title?: string;
  project?: string;
  /** Since when, or when. */
  at?: number;
  /** What it did lately from Discord, the latest first. */
  log: { what: string; project?: string; at: number }[];
  /** The tasks it planned that come next, the nearest first. */
  next: { title: string; at: number }[];
}

export interface WidgetData {
  /** When this was put together. */
  at: number;
  quotas: WidgetAgent[];
  waiting: number;
  running: number;
  /** Those that wait first, then those at work; each group the longest first. */
  threads: WidgetThread[];
  /** Absent when Hermes is neither installed nor connected. */
  hermes?: WidgetHermes;
}

/** Since when each thread has had its status, as far as this server saw it change. */
export class ThreadClock {
  private readonly seen = new Map<string, { status: Thread["status"]; since?: number }>();
  /** Each agent's last turn that ended: the thread, how, and when. */
  private readonly ended = new Map<string, { threadId: string; error: boolean; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The threads as they are at start: since when is not known. */
  know(threads: Thread[]): void {
    for (const t of threads) this.seen.set(t.id, { status: t.status });
  }

  threadChanged(thread: Thread): void {
    const was = this.seen.get(thread.id);
    if (was?.status === thread.status) return;
    const at = this.now();
    this.seen.set(thread.id, { status: thread.status, since: at });
    if (was?.status === "running" && (thread.status === "idle" || thread.status === "error")) {
      this.ended.set(thread.agentId, {
        threadId: thread.id,
        error: thread.status === "error",
        at,
      });
    }
  }

  threadRemoved(threadId: string): void {
    this.seen.delete(threadId);
    for (const [agentId, last] of this.ended) {
      if (last.threadId === threadId) this.ended.delete(agentId);
    }
  }

  since(threadId: string): number | undefined {
    return this.seen.get(threadId)?.since;
  }

  lastEnded(agentId: string): { threadId: string; error: boolean; at: number } | undefined {
    return this.ended.get(agentId);
  }
}

const SESSION = /5\s*h/i;
const WEEK = /semaine/i;
const rank = (w: QuotaWindow) => (SESSION.test(w.short) ? 0 : WEEK.test(w.short) ? 1 : 2);

function agentQuota(quota: AgentQuota, agents: AgentInfo[], now: number): WidgetAgent | undefined {
  if (quota.state !== "ok" || !quota.windows.length) return undefined;
  const windows = quota.windows
    .map((w, place) => ({ w, place }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.place - b.place)
    .map(({ w }): WidgetWindow => {
      // Figures read before the reset they announced say nothing of now.
      const reset = w.resetsAt !== undefined && w.resetsAt <= now;
      return {
        label: w.label,
        short: w.short,
        used: reset ? 0 : Math.max(0, Math.round(w.usedPercent)),
        ...(w.resetsAt !== undefined && !reset ? { resetsAt: w.resetsAt } : {}),
      };
    });
  let tight = 0;
  windows.forEach((w, i) => {
    if (w.used > windows[tight]!.used) tight = i;
  });
  return {
    id: quota.agentId,
    name: agents.find((a) => a.id === quota.agentId)?.name ?? quota.agentId,
    windows,
    tight,
  };
}

export interface WidgetInput {
  now: number;
  agents: AgentInfo[];
  quotas: AgentQuota[];
  projects: Project[];
  threads: Thread[];
  requests: PendingRequest[];
  questions: PendingQuestion[];
  schedules: Schedule[];
  hermes: HermesStatus;
  clock: ThreadClock;
  /** True for a locked project: nothing of it leaves this computer. */
  locked: (projectId: string) => boolean;
  /** The name a model goes by, when its agent gave one. */
  modelName: (agentId: string, model: string) => string | undefined;
}

/** What the widgets show now. */
export function widgetData(input: WidgetInput): WidgetData {
  const { now, agents, clock } = input;
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const shown = input.threads.filter(
    (t) => !t.archived && !input.locked(t.projectId) && projectName.has(t.projectId),
  );
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  /** When the user was asked, for a thread that waits: the oldest request or question. */
  const askedAt = (threadId: string) => {
    const times = [...input.requests, ...input.questions]
      .filter((r) => r.threadId === threadId)
      .map((r) => r.at);
    return times.length ? Math.min(...times) : undefined;
  };
  const sinceOf = (t: Thread) =>
    (t.status === "waiting" ? askedAt(t.id) : undefined) ?? clock.since(t.id);
  const line = (t: Thread, state: "waiting" | "running"): WidgetThread => {
    const since = sinceOf(t);
    return {
      title: t.title,
      project: projectName.get(t.projectId)!,
      by: (t.model && input.modelName(t.agentId, t.model)) || agentName(t.agentId),
      state,
      ...(since !== undefined ? { since } : {}),
    };
  };
  const oldestFirst = (a: Thread, b: Thread) =>
    (sinceOf(a) ?? Infinity) - (sinceOf(b) ?? Infinity) || a.title.localeCompare(b.title);
  const waiting = shown.filter((t) => t.status === "waiting").sort(oldestFirst);
  // A thread held in line is not at work yet.
  const running = shown.filter((t) => t.status === "running" && !t.held).sort(oldestFirst);

  const data: WidgetData = {
    at: now,
    quotas: input.quotas.flatMap((q) => agentQuota(q, agents, now) ?? []),
    waiting: waiting.length,
    running: running.length,
    threads: [
      ...waiting.map((t) => line(t, "waiting")),
      ...running.map((t) => line(t, "running")),
    ].slice(0, MAX_THREADS),
  };

  const installed = agents.some((a) => a.id === "hermes" && a.available);
  if (!installed && !input.hermes.connected) return data;

  const own = (t: Thread) => t.agentId === "hermes";
  const log = input.hermes.log.slice(0, MAX_LINES);
  const next = input.schedules
    .filter((s) => s.by === "hermes" && s.enabled && !input.locked(s.projectId))
    .sort((a, b) => a.nextAt - b.nextAt)
    .slice(0, MAX_LINES)
    .map((s) => ({ title: s.title, at: s.nextAt }));
  const about = (t: Thread, title = t.title) => {
    const since = sinceOf(t);
    return {
      title,
      project: projectName.get(t.projectId)!,
      ...(since !== undefined ? { at: since } : {}),
    };
  };
  const state = (): Omit<WidgetHermes, "log" | "next"> => {
    const asks = waiting.find(own);
    if (asks) {
      const request = input.requests.find((r) => r.threadId === asks.id);
      return { state: "asks", ...about(asks, request?.title ?? asks.title) };
    }
    // Discord was told of a thread that waits only when the user asked for these notices.
    const told = input.hermes.webhook && input.hermes.notify.waiting;
    const waits = told ? waiting.find((t) => !t.parentId && t.kind !== "coordinator") : undefined;
    if (waits) return { state: "waiting", ...about(waits) };
    const works = running.find(own);
    if (works) return { state: "working", ...about(works) };
    const last = clock.lastEnded("hermes");
    const lastThread = last && shown.find((t) => t.id === last.threadId);
    if (last?.error && lastThread?.status === "error") {
      return {
        state: "error",
        title: lastThread.title,
        project: projectName.get(lastThread.projectId)!,
        at: last.at,
      };
    }
    const acted = input.hermes.log[0];
    const fresh = (at: number) => now - at < RECENT_MS;
    if (acted && fresh(acted.at) && (!last || acted.at >= last.at)) {
      return {
        state: "acted",
        title: acted.what,
        ...(acted.project ? { project: acted.project } : {}),
        at: acted.at,
      };
    }
    if (last && lastThread && fresh(last.at)) {
      return {
        state: "done",
        title: lastThread.title,
        project: projectName.get(lastThread.projectId)!,
        at: last.at,
      };
    }
    if (!input.hermes.connected) {
      return {
        state: "off",
        ...(input.hermes.lastSeen ? { at: input.hermes.lastSeen } : {}),
      };
    }
    const seen = Math.max(input.hermes.lastSeen ?? 0, last?.at ?? 0);
    return { state: "rest", ...(seen ? { at: seen } : {}) };
  };
  data.hermes = { ...state(), log, next };
  return data;
}
