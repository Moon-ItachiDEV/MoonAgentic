import type { ClientMessage, RemoteAccess, ServerMessage } from "@moonagentic/protocol";
import { initialState, reduce, type State } from "./state.ts";

export type { ConnectionStatus, Review, State } from "./state.ts";

const TOKEN_KEY = "moonagentic.token";
/** The code the server closes a connection with when its token was replaced. */
const TOKEN_RENEWED = 4001;

function readToken(): string | null {
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

type Pending = { resolve: (reply: ServerMessage) => void; reject: (error: Error) => void };
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
  private token = readToken();
  /** A token being renewed: reconnecting waits for it, so it does not try the old one. */
  private renewal: Promise<unknown> | null = null;

  constructor() {
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
  ask<T extends Request>(message: T): Promise<ReplyTo<T["type"]>> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        resolve: (reply) => resolve(reply as ReplyTo<T["type"]>),
        reject,
      });
      if (!this.send(message)) {
        this.pending.delete(message.requestId);
        reject(new Error("Pas de connexion au serveur MoonAgentic."));
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
      const message = JSON.parse(String(event.data)) as ServerMessage;
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId) {
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (message.type === "error") pending?.reject(new Error(message.message));
        else pending?.resolve(message);
      }
      this.set(reduce(this.state, message));
    };
    socket.onclose = (event) => {
      this.socket = null;
      for (const p of this.pending.values()) p.reject(new Error("Connexion perdue."));
      this.pending.clear();
      this.set({ ...this.state, status: "closed" });
      const wait = Math.min(1000 * 2 ** this.retry, 10_000);
      this.retry += 1;
      // A refused upgrade looks like any other failure; ask the server whether the token is the cause.
      // After a renewal the old token is refused too, so it is asked again, with the new one
      // on the device that renewed it.
      const check = Promise.resolve(this.renewal).then(() =>
        opened && event.code !== TOKEN_RENEWED ? true : this.tokenAccepted(),
      );
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
