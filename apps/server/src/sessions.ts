import type { AgentSession } from "./session.ts";

/** An agent with nothing to do is stopped after this long; its session resumes next time. */
export const IDLE_MS = 10 * 60_000;
/** Agents kept running at once; past it, the one left alone longest is stopped first. */
export const MAX_LIVE_AGENTS = 8;

export interface AgentPoolOptions {
  idleMs?: number;
  maxLiveAgents?: number;
  /** Whether something else holds the thread's agent: a turn, a step, a permission asked. */
  busy(threadId: string): boolean;
  /** Whether a turn is running on the thread. */
  running(threadId: string): boolean;
  /** Whether the server is stopping, so no agent is left waiting for its idle time. */
  closed(): boolean;
  /** Steps the server awaits before it stops; an agent being paused is one. */
  steps: Set<Promise<unknown>>;
}

/**
 * The agents running for threads, by thread: started on demand, stopped once left alone
 * long enough or when too many run, each keeping its session for the next turn.
 */
export class AgentPool {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  /** Stops an agent that is still starting, by thread. */
  private readonly starting = new Map<string, AbortController>();
  /** Stops each idle agent when its time is up. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** When each running agent last finished a turn, to stop the one left alone longest. */
  private readonly lastUsed = new Map<string, number>();
  /** Agents being stopped for a pause: the thread's next agent starts once they are gone. */
  private readonly pausing = new Map<string, Promise<void>>();
  private readonly idleMs: number;
  private readonly maxLiveAgents: number;
  private readonly options: AgentPoolOptions;
  private useSeq = 0;
  /** Set once every agent is being stopped: none starts after. */
  private closed = false;

  constructor(options: AgentPoolOptions) {
    this.options = options;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.maxLiveAgents = Math.max(1, options.maxLiveAgents ?? MAX_LIVE_AGENTS);
  }

  /** The thread's agent, running or starting, if it has one. */
  get(threadId: string): Promise<AgentSession> | undefined {
    return this.sessions.get(threadId);
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** Whether the thread's agent is still starting. */
  isStarting(threadId: string): boolean {
    return this.starting.has(threadId);
  }

  /** How many agents run for threads right now, starting ones included. */
  get live(): number {
    // Those being paused still run until their process is gone.
    return this.sessions.size + this.pausing.size;
  }

  /**
   * Starts the thread's agent with `start`, once an agent of the thread being paused is
   * gone. `owns` tells the start whether it is still the thread's current agent.
   */
  open(
    threadId: string,
    start: (signal: AbortSignal, owns: () => boolean) => Promise<AgentSession>,
  ): Promise<AgentSession> {
    // An agent started once all were stopped would be left running when the server ends.
    if (this.closed) return Promise.reject(new Error("MoonAgentic s'arrête."));
    this.makeRoom(threadId);
    const stop = new AbortController();
    this.starting.set(threadId, stop);
    // Only the session it started may take itself out: one paused earlier may exit late.
    const owns = () => this.sessions.get(threadId) === started;
    const paused = this.pausing.get(threadId) ?? Promise.resolve();
    const started: Promise<AgentSession> = paused
      .then(() => start(stop.signal, owns))
      .finally(() => {
        if (this.starting.get(threadId) === stop) this.starting.delete(threadId);
      });
    this.sessions.set(threadId, started);
    started.catch(() => {
      if (owns()) this.sessions.delete(threadId);
    });
    return started;
  }

  /** Stops the thread's agent if it is still starting. */
  abortStart(threadId: string): void {
    this.starting.get(threadId)?.abort();
  }

  /** The agent quit on its own: it leaves no timer or place in the queue. */
  exited(threadId: string): void {
    this.sessions.delete(threadId);
    this.clearIdle(threadId);
    this.lastUsed.delete(threadId);
  }

  /** Stops the thread's agent and resolves once its process, and one being paused, is gone. */
  async stop(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.exited(threadId);
    await session?.then((s) => s.close()).catch(() => undefined);
    // An agent being paused is gone too before its files change (Windows holds them open).
    await this.pausing.get(threadId);
  }

  /** Whether the thread's agent has nothing under way and can be stopped. */
  private canPause(threadId: string): boolean {
    return (
      this.sessions.has(threadId) && !this.starting.has(threadId) && !this.options.busy(threadId)
    );
  }

  /** A turn starts: the agent is not idle any more. */
  clearIdle(threadId: string): void {
    clearTimeout(this.idleTimers.get(threadId));
    this.idleTimers.delete(threadId);
  }

  /** A turn has ended: the agent waits, and is stopped if nothing comes. */
  leftIdle(threadId: string): void {
    this.clearIdle(threadId);
    if (this.options.closed() || !this.sessions.has(threadId)) {
      this.lastUsed.delete(threadId);
      return;
    }
    // A counter rather than the time: two turns ending in the same millisecond keep an order.
    this.lastUsed.set(threadId, ++this.useSeq);
    const timer = setTimeout(() => {
      this.idleTimers.delete(threadId);
      this.pause(threadId);
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(threadId, timer);
  }

  /**
   * Stops the thread's agent but keeps its session: the next message resumes it, or gives a
   * new one the conversation so far.
   */
  private pause(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session || !this.canPause(threadId)) {
      // Busy right now: tried again once it has been left alone as long again.
      if (session && !this.options.running(threadId)) this.leftIdle(threadId);
      return;
    }
    // A message sent meanwhile is not refused: its agent starts once this one is gone.
    this.sessions.delete(threadId);
    this.lastUsed.delete(threadId);
    this.clearIdle(threadId);
    const steps = this.options.steps;
    const closing: Promise<void> = session
      .then((s) => s.close())
      .catch(() => undefined)
      .finally(() => {
        if (this.pausing.get(threadId) === closing) this.pausing.delete(threadId);
        steps.delete(closing);
      });
    this.pausing.set(threadId, closing);
    steps.add(closing);
  }

  /** Before an agent starts, stops the ones left alone longest while too many run. */
  private makeRoom(threadId: string): void {
    let live = this.sessions.size;
    if (live < this.maxLiveAgents) return;
    const idle = [...this.lastUsed]
      .filter(([id]) => id !== threadId && this.canPause(id))
      .sort((a, b) => a[1] - b[1]);
    for (const [id] of idle) {
      if (live < this.maxLiveAgents) break;
      // The agent leaves the count at once; its process stops in the background.
      this.pause(id);
      live -= 1;
    }
  }

  /** Disarms every idle timer, as the server stops. */
  clearTimers(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  /** The threads whose agent is still starting. */
  startingThreads(): string[] {
    return [...this.starting.keys()];
  }

  /** Stops every running agent and resolves once they are gone. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all([
      ...sessions.map((s) => s.then((session) => session.close()).catch(() => undefined)),
      // Those being paused are gone too.
      ...this.pausing.values(),
    ]);
  }

  /** Forgets what is left once every turn has ended. */
  clear(): void {
    this.clearTimers();
    this.lastUsed.clear();
  }
}
