import type {
  AgentQuota,
  CoordinatorSettings,
  AgentInfo,
  Favorites,
  Item,
  McpServerInfo,
  PendingQuestion,
  PendingRequest,
  PlanTask,
  Project,
  ReviewFile,
  Schedule,
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
  coordinator: CoordinatorSettings;
  /** Permission requests waiting in every thread. */
  requests: PendingRequest[];
  /** Questions agents hold their turn on, in every thread. */
  questions: PendingQuestion[];
  mcpServers: McpServerInfo[];
  mcpSecretsError: string | null;
  projects: Project[];
  threads: Thread[];
  /** The planner's cards, of every project. */
  plan: PlanTask[];
  /** The tasks planned for later, of every project. */
  schedules: Schedule[];
  /** What each agent's subscription has left, as last read. */
  quotas: AgentQuota[];
  items: Record<string, Item[]>;
  /** The last review fetched for each thread with its own branch. */
  reviews: Record<string, Review>;
  notice: string | null;
  /** How the last sign-in to GitHub started from MoonAgentic ended, numbered so each is seen. */
  githubLogin: {
    seq: number;
    state: "done" | "failed" | "cancelled";
    login?: string;
    error?: string;
  } | null;
}

/** Applies one server message to the state; pure, so it is easy to test. */
export function reduce(state: State, message: ServerMessage): State {
  switch (message.type) {
    case "snapshot":
      return {
        ...state,
        ready: true,
        ...message.snapshot,
        mcpSecretsError: message.snapshot.mcpSecretsError ?? null,
      };
    case "agents":
      return { ...state, agents: message.agents };
    case "favorites":
      return { ...state, favorites: message.favorites };
    case "coordinatorSettings":
      return { ...state, coordinator: message.settings };
    case "requests":
      return { ...state, requests: message.requests };
    case "questions":
      return { ...state, questions: message.questions };
    case "mcpServers":
      return {
        ...state,
        mcpServers: message.servers,
        mcpSecretsError: message.error ?? null,
      };
    case "quotas":
      return { ...state, quotas: message.quotas };
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
    case "planTask":
      return { ...state, plan: upsert(state.plan, message.task, false) };
    case "planTaskRemoved":
      return { ...state, plan: state.plan.filter((c) => c.id !== message.id) };
    case "schedule":
      return { ...state, schedules: upsert(state.schedules, message.schedule, false) };
    case "scheduleRemoved":
      return { ...state, schedules: state.schedules.filter((s) => s.id !== message.id) };
    case "threadRemoved": {
      const { [message.threadId]: _items, ...items } = state.items;
      const { [message.threadId]: _review, ...reviews } = state.reviews;
      return {
        ...state,
        threads: state.threads.filter((t) => t.id !== message.threadId),
        items,
        reviews,
        requests: state.requests.filter((r) => r.threadId !== message.threadId),
        questions: state.questions.filter((q) => q.threadId !== message.threadId),
      };
    }
    case "projectRemoved": {
      const gone = new Set(
        state.threads.filter((t) => t.projectId === message.projectId).map((t) => t.id),
      );
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== message.projectId),
        threads: state.threads.filter((t) => !gone.has(t.id)),
        items: Object.fromEntries(Object.entries(state.items).filter(([id]) => !gone.has(id))),
        reviews: Object.fromEntries(Object.entries(state.reviews).filter(([id]) => !gone.has(id))),
        requests: state.requests.filter((r) => !gone.has(r.threadId)),
        questions: state.questions.filter((q) => !gone.has(q.threadId)),
        plan: state.plan.filter((c) => c.projectId !== message.projectId),
        schedules: state.schedules.filter((s) => s.projectId !== message.projectId),
      };
    }
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
    case "githubLogin": {
      const { type: _type, ...result } = message;
      return { ...state, githubLogin: { seq: (state.githubLogin?.seq ?? 0) + 1, ...result } };
    }
    case "error":
      return message.requestId ? state : { ...state, notice: message.message };
    case "created":
    case "done":
    case "shipped":
    case "files":
    case "catalog":
    case "searched":
    case "github":
    case "githubRepos":
    case "githubDevice":
    case "localClones":
    case "pullRequest":
    case "pong":
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
  coordinator: { routes: {} },
  requests: [],
  questions: [],
  mcpServers: [],
  mcpSecretsError: null,
  projects: [],
  threads: [],
  plan: [],
  schedules: [],
  quotas: [],
  items: {},
  reviews: {},
  notice: null,
  githubLogin: null,
};
