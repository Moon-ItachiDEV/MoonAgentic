// Narrow subscriptions over `connection` so streaming `append` frames only re-render the
// thread that is actually changing instead of the whole `App` tree 60 times a second.
import type { Item, Thread } from "@moonagentic/protocol";
import { useRef, useSyncExternalStore } from "react";
import { connection, type State } from "./connection.ts";
import { openQuestion } from "./decision.ts";
import type { Held } from "./state.ts";
import { sameFields } from "./steady.tsx";

/**
 * Everything in the connection state except the timelines themselves (`items` and `held`):
 * while an agent streams up to 60 times a second, `App` and its shell do not re-render.
 */
export type ShellState = Omit<State, "items" | "held">;

export function shellOf(state: State): ShellState {
  const { items: _items, held: _held, ...shell } = state;
  return shell;
}

/**
 * Keeps `prev` when only `items` or `held` changed, so `useSyncExternalStore` skips
 * re-rendering the root shell during streaming.
 */
export function nextShellState(prev: ShellState | undefined, next: State): ShellState {
  const candidate = shellOf(next);
  return prev && sameFields(prev, candidate) ? prev : candidate;
}

/** Subscribes to the app shell state without re-rendering on streamed timeline updates. */
export function useShellState(): ShellState {
  const cache = useRef<{ source?: State; shell?: ShellState }>({});
  return useSyncExternalStore(connection.subscribe, () => {
    const source = connection.getState();
    if (cache.current.source === source && cache.current.shell) return cache.current.shell;
    const shell = nextShellState(cache.current.shell, source);
    cache.current = { source, shell };
    return shell;
  });
}

export interface ThreadTimeline {
  items: Item[] | undefined;
  held: Held | undefined;
}

/** Subscribes only to one thread's timeline (`items` and `held`). */
export function useThreadTimeline(threadId: string): ThreadTimeline {
  const cache = useRef<{ threadId: string; slice: ThreadTimeline }>({
    threadId,
    slice: { items: undefined, held: undefined },
  });
  return useSyncExternalStore(connection.subscribe, () => {
    const state = connection.getState();
    const items = state.items[threadId];
    const held = state.held[threadId];
    const prev = cache.current;
    if (prev.threadId === threadId && prev.slice.items === items && prev.slice.held === held) {
      return prev.slice;
    }
    const slice = { items, held };
    cache.current = { threadId, slice };
    return slice;
  });
}

/** Subscribes to one thread's items only while `enabled` (e.g. an open settings sheet). */
export function useThreadItemsOf(threadId: string, enabled: boolean): Item[] | undefined {
  return useSyncExternalStore(connection.subscribe, () =>
    enabled ? connection.getState().items[threadId] : undefined,
  );
}

/**
 * Subscribes only to the open question of one thread: stays `undefined` (same reference)
 * throughout streaming turns so the decision card does not re-render on every append frame.
 */
export function useThreadOpenQuestion(
  thread: Pick<Thread, "id" | "status" | "archived">,
): Extract<Item, { kind: "tool" }> | undefined {
  return useSyncExternalStore(connection.subscribe, () =>
    openQuestion(connection.getState().items[thread.id], thread),
  );
}
