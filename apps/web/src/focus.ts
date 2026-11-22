// A message the quick search asked to show, picked up by the thread view once it has loaded.
let wanted: { threadId: string; itemId: string } | null = null;
const listeners = new Set<() => void>();

export function focusItem(threadId: string, itemId: string): void {
  wanted = { threadId, itemId };
  for (const listener of listeners) listener();
}

/** Takes the message waiting to be shown in this thread, if any. */
export function takeFocus(threadId: string): string | undefined {
  if (wanted?.threadId !== threadId) return undefined;
  const { itemId } = wanted;
  wanted = null;
  return itemId;
}

export function onFocusRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
