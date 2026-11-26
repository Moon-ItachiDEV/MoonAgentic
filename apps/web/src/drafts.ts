// What is typed in a thread and not sent yet: kept for that thread, through another thread
// opened, a reload, or going back, on this device only. Sending it forgets it.

const DRAFTS_KEY = "moonagentic.drafts";
/** The threads whose draft is kept, the most recent first: older ones are forgotten. */
export const MAX_DRAFTS = 30;
/** What is kept of one draft at most. */
export const MAX_DRAFT_CHARS = 50_000;

type Drafts = Record<string, { text: string; at: number }>;

/** Kept here too: a device that keeps nothing (private mode) still has them until a reload. */
let memory: Drafts = {};

function load(): Drafts {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (raw === null) {
      memory = {};
      return memory;
    }
    const parsed: unknown = JSON.parse(raw);
    const read: Drafts = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, draft] of Object.entries(parsed as Record<string, unknown>)) {
        if (!draft || typeof draft !== "object") continue;
        const { text, at } = draft as { text?: unknown; at?: unknown };
        if (typeof text === "string" && text && typeof at === "number") read[id] = { text, at };
      }
    }
    memory = read;
    return memory;
  } catch {
    // Private mode or unreadable storage: keep using what this tab holds in memory.
    return memory;
  }
}

function save(entries: [string, { text: string; at: number }][]): void {
  memory = Object.fromEntries(entries);
  if (!entries.length) {
    try {
      localStorage.setItem(DRAFTS_KEY, "{}");
    } catch {
      // private mode
    }
    return;
  }
  // Drop the oldest drafts if storage is nearly full, so the latest one still saves.
  for (let kept = entries.length; kept >= 1; kept -= 1) {
    const slice = Object.fromEntries(entries.slice(0, kept));
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(slice));
      memory = slice;
      return;
    } catch {
      // Storage is full or private mode: try fewer entries, keeping memory intact if none fits.
    }
  }
}

/** The draft of a thread, or "" when there is none. */
export function readDraft(threadId: string): string {
  return load()[threadId]?.text ?? "";
}

/** Keeps what is typed in a thread; nothing typed forgets its draft. */
export function writeDraft(threadId: string, text: string): void {
  const drafts = { ...load() };
  if (!text.trim()) {
    if (!(threadId in drafts)) return;
    delete drafts[threadId];
    return save(Object.entries(drafts).sort((a, b) => b[1].at - a[1].at));
  }
  const clipped = text.slice(0, MAX_DRAFT_CHARS);
  if (drafts[threadId]?.text === clipped) return;
  delete drafts[threadId];
  const others = Object.entries(drafts)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DRAFTS - 1);
  // Placed first so the draft just typed is never dropped on a same-millisecond tie.
  save([[threadId, { text: clipped, at: Date.now() }], ...others]);
}

/** Forgets the draft of a removed thread (or of several threads when a project is removed). */
export function forgetDrafts(threadIds: Iterable<string>): void {
  const drafts = { ...load() };
  let changed = false;
  for (const id of threadIds) {
    if (id in drafts) {
      delete drafts[id];
      changed = true;
    }
  }
  if (changed) save(Object.entries(drafts).sort((a, b) => b[1].at - a[1].at));
}

/** Forgets every draft kept on this device (when its access was revoked). */
export function clearAllDrafts(): void {
  memory = {};
  try {
    localStorage.removeItem(DRAFTS_KEY);
  } catch {
    // private mode
  }
}

/** For tests: forgets what this page holds, so the next read goes to the storage. */
export function forgetDraftsInMemory(): void {
  memory = {};
}
