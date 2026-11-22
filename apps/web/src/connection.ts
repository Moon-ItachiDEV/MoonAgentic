import type {
  AgentInfo,
  ClientMessage,
  Favorites,
  Item,
  McpServerInfo,
  ReviewFile,
  Project,
  ServerMessage,
  Thread,
} from "@moonagentic/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";

/** What changed on a thread's branch, or why it could not be read. */
export interface Review {
  files: ReviewFile[];
  error?: string;
}

export interface State {
  status: ConnectionStatus;
  /** False until the first snapshot arrives, so the UI does not flash empty lists. */
  ready: boolean;
  agents: AgentInfo[];
  favorites: Favorites;
  mcpServers: McpServerInfo[];
  projects: Project[];
  threads: Thread[];
  items: Record<string, Item[]>;
  /** The last review fetched for each thread with its own branch. */
  reviews: Record<string, Review>;
  notice: string | null;
}

const TOKEN_KEY = "moonagentic.token";

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

/** Applies one server message to the state; pure, so it is easy to test. */
export function reduce(state: State, message: ServerMessage): State {
  switch (message.type) {
    case "snapshot":
      return { ...state, ready: true, ...message.snapshot };
    case "agents":
      return { ...state, agents: message.agents };
    case "favorites":
      return { ...state, favorites: message.favorites };
    case "mcpServers":
      return { ...state, mcpServers: message.servers };
    case "review":
      return {
        ...state,
        reviews: {
          ...state.reviews,
          [message.threadId]: {
            files: message.files,
            ...(message.error ? { error: message.error } : {}),
          },
        },
      };
    case "project":
      return { ...state, projects: upsert(state.projects, message.project) };
    case "thread":
      return { ...state, threads: upsert(state.threads, message.thread) };
    case "items":
      return { ...state, items: { ...state.items, [message.threadId]: message.items } };
    case "item": {
      const items = state.items[message.threadId];
      if (!items) return state;
      return {
        ...state,
        items: { ...state.items, [message.threadId]: upsert(items, message.item, false) },
      };
    }
    case "append": {
      const items = state.items[message.threadId];
      if (!items) return state;
      const next = items.map((item) =>
        item.id === message.itemId && "text" in item
          ? { ...item, text: item.text + message.text }
          : item,
      );
      return { ...state, items: { ...state.items, [message.threadId]: next } };
    }
    case "error":
      return message.requestId ? state : { ...state, notice: message.message };
    case "created":
    case "done":
    case "shipped":
      return state;
  }
}

function upsert<T extends { id: string }>(list: T[], value: T, newestFirst = true): T[] {
  const index = list.findIndex((x) => x.id === value.id);
  if (index === -1) return newestFirst ? [value, ...list] : [...list, value];
  const copy = list.slice();
  copy[index] = value;
  return copy;
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

type Pending = { resolve: (id: string) => void; reject: (error: Error) => void };

export class Connection {
  private state: State = {
    status: "connecting",
    ready: false,
    agents: [],
    favorites: {},
    mcpServers: [],
    projects: [],
    threads: [],
    items: {},
    reviews: {},
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | null = null;
  private openThreadId: string | null = null;
  private retry = 0;
  private readonly token = readToken();

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
  request(message: Extract<ClientMessage, { requestId: string }>): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject });
      if (!this.send(message)) {
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
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "created") this.pending.get(message.requestId)?.resolve(message.id);
      if (message.type === "shipped")
        this.pending.get(message.requestId)?.resolve(message.url ?? "");
      if (message.type === "done") this.pending.get(message.requestId)?.resolve("");
      if (message.type === "error" && message.requestId) {
        this.pending.get(message.requestId)?.reject(new Error(message.message));
      }
      if ("requestId" in message && message.requestId) this.pending.delete(message.requestId);
      this.set(reduce(this.state, message));
    };
    socket.onclose = () => {
      this.socket = null;
      for (const p of this.pending.values()) p.reject(new Error("Connexion perdue."));
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
