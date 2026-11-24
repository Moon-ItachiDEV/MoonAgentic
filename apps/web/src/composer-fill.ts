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

const pickerListeners = new Set<(threadId: string) => void>();

/** Opens a thread's agent and model picker, as « Changer de modèle » does after a stop. */
export function openComposerPicker(threadId: string): void {
  for (const listener of pickerListeners) listener(threadId);
}

export function onOpenComposerPicker(listener: (threadId: string) => void): () => void {
  pickerListeners.add(listener);
  return () => pickerListeners.delete(listener);
}
