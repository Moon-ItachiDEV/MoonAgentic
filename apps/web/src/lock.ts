// /lock on this device: the code sheet asked from anywhere (the side bar, a project's menu,
// the composer, Ctrl+Maj+L, the settings), and the steps that need it. The server keeps the
// code and what is locked; this only asks for it and passes it on.
import type { Project } from "@moonagentic/protocol";
import { connection, newId } from "./connection.ts";

/** What the code sheet asks for. */
export type LockAsk =
  /** A first code, typed twice; `after` runs once it is kept. */
  | { kind: "set"; after?: () => void }
  /** The code in use, then a new one typed twice. */
  | { kind: "change" }
  /** The code that opens this project again; `after` runs once it is open. */
  | { kind: "unlock"; projectId: string; name: string; after?: () => void };

/** The ask shown, numbered so that each one starts afresh and closes only itself. */
export interface Asked {
  ask: LockAsk;
  seq: number;
}

let asked: Asked | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export const lockSheet = {
  get: (): Asked | null => asked,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open(ask: LockAsk): void {
    seq += 1;
    asked = { ask, seq };
    changed();
  },
  /** Closes the sheet, or only the ask numbered `which` when given, not one opened since. */
  close(which?: number): void {
    if (which !== undefined && asked?.seq !== which) return;
    asked = null;
    changed();
  },
};

/** Whether a 6-digit code is what was typed. */
export const fullPin = (pin: string) => /^\d{6}$/.test(pin);

/**
 * Locks the project, asking first for a code when none is set. `after` runs once it is
 * locked, such as to leave its page.
 */
export function lockProject(project: Project, hasPin: boolean, after?: () => void): void {
  if (!hasPin) {
    lockSheet.open({ kind: "set", after: () => lockProject(project, true, after) });
    return;
  }
  connection
    .request({ type: "lock.project", requestId: newId(), projectId: project.id })
    .then(() => {
      connection.notify(`${project.name} verrouillé`);
      after?.();
    })
    .catch((e: unknown) => connection.notify(e instanceof Error ? e.message : String(e)));
}

/** Asks for the code that opens the project again. */
export function askUnlock(project: Project, after?: () => void): void {
  lockSheet.open({
    kind: "unlock",
    projectId: project.id,
    name: project.name,
    ...(after ? { after } : {}),
  });
}

/** Locks it, or asks for the code when it is locked already. */
export function toggleLock(project: Project, hasPin: boolean, after?: () => void): void {
  if (project.locked) askUnlock(project);
  else lockProject(project, hasPin, after);
}
