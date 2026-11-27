// The state of the pull requests whose links are on screen, asked from GitHub through the
// server and kept fresh while they are shown. A link has no color until GitHub has answered.
import type { PullRequestInfo } from "@moonagentic/protocol";
import { connection, newId } from "./connection.ts";
import { isPageHidden, onPageVisibility } from "./visibility.ts";

type PrState = PullRequestInfo["state"];
interface Entry {
  state?: PrState;
  /** When GitHub was last asked, whatever came back. */
  askedAt: number;
  asking: boolean;
  /** How many links to it are on screen. */
  shown: number;
}

const REFRESH_MS = 2 * 60_000;
/** How soon a link is asked about again when the server could not be reached. */
const RETRY_MS = 10_000;
const AT_ONCE = 2;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queue: string[] = [];
let running = 0;
let version = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const entryOf = (url: string): Entry => {
  let entry = entries.get(url);
  if (!entry) {
    entry = { askedAt: 0, asking: false, shown: 0 };
    entries.set(url, entry);
  }
  return entry;
};

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function pump(): void {
  while (running < AT_ONCE && queue.length) {
    const url = queue.shift()!;
    const entry = entryOf(url);
    running += 1;
    connection
      .ask({ type: "github.pr", requestId: newId(), url })
      .then(
        (reply) => {
          entry.askedAt = Date.now();
          if (reply.pr && reply.pr.state !== entry.state) {
            entry.state = reply.pr.state;
            changed();
          }
        },
        () => {
          // No connection, as when a phone wakes up: asked again soon, not in two minutes.
          entry.askedAt = Date.now() - REFRESH_MS + RETRY_MS;
        },
      )
      .finally(() => {
        entry.asking = false;
        running -= 1;
        pump();
      });
  }
}

function ask(url: string): void {
  const entry = entryOf(url);
  // A merged pull request stays merged: it is never asked again.
  if (entry.asking || entry.state === "merged") return;
  if (Date.now() - entry.askedAt < REFRESH_MS) return;
  entry.asking = true;
  queue.push(url);
  pump();
}

function refreshShown(): void {
  if (isPageHidden()) return;
  for (const [url, entry] of entries) if (entry.shown > 0) ask(url);
}

export const prStates = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Changes each time a state does, for `useSyncExternalStore`. */
  version: () => version,
  get: (url: string): PrState | undefined => entries.get(url)?.state,
  /** A state learned another way, such as the review panel asking for its own pull request. */
  learn(url: string, state: PrState): void {
    const entry = entryOf(url);
    entry.askedAt = Date.now();
    if (entry.state === state) return;
    entry.state = state;
    changed();
  },
  /** Keeps these links' states fresh while they are on screen. Returns how to stop. */
  show(urls: string[]): () => void {
    for (const url of urls) {
      entryOf(url).shown += 1;
      ask(url);
    }
    if (urls.length && !timer) {
      timer = setInterval(refreshShown, RETRY_MS);
      onPageVisibility(refreshShown);
    }
    return () => {
      for (const url of urls) entryOf(url).shown -= 1;
    };
  },
};
