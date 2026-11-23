import type {
  ClientMessage,
  PairedDevice,
  RemoteAccess,
  ServerMessage,
} from "@moonagentic/protocol";
import { nextFrame } from "./frame.ts";
import { deviceName } from "./remote.ts";
import { initialState, reduce, type State } from "./state.ts";

export type { ConnectionStatus, Review, State } from "./state.ts";

const TOKEN_KEY = "moonagentic.token";
/** The code the server closes a connection with when its token was replaced. */
const TOKEN_RENEWED = 4001;
/** The code the server closes a device's connections with when it is revoked. */
const DEVICE_REVOKED = 4003;
export const ASK_TIMEOUT_MS = 60_000;
/**
 * What the server may work on for longer than that: a clone, a push, a merge. The page
 * waits a little more than the server gives the work, rather than say that nothing came
 * while it still runs, which invites doing it a second time.
 */
export const LONG_ASKS_MS: Readonly<Record<string, number>> = {
  // The server gives a clone 15 minutes.
  "project.clone": 16 * 60_000,
  // A commit, a push the server gives 5 minutes, then the pull request.
  "workspace.ship": 7 * 60_000,
  "team.ship": 7 * 60_000,
  // GitHub has 2 minutes to merge, and is then asked how the pull request stands.
  "workspace.mergePr": 3 * 60_000,
  // The remote is asked for its branch first, then git merges.
  "workspace.forecast": 2 * 60_000,
  "workspace.sync": 3 * 60_000,
  // The remote is asked for its branch, then each branch is compared with it.
  "project.branches": 2 * 60_000,
  // Each thread with its own branch is asked what changed there.
  "artifacts.list": 2 * 60_000,
  "project.deleteBranches": 3 * 60_000,
};
/** How long the page waits for the answer to a request of this type. */
export const askTimeoutFor = (type: string, usual: number = ASK_TIMEOUT_MS): number =>
  Math.max(usual, LONG_ASKS_MS[type] ?? 0);
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
 * The one-time code of a pairing link (`#pair=…`), taken out of the address at once so it
 * stays in no history or bookmark.
 */
