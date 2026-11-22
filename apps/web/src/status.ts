// How agents and threads are described to the user: pure, so it is easy to test.
import type { AgentInfo } from "@moonagentic/protocol";

/** What Connexions says about an agent, from the last time it was started. */
export function agentStatus(agent: AgentInfo): { tone: "ok" | "warn" | "err" | ""; label: string } {
  if (!agent.available) return { tone: "", label: "Pas installé" };
  const check = agent.check;
  if (!check) return { tone: "", label: "Pas encore vérifié" };
  if (check.ok) return { tone: "ok", label: "Prêt" };
  if (check.signInNeeded) return { tone: "warn", label: "Connexion requise" };
  return { tone: "err", label: "Erreur au démarrage" };
}

/** What the thread has cost so far, as the agent reports it. */
export const money = (cost: { amount: number; currency: string }) => {
  try {
    return cost.amount.toLocaleString("fr-FR", {
      style: "currency",
      currency: cost.currency,
      maximumFractionDigits: cost.amount < 1 ? 3 : 2,
    });
  } catch {
    // Not a currency code the browser knows.
    return `${cost.amount.toLocaleString("fr-FR", { maximumFractionDigits: 3 })} ${cost.currency}`;
  }
};
