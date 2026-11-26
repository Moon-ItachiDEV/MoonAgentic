import { useEffect, useSyncExternalStore } from "react";
import { connection } from "./connection.ts";

/** Hermes's own picture, the one the user gave it on Discord. */
export const HERMES_AVATAR = "/hermes-avatar.jpg";

/**
 * Asks the server for Hermes's state each time the connection opens: on a page opened
 * directly or reloaded, the first ask would leave before the connection is there.
 */
export function useHermesState(): void {
  const status = useSyncExternalStore(connection.subscribe, () => connection.getState().status);
  useEffect(() => {
    if (status === "open") connection.send({ type: "hermes.get" });
  }, [status]);
}
