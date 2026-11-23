import type { ClientMessage, RemoteAccess, ServerMessage } from "@moonagentic/protocol";
import { nextFrame } from "./frame.ts";
import { initialState, reduce, type State } from "./state.ts";

export type { ConnectionStatus, Review, State } from "./state.ts";

const TOKEN_KEY = "moonagentic.token";
/** The code the server closes a connection with when its token was replaced. */
const TOKEN_RENEWED = 4001;
export const ASK_TIMEOUT_MS = 60_000;
/** How often the server is pinged while the connection is open. */
export const PING_MS = 20_000;
/** A ping with no answer after this long means a dead connection: it is opened again. */
export const PONG_TIMEOUT_MS = 8_000;
/** Said when something the user did could not leave. */
export const NOT_SENT =
  "Pas de connexion : ton action n'est pas partie. Réessaie une fois reconnecté.";

export interface ConnectionOptions {
  askTimeoutMs?: number;
  /** How often the server is pinged; 0 for never. */
  pingMs?: number;
}

export function readToken(): string | null {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const fromHash = hashParams.get("token");
  const fromQuery = url.searchParams.get("token");
  const fromUrl = fromHash || fromQuery;
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // private mode: the token lives only in this tab
    }
    if (fromHash !== null) {
      hashParams.delete("token");
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
    }
    if (fromQuery !== null) url.searchParams.delete("token");
    history.replaceState(history.state, "", url);
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * A fresh id for a request. `crypto.randomUUID` is missing on pages opened over plain HTTP
 * from another machine, such as a phone on the local network.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Pending = {
  resolve: (reply: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Request = Extract<ClientMessage, { requestId: string }>;
/** What the server answers to each kind of request. */
type ReplyTo<T extends Request["type"]> = T extends "files.search"
  ? Extract<ServerMessage, { type: "files" }>
  : T extends "composer.catalog"
    ? Extract<ServerMessage, { type: "catalog" }>
    : T extends "search"
      ? Extract<ServerMessage, { type: "searched" }>
      : T extends "github.status"
        ? Extract<ServerMessage, { type: "github" }>
        : T extends "github.repos"
          ? Extract<ServerMessage, { type: "githubRepos" }>
          : T extends "github.login"
            ? Extract<ServerMessage, { type: "githubDevice" }>
            : T extends "local.clones"
              ? Extract<ServerMessage, { type: "localClones" }>
              : T extends "workspace.pr" | "workspace.mergePr" | "github.pr"
                ? Extract<ServerMessage, { type: "pullRequest" }>
                : ServerMessage;

export class Connection {
  private state: State = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | null = null;
  private openThreadIds = new Set<string>();
  private retry = 0;
  private token = readToken();
  /** A token being renewed: reconnecting waits for it, so it does not try the old one. */
  private renewal: Promise<unknown> | null = null;
  private readonly askTimeoutMs: number;
  private readonly pingMs: number;
  /** The wait before the next try, while the connection is closed. */
  /** Calls off the frame that waits to tell the page about text just written. */
  private callOffFrame: (() => void) | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  /** Incremented on each open attempt so superseded async ticket fetches never open a second socket. */
  private attempt = 0;

  constructor(options: ConnectionOptions = {}) {
    this.askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS;
    this.pingMs = options.pingMs ?? PING_MS;
    if (!this.token || !/^[\x21-\x7e]+$/.test(this.token)) {
      this.state = { ...this.state, status: "unauthorized" };
    } else {
      void this.open();
    }
    // A phone's screen coming back on, or its network: the connection is checked at once
    // rather than at the next ping, and a wait before a new try is cut short.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const wake = () => this.wake();
      window.addEventListener("online", wake);
      window.addEventListener("pageshow", wake);
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") wake();
      });
    }
  }

  /** Checks the connection now: pinged if it looks open, opened again at once if it waits. */
  wake(): void {
    if (this.state.status === "unauthorized") return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.ping();
    } else if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retry = 0;
      void this.open();
    }
  }

  /** Asks the server for a sign of life; without one in time, the connection is replaced. */
  private ping(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || this.pongTimer !== undefined) return;
    socket.send(JSON.stringify({ type: "ping" }));
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      // The browser may take minutes to notice: its close is not waited for.
      if (this.socket === socket) this.lost(socket, true);
      try {
        socket.close();
      } catch {
        // already gone
      }
    }, PONG_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  /** Shows a message to the user, for a failure no part of the page has room to show. */
  notify(message: string): void {
    this.set({ ...this.state, notice: message });
  }

  dismissNotice(): void {
    this.set({ ...this.state, notice: null });
  }

  /** Sends a request and resolves with what the server made: an id, or a link for a push. */
  async request(message: Request): Promise<string> {
    const reply = await this.ask(message);
    if (reply.type === "created") return reply.id;
    if (reply.type === "shipped") return reply.url ?? "";
    return "";
  }

  /** Sends a request and resolves with the server's reply to it. */
  ask<T extends Request>(
    message: T,
    timeoutMs: number = this.askTimeoutMs,
  ): Promise<ReplyTo<T["type"]>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(message.requestId)) return;
        reject(new Error("Le serveur MoonAgentic n'a pas répondu à temps."));
      }, timeoutMs);
      this.pending.set(message.requestId, {
        resolve: (reply) => resolve(reply as ReplyTo<T["type"]>),
        reject,
        timer,
      });
      let sent = false;
      try {
        sent = this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(new Error(NOT_SENT));
      }
    });
  }

  /** The token this device connects with: what a link for another device must carry. */
  getToken = () => this.token ?? "";

  /** Asks the server something about itself, over HTTP with the token. */
  private async api<T>(path: string, method: "GET" | "POST"): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, { method, headers: { authorization: `Bearer ${this.token}` } });
    } catch {
      throw new Error("Pas de connexion au serveur MoonAgentic.");
    }
    const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!response.ok || !body) {
      throw new Error(body?.message ?? `Le serveur a répondu ${response.status}.`);
    }
    return body;
  }

  /** How the server can be reached from another device, as it is right now. */
  remoteAccess(): Promise<RemoteAccess> {
    return this.api<RemoteAccess>("/api/remote", "GET");
  }

  /**
   * Replaces the access token. The server then closes every connection, this one included:
   * this device comes back with the new token, the others need the new link.
   */
  async renewToken(): Promise<string> {
    const renewal = this.api<{ token: string }>("/api/remote/token", "POST").then(({ token }) => {
      this.token = token;
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        // private mode: the token lives only in this tab
      }
      return token;
    });
    this.renewal = renewal.catch(() => undefined);
    try {
      return await renewal;
    } finally {
      this.renewal = null;
    }
  }

  send(message: ClientMessage): boolean {
    if (message.type === "thread.open") this.openThreadIds.add(message.threadId);
    if (message.type === "thread.leave") this.openThreadIds.delete(message.threadId);
    if (this.socket?.readyState !== WebSocket.OPEN) {
      // Which threads are shown is told again once connected; anything else is an action
      // of the user's that did not leave, and they are told so.
      if (message.type !== "thread.open" && message.type !== "thread.leave") {
        this.notify(NOT_SENT);
      }
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private async open(): Promise<void> {
    const attempt = ++this.attempt;
    let ticket: string | null = null;
    try {
      const response = await fetch("/api/ws-ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${this.token ?? ""}` },
      });
      if (attempt !== this.attempt) return;
      if (response.status === 401) {
        if (this.renewal) {
          await this.renewal;
          if (attempt === this.attempt) void this.open();
          return;
        }
        this.set({ ...this.state, status: "unauthorized" });
        return;
      }
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { ticket?: unknown } | null;
        if (typeof body?.ticket === "string" && body.ticket) ticket = body.ticket;
      }
    } catch {
      // Network unreachable: retry with backoff below.
    }
    if (attempt !== this.attempt) return;
    if (!ticket) {
      this.set({ ...this.state, status: "closed" });
      this.scheduleRetry();
      return;
    }
    const url = new URL("/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.retry = 0;
      this.set({
        ...this.state,
        status: "open",
        // What could not leave can now: the notice that said so is out of date.
        notice: this.state.notice === NOT_SENT ? null : this.state.notice,
      });
      this.stopHeartbeat();
      if (this.pingMs > 0) this.pingTimer = setInterval(() => this.ping(), this.pingMs);
      for (const threadId of this.openThreadIds)
        socket.send(JSON.stringify({ type: "thread.open", threadId }));
    };
    socket.onmessage = (event) => {
      // A connection already given up on has nothing more to say.
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as ServerMessage;
      } catch (error) {
        console.warn("Trame WebSocket invalide ignorée :", error);
        return;
      }
      // Any message is a sign of life.
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId) {
        const pending = this.pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          if (message.type === "error") pending.reject(new Error(message.message));
          else pending.resolve(message);
        }
      }
      const next = reduce(this.state, message);
      if (message.type === "append") this.setSoon(next);
      else this.set(next);
    };
    socket.onclose = (event) => this.lost(socket, opened, event.code);
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    const wait = Math.min(1000 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.open();
    }, wait);
  }

  /** The connection is gone: what waited on it fails, and a new one is tried after a wait. */
  private lost(which: WebSocket, wasOpen: boolean, code?: number): void {
    // Once only, whether the heartbeat or the browser noticed first.
    if (this.socket !== which) return;
    this.socket = null;
    this.stopHeartbeat();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Connexion perdue."));
    }
    this.pending.clear();
    this.set({ ...this.state, status: "closed" });
    const attempt = this.attempt;
    // A refused upgrade looks like any other failure; ask the server whether the token is the cause.
    // After a renewal the old token is refused too, so it is asked again, with the new one
    // on the device that renewed it.
    const check = Promise.resolve(this.renewal).then(() =>
      wasOpen && code !== TOKEN_RENEWED ? true : this.tokenAccepted(),
    );
    void check.then((accepted) => {
      if (attempt !== this.attempt) return;
      if (!accepted) return this.set({ ...this.state, status: "unauthorized" });
      this.scheduleRetry();
    });
  }

  private async tokenAccepted(): Promise<boolean> {
    try {
      const response = await fetch("/api/auth", {
        headers: { authorization: `Bearer ${this.token}` },
      });
      return response.status !== 401;
    } catch {
      return true;
    }
  }

  private set(next: State): void {
    this.state = next;
    this.callOffFrame?.();
    this.callOffFrame = undefined;
    for (const listener of this.listeners) listener();
  }

  /**
   * Takes text an agent is writing: a fast model sends hundreds of pieces a second, and
   * the screen only draws sixty times. The state is right at once; the page is told at
   * the next frame, once for all the pieces that came meanwhile.
   */
  private setSoon(next: State): void {
    this.state = next;
    this.callOffFrame ??= nextFrame(() => {
      this.callOffFrame = undefined;
      for (const listener of this.listeners) listener();
    });
  }
}

export const connection = new Connection();
