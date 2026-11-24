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
    ...(mode === "full" || mode === "supervised" ? { permissionMode: mode } : {}),
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

/** The defaults, following every change from any device. */
export function useDefaults(): Defaults {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  // The server has none yet: this device's own choices become everyone's, once.
  useEffect(() => {
    if (!state.ready || state.defaults || handedOver) return;
    const local = localDefaults();
    if (local.permissionMode === undefined && local.isolated === undefined) return;
    handedOver = true;
    connection.send({ type: "defaults.set", ...local });
  }, [state.ready, state.defaults]);
  return resolveDefaults(state.defaults, localDefaults());
}

/** Changes a default for every device; this device keeps a copy for before it connects. */
export function setDefault(change: { permissionMode?: PermissionMode; isolated?: boolean }) {
  if (change.permissionMode) writePref("permissionMode", change.permissionMode);
  if (change.isolated !== undefined) writePref("isolated", String(change.isolated));
  connection.send({ type: "defaults.set", ...change });
}
