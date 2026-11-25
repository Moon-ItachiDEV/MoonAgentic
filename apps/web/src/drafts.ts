// What is typed in a thread and not sent yet: kept for that thread, through another thread
// opened, a reload, or going back, on this device only. Sending it forgets it.

const DRAFTS_KEY = "moonagentic.drafts";
/** The threads whose draft is kept, the most recent first: older ones are forgotten. */
export const MAX_DRAFTS = 30;
/** What is kept of one draft at most. */
export const MAX_DRAFT_CHARS = 50_000;

type Drafts = Record<string, { text: string; at: number }>;

/** Kept here too: a device that keeps nothing (private mode) still has them until a reload. */
let memory: Drafts | undefined;

function load(): Drafts {
  if (memory) return memory;
  memory = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, draft] of Object.entries(parsed as Record<string, unknown>)) {
        if (!draft || typeof draft !== "object") continue;
        const { text, at } = draft as { text?: unknown; at?: unknown };
        if (typeof text === "string" && text && typeof at === "number") memory[id] = { text, at };
      }
    }
  } catch {
    // nothing kept, or not readable: no drafts
  }
  return memory;
}

function save(drafts: Drafts): void {
  memory = drafts;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // private mode or full: kept in this page only
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
    return save(drafts);
  }
  if (drafts[threadId]?.text === text) return;
  drafts[threadId] = { text: text.slice(0, MAX_DRAFT_CHARS), at: Date.now() };
  const kept = Object.entries(drafts)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DRAFTS);
  save(Object.fromEntries(kept));
}

/** For tests: forgets what this page holds, so the next read goes to the storage. */
export function forgetDraftsInMemory(): void {
  memory = undefined;
}
