type Listener = (threadId: string, text: string) => void;

const listeners = new Set<Listener>();

/** Puts text in a thread's composer, such as a message taken back by « Revenir ici ». */
export function fillComposer(threadId: string, text: string): void {
  for (const listener of listeners) listener(threadId, text);
}

export function onFillComposer(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
