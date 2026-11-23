import type { AgentQuota } from "@moonagentic/protocol";
import { useSyncExternalStore } from "react";
import { connection } from "./connection.ts";

const quotasOf = () => connection.getState().quotas;

/** What the agents' subscriptions have left, as the server last read them. */
export function useQuotas(): AgentQuota[] {
  return useSyncExternalStore(connection.subscribe, quotasOf);
}
