type Listener = (threadId: string, text: string, images: File[]) => void;

const listeners = new Set<Listener>();

/** Puts a message back in a thread's composer, such as one taken back by « Revenir ici ». */
export function fillComposer(threadId: string, text: string, images: File[] = []): void {
  for (const listener of listeners) listener(threadId, text, images);
}

export function onFillComposer(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
