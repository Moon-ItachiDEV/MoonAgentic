import type {
  AppInfo,
  Defaults,
  TeamPreset,
  RoleMascots,
  AgentQuota,
  CoordinatorSettings,
  AgentInfo,
  FavoriteRef,
  Favorites,
  HermesStatus,
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
  TimelineMark,
} from "@moonagentic/protocol";
import { unpackSnapshot } from "@moonagentic/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";

/** What changed on a thread's branch, or why it could not be read. */
export interface Review {
  files: ReviewFile[];
  error?: string;
  /** Files left out because there are too many to list. */
  omitted?: number;
}

/**
 * Which part of a thread's timeline this screen holds: from the item numbered `first` to the
 * end, with `earlier` items before it left on the server, as of the server's change `rev`.
 */
export interface Held extends TimelineMark {
  earlier: number;
}

export interface State {
  status: ConnectionStatus;
  /** False until the first snapshot arrives, so the UI does not flash empty lists. */
  ready: boolean;
  agents: AgentInfo[];
  favorites: Favorites;
  /** The order of the favorites wheel, as the user set it. */
  favoriteOrder: FavoriteRef[];
  coordinator: CoordinatorSettings;
  /** Hermes on Discord, once asked with `hermes.get` or changed. */
  hermes: HermesStatus | null;
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
  /** Whether a code for /lock is set on the computer. */
  lockPin: boolean;
  /** True when connected as a paired device rather than the computer itself. */
  pairedDevice: boolean;
  /** The defaults for a new thread kept by the server; null until set on any device. */
  defaults: Defaults | null;
  /** The teams set up in the settings; null while the suggested ones stand. */
  teamPresets: TeamPreset[] | null;
  roleMascots: RoleMascots;
  /** MoonAgentic's own version and what it knows of a newer one. */
  app: AppInfo | null;
  /** Why the server saves nothing right now (a full disk, a held database); null otherwise. */
  storageError: string | null;
  items: Record<string, Item[]>;
  /** What part of each of those timelines is held. */
  held: Record<string, Held>;
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
    case "snapshot": {
      // Each list of `/` commands came once: every thread gets its own back.
      const snapshot = unpackSnapshot(message.snapshot);
      // A thread left out (removed, or of a project just locked) leaves nothing behind here.
      const kept = new Set(snapshot.threads.map((t) => t.id));
      const keep = <T>(byThread: Record<string, T>) =>
        Object.fromEntries(Object.entries(byThread).filter(([id]) => kept.has(id)));
      return {
        ...state,
        ready: true,
        ...snapshot,
        lockPin: snapshot.lockPin ?? false,
        pairedDevice: snapshot.pairedDevice ?? false,
        favoriteOrder: snapshot.favoriteOrder ?? [],
        defaults: snapshot.defaults ?? null,
        teamPresets: snapshot.teamPresets ?? null,
        roleMascots: snapshot.roleMascots ?? {},
        app: snapshot.app ?? null,
        storageError: snapshot.storageError ?? null,
        mcpSecretsError: snapshot.mcpSecretsError ?? null,
        items: keep(state.items),
        held: keep(state.held),
        reviews: keep(state.reviews),
      };
    }
    case "agents":
      return { ...state, agents: message.agents };
    case "favorites":
      return {
        ...state,
        favorites: message.favorites,
        favoriteOrder: message.order ?? state.favoriteOrder,
      };
    case "defaults":
      return { ...state, defaults: message.defaults };
    case "app":
      return { ...state, app: message.app };
    case "storage":
      return { ...state, storageError: message.error };
    case "teamPresets":
      return { ...state, teamPresets: message.presets };
    case "roleMascots":
      return { ...state, roleMascots: message.mascots };
    case "coordinatorSettings":
      return { ...state, coordinator: message.settings };
    case "hermes":
      return { ...state, hermes: message.hermes };
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
      const { [message.threadId]: _held, ...held } = state.held;
      const { [message.threadId]: _review, ...reviews } = state.reviews;
      return {
        ...state,
        threads: state.threads.filter((t) => t.id !== message.threadId),
        items,
        held,
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
        held: Object.fromEntries(Object.entries(state.held).filter(([id]) => !gone.has(id))),
        reviews: Object.fromEntries(Object.entries(state.reviews).filter(([id]) => !gone.has(id))),
        requests: state.requests.filter((r) => !gone.has(r.threadId)),
        questions: state.questions.filter((q) => !gone.has(q.threadId)),
        plan: state.plan.filter((c) => c.projectId !== message.projectId),
        schedules: state.schedules.filter((s) => s.projectId !== message.projectId),
      };
    }
    case "items": {
      const { type: _type, threadId, items, ...held } = message;
      return {
        ...state,
        items: { ...state.items, [threadId]: items },
        held: { ...state.held, [threadId]: held },
      };
    }
    case "item":
      return changed(state, message.threadId, [message], message.rev);
    case "changes":
      return changed(state, message.threadId, message.items, message.rev);
    case "append": {
      const items = state.items[message.threadId];
      const held = state.held[message.threadId];
      if (!items || !held) return state;
      const next = items.map((item) =>
        item.id === message.itemId && "text" in item
          ? { ...item, text: item.text + message.text }
          : item,
      );
      return {
        ...state,
        items: { ...state.items, [message.threadId]: next },
        held: { ...state.held, [message.threadId]: { ...held, rev: message.rev } },
      };
    }
    case "page": {
      const items = state.items[message.threadId];
      const held = state.held[message.threadId];
      // Only the stretch just before what is held: an answer that comes late, after the
      // timeline was sent again, has nowhere to go. One asked for an export is not shown.
      if (message.apart || !items || held?.first !== message.before) return state;
      const known = new Set(items.map((i) => i.id));
      return {
        ...state,
        items: {
          ...state.items,
          [message.threadId]: [...message.items.filter((i) => !known.has(i.id)), ...items],
        },
        held: {
          ...state.held,
          [message.threadId]: { ...held, first: message.first, earlier: message.earlier },
        },
      };
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
    case "activity":
    case "fullItem":
    case "github":
    case "githubRepos":
    case "githubDevice":
    case "localClones":
    case "pullRequest":
    case "prRemarks":
    case "mcpTools":
    case "forecast":
    case "worktreeFiles":
    case "worktreeFile":
    case "projectBranches":
    case "projectSetup":
    case "branchesDeleted":
    case "artifacts":
    case "artifactLink":
    case "fileLink":
    case "pushState":
    case "pong":
    case "ws.ticket":
      return state;
  }
}

/**
 * Takes items new or changed into a thread's timeline. One from before what the screen
 * holds is left where it is, on the server: it is not the timeline's next item.
 */
function changed(
  state: State,
  threadId: string,
  changes: { item: Item; seq: number }[],
  rev: number,
): State {
  const held = state.held[threadId];
  const before = state.items[threadId];
  if (!before || !held) return state;
  const items = before.slice();
  for (const { item, seq } of changes) {
    const index = items.findIndex((i) => i.id === item.id);
    if (index !== -1) items[index] = item;
    else if (seq >= held.first) items.push(item);
  }
  return {
    ...state,
    items: { ...state.items, [threadId]: items },
    held: { ...state.held, [threadId]: { ...held, rev } },
  };
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
  favoriteOrder: [],
  coordinator: { routes: {} },
  hermes: null,
  requests: [],
  questions: [],
  mcpServers: [],
  mcpSecretsError: null,
  projects: [],
  threads: [],
  plan: [],
  schedules: [],
  quotas: [],
  lockPin: false,
  pairedDevice: false,
  defaults: null,
  teamPresets: null,
  roleMascots: {},
  app: null,
  storageError: null,
  items: {},
  held: {},
  reviews: {},
  notice: null,
  githubLogin: null,
};
