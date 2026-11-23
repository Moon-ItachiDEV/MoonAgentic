import type { Item } from "@moonagentic/protocol";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { connection } from "./connection.ts";

/** A picture that follows several agents writing at once needs no more than this. */
const EVERY_MS = 250;

const subscribeSlowly = (listener: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = connection.subscribe(() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      listener();
    }, EVERY_MS);
  });
  return () => {
    off();
    clearTimeout(timer);
  };
};

/**
 * The items of several threads at once, kept up to date while the caller is on screen: the
 * server sends a thread's items only to the windows that show it.
 */
export function useThreadItems(ids: readonly string[]): Record<string, Item[] | undefined> {
  const key = ids.join("|");
  useEffect(() => {
    const list = key ? key.split("|") : [];
    for (const threadId of list) connection.send({ type: "thread.open", threadId });
    return () => {
      for (const threadId of list) connection.send({ type: "thread.leave", threadId });
    };
  }, [key]);
  const last = useRef<{ key: string; value: Record<string, Item[] | undefined> }>({
    key: "",
    value: {},
  });
  return useSyncExternalStore(subscribeSlowly, () => {
    const all = connection.getState().items;
    const list = key ? key.split("|") : [];
    const prev = last.current;
    if (prev.key === key && list.every((id) => prev.value[id] === all[id])) return prev.value;
    const value = Object.fromEntries(list.map((id) => [id, all[id]]));
    last.current = { key, value };
    return value;
  });
}
