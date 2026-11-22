import type {
  AgentInfo,
  Favorites,
  Item,
  McpServerInfo,
  PendingRequest,
  Project,
  ReviewFile,
  ServerMessage,
  Thread,
} from "@moonagentic/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";

/** What changed on a thread's branch, or why it could not be read. */
export interface Review {
  files: ReviewFile[];
  error?: string;
  /** Files left out because there are too many to list. */
  omitted?: number;
}

export interface State {
  status: ConnectionStatus;
  /** False until the first snapshot arrives, so the UI does not flash empty lists. */
  ready: boolean;
  agents: AgentInfo[];
  favorites: Favorites;
  /** Permission requests waiting in every thread. */
  requests: PendingRequest[];
  mcpServers: McpServerInfo[];
  projects: Project[];
  threads: Thread[];
  items: Record<string, Item[]>;
  /** The last review fetched for each thread with its own branch. */
  reviews: Record<string, Review>;
  notice: string | null;
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
    case "requests":
      return { ...state, requests: message.requests };
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
            ...(message.omitted ? { omitted: message.omitted } : {}),
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
    case "files":
    case "catalog":
    case "searched":
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

export const initialState: State = {
  status: "connecting",
  ready: false,
  agents: [],
  favorites: {},
  requests: [],
  mcpServers: [],
  projects: [],
  threads: [],
  items: {},
  reviews: {},
  notice: null,
};
