// The defaults of a new thread, kept by the server so every device starts the same way.
// This device's own copy, from before they were kept there, is handed over once and only
// read while the server has not said anything yet.
import type { Defaults, PermissionMode } from "@moonagentic/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { connection } from "./connection.ts";
import { readPref, writePref } from "./prefs.ts";

/** What this device kept before the server did, if anything. */
export function localDefaults(): Partial<Defaults> {
  const mode = readPref("permissionMode");
  const isolated = readPref("isolated");
  return {
    ...(mode === "full" || mode === "edits" || mode === "supervised"
      ? { permissionMode: mode }
      : {}),
    ...(isolated === "true" || isolated === "false" ? { isolated: isolated === "true" } : {}),
  };
}

/** The defaults to use: the server's, else this device's, else supervised on its own branch. */
export function resolveDefaults(server: Defaults | null, local: Partial<Defaults>): Defaults {
  return (
    server ?? {
      permissionMode: local.permissionMode ?? "supervised",
      isolated: local.isolated ?? true,
    }
  );
}

let handedOver = false;

/** How long a choice made here stands in for the server's, while its answer is on the way. */
const CHOICE_MS = 5000;
/**
 * What was just chosen on this device. The server's answer takes a moment on a slow link:
 * a message sent meanwhile must go with the access asked for, not the one of before.
 */
let chosen: { change: Partial<Defaults>; at: number } | null = null;
const watchers = new Set<() => void>();
const watch = (run: () => void) => {
  watchers.add(run);
  return () => watchers.delete(run);
};

/** The server's defaults under what was just chosen here, until the server says the same. */
export function withChoice(
  server: Defaults,
  choice: { change: Partial<Defaults>; at: number } | null,
  now: number,
): Defaults {
  if (!choice || now - choice.at > CHOICE_MS) return server;
  return { ...server, ...choice.change };
}

/** The defaults, following every change from any device. */
export function useDefaults(): Defaults {
  const ready = useSyncExternalStore(connection.subscribe, () => connection.getState().ready);
  const serverDefaults = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().defaults,
  );
  const choice = useSyncExternalStore(watch, () => chosen);
  // The server has none yet: this device's own choices become everyone's, once.
  useEffect(() => {
    if (!ready || serverDefaults || handedOver) return;
    const local = localDefaults();
    if (local.permissionMode === undefined && local.isolated === undefined) return;
    handedOver = true;
    connection.send({ type: "defaults.set", ...local });
  }, [ready, serverDefaults]);
  const server = serverDefaults ?? resolveDefaults(null, localDefaults());
  // Once the server says what was chosen, its word is the only one again.
  useEffect(() => {
    if (!choice) return;
    const same = Object.entries(choice.change).every(
      ([key, value]) => server[key as keyof Defaults] === value,
    );
    if (!same) return;
    chosen = null;
    for (const run of watchers) run();
  }, [choice, server.permissionMode, server.isolated]);
  return withChoice(server, choice, Date.now());
}

/** Changes a default for every device; this device keeps a copy for before it connects. */
export function setDefault(change: { permissionMode?: PermissionMode; isolated?: boolean }) {
  if (change.permissionMode) writePref("permissionMode", change.permissionMode);
  if (change.isolated !== undefined) writePref("isolated", String(change.isolated));
  chosen = { change: { ...chosen?.change, ...change }, at: Date.now() };
  for (const run of watchers) run();
  connection.send({ type: "defaults.set", ...change });
}
