import type { ClientMessage, ServerMessage } from "@moonagentic/protocol";
import { initialState, reduce, type State } from "./state.ts";

export type { ConnectionStatus, Review, State } from "./state.ts";

const TOKEN_KEY = "moonagentic.token";
export const ASK_TIMEOUT_MS = 60_000;

export interface ConnectionOptions {
  askTimeoutMs?: number;
}

function readToken(): string | null {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // private mode: the token lives only in this tab
    }
    url.searchParams.delete("token");
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
          : ServerMessage;

export class Connection {
  private state: State = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | null = null;
  private openThreadId: string | null = null;
  private retry = 0;
  private readonly token = readToken();
  private readonly askTimeoutMs: number;

  constructor(options: ConnectionOptions = {}) {
    this.askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS;
    if (!this.token) this.state = { ...this.state, status: "unauthorized" };
    else this.open();
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
        reject(new Error("Pas de connexion au serveur MoonAgentic."));
      }
    });
  }

  send(message: ClientMessage): boolean {
    if (message.type === "thread.open") this.openThreadId = message.threadId;
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    const url = new URL("/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.token ?? "");
    const socket = new WebSocket(url);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.retry = 0;
      this.set({ ...this.state, status: "open" });
      if (this.openThreadId)
        socket.send(JSON.stringify({ type: "thread.open", threadId: this.openThreadId }));
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as ServerMessage;
      } catch (error) {
        console.warn("Trame WebSocket invalide ignorée :", error);
        return;
      }
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
      this.set(reduce(this.state, message));
    };
    socket.onclose = () => {
      this.socket = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Connexion perdue."));
      }
      this.pending.clear();
      this.set({ ...this.state, status: "closed" });
      const wait = Math.min(1000 * 2 ** this.retry, 10_000);
      this.retry += 1;
      // A refused upgrade looks like any other failure; ask the server whether the token is the cause.
      const check = opened ? Promise.resolve(true) : this.tokenAccepted();
      void check.then((accepted) => {
        if (accepted) setTimeout(() => this.open(), wait);
        else this.set({ ...this.state, status: "unauthorized" });
      });
    };
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
    for (const listener of this.listeners) listener();
  }
}

export const connection = new Connection();