export function readPairCode(): string | null {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = hashParams.get("pair");
  if (code === null) return null;
  hashParams.delete("pair");
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  history.replaceState(history.state, "", url);
  return code || null;
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

/** What the server refused, with the HTTP status it answered. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
      : T extends "activity"
        ? Extract<ServerMessage, { type: "activity" }>
        : T extends "item.get"
          ? Extract<ServerMessage, { type: "fullItem" }>
          : T extends "thread.page"
            ? Extract<ServerMessage, { type: "page" }>
            : T extends "thread.read"
              ? Extract<ServerMessage, { type: "timeline" }>
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
                        : T extends "workspace.forecast"
                          ? Extract<ServerMessage, { type: "forecast" }>
                          : T extends "workspace.files"
                            ? Extract<ServerMessage, { type: "worktreeFiles" }>
                            : T extends "workspace.readFile"
                              ? Extract<ServerMessage, { type: "worktreeFile" }>
                              : T extends "project.branches"
                                ? Extract<ServerMessage, { type: "projectBranches" }>
                                : T extends "project.deleteBranches"
                                  ? Extract<ServerMessage, { type: "branchesDeleted" }>
                                  : T extends "artifacts.list"
                                    ? Extract<ServerMessage, { type: "artifacts" }>
                                    : T extends "artifacts.open"
                                      ? Extract<ServerMessage, { type: "artifactLink" }>
                                      : ServerMessage;

export class Connection {
  private state: State = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | null = null;
  private openThreadIds = new Set<string>();
  /** How many parts of the page show each thread: it is left once none does. */
  private readonly shownBy = new Map<string, number>();
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
    const pairCode = readPairCode();
    if (pairCode) {
      // Opened from a pairing link: this device gets its own token first.
      this.pair(pairCode).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        if (this.usableToken()) {
          // Already paired: it connects as before, and says why the link did nothing.
          this.notify(`Appairage refusé : ${why}`);
          void this.open();
        } else {
          this.pairError = why;
          this.set({ ...this.state, status: "unauthorized" });
        }
      });
    } else if (!this.usableToken()) {
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

  private usableToken(): boolean {
    return !!this.token && /^[\x21-\x7e]+$/.test(this.token);
  }

  /** Why the last pairing failed, to show on the page asking for a code. */
  pairError: string | null = null;

  /**
   * Pairs this device with a code shown on the computer: the server gives it a token of its
   * own, kept here, and the connection opens with it.
   */
  async pair(code: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch("/api/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: deviceName(navigator.userAgent) }),
      });
    } catch {
      throw new Error("Pas de connexion au serveur MoonAgentic.");
    }
    const body = (await response.json().catch(() => null)) as {
      token?: string;
      message?: string;
    } | null;
    if (response.status === 429) throw new Error("Trop d'essais : réessaie dans une minute.");
    if (!response.ok || !body?.token) {
      throw new Error(body?.message ?? `Le serveur a répondu ${response.status}.`);
    }
    this.token = body.token;
    try {
      localStorage.setItem(TOKEN_KEY, body.token);
    } catch {
      // private mode: the token lives only in this tab
    }
    this.pairError = null;
    this.set({ ...this.state, status: "connecting" });
    void this.open();
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
    timeoutMs: number = askTimeoutFor(message.type, this.askTimeoutMs),
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

  /** The token this device connects with, for what it reads over HTTP. */
  getToken = () => this.token ?? "";

  /** Asks the server something about itself, over HTTP with the token. */
  private async api<T>(path: string, method: "GET" | "POST", payload?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      throw new Error("Pas de connexion au serveur MoonAgentic.");
    }
    const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!response.ok || !body) {
      throw new ApiError(
        body?.message ?? `Le serveur a répondu ${response.status}.`,
        response.status,
      );
    }
    return body;
  }

  /**
   * The paired devices, or `null` on a device itself: only the computer MoonAgentic runs on
   * pairs and revokes them.
   */
  async devices(): Promise<PairedDevice[] | null> {
    try {
      return (await this.api<{ devices: PairedDevice[] }>("/api/devices", "GET")).devices;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return null;
      throw error;
    }
  }

  /** A one-time code for a phone to pair with, for a few minutes. */
  startPairing(): Promise<{ code: string; expiresAt: number }> {
    return this.api("/api/pair/start", "POST");
  }

  /** Revokes a device: its connections close and its token stops working at once. */
  async revokeDevice(id: string): Promise<PairedDevice[]> {
    return (await this.api<{ devices: PairedDevice[] }>("/api/devices/revoke", "POST", { id }))
      .devices;
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

  /**
   * The message that shows a thread. A timeline this screen already holds comes with its
   * mark, so the server sends what changed since rather than all of it again.
   */
  private opening(threadId: string): ClientMessage {
    const held = this.state.items[threadId] && this.state.held[threadId];
    if (!held) return { type: "thread.open", threadId };
    const { epoch, rev, first } = held;
    return { type: "thread.open", threadId, since: { epoch, rev, first } };
  }

  send(message: ClientMessage): boolean {
    if (message.type === "thread.open") {
      this.shownBy.set(message.threadId, (this.shownBy.get(message.threadId) ?? 0) + 1);
      this.openThreadIds.add(message.threadId);
      message = this.opening(message.threadId);
    }
    if (message.type === "thread.leave") {
      // Still shown elsewhere (a conversation and its team's tree): the server keeps sending.
      const left = (this.shownBy.get(message.threadId) ?? 1) - 1;
      if (left > 0) {
        this.shownBy.set(message.threadId, left);
        return true;
      }
      this.shownBy.delete(message.threadId);
      this.openThreadIds.delete(message.threadId);
    }
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
      // Connected: a pairing that failed earlier says nothing about a later loss of access.
      this.pairError = null;
      this.set({
        ...this.state,
        status: "open",
        // What could not leave can now: the notice that said so is out of date.
        notice: this.state.notice === NOT_SENT ? null : this.state.notice,
      });
      this.stopHeartbeat();
      if (this.pingMs > 0) this.pingTimer = setInterval(() => this.ping(), this.pingMs);
      for (const threadId of this.openThreadIds)
        socket.send(JSON.stringify(this.opening(threadId)));
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
      wasOpen && code !== TOKEN_RENEWED && code !== DEVICE_REVOKED ? true : this.tokenAccepted(),
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
