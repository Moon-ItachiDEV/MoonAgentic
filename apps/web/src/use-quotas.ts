import type { AgentQuota } from "@moonagentic/protocol";
import { useSyncExternalStore } from "react";
import { connection } from "./connection.ts";
import { readPref, writePref } from "./prefs.ts";
import { parseSeenQuotas } from "./quotas.ts";

const quotasOf = () => connection.getState().quotas;

/** What the agents' subscriptions have left, as the server last read them. */
export function useQuotas(): AgentQuota[] {
  return useSyncExternalStore(connection.subscribe, quotasOf);
}

let seenQuotas: Record<string, string> = parseSeenQuotas(readPref("quotaSeen"));
const seenListeners = new Set<() => void>();
const subscribeSeen = (listener: () => void) => {
  seenListeners.add(listener);
  return () => seenListeners.delete(listener);
};
const getSeen = () => seenQuotas;

/** The last dismissed warning key per agent, shared by every mounted composer. */
export function useQuotaSeen(): Record<string, string> {
  return useSyncExternalStore(subscribeSeen, getSeen);
}

/** Remembers that the user dismissed this warning for this agent. */
export function dismissQuotaWarning(agentId: string, key: string): void {
  if (seenQuotas[agentId] === key) return;
  seenQuotas = { ...seenQuotas, [agentId]: key };
  writePref("quotaSeen", JSON.stringify(seenQuotas));
  for (const listener of seenListeners) listener();
}
