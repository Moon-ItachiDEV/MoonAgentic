import type { AgentInfo, FavoriteRef, Thread, ThreadQuota } from "@moonagentic/protocol";
import { useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import { modelLabel } from "../model-label.ts";
import { formatReset } from "../quotas.ts";

/** The name a model goes by, from its agent's list, or its id while that is not known. */
const nameOf = (agents: AgentInfo[], ref: FavoriteRef) => {
  const agent = agents.find((a) => a.id === ref.agentId);
  const known = agent?.models?.find((m) => m.id === ref.model);
  return known ? modelLabel(known) : ref.model || agent?.name || ref.agentId;
};

const send = (message: Parameters<typeof connection.send>[0]) => {
  if (!connection.send(message)) connection.notify("Pas de connexion au serveur MoonAgentic.");
};

/**
 * Above the composer, what the thread does about a quota that ran out: a fallback model took
 * over (« Attendre » puts it back on its own and waits for the reset instead), or it waits to
 * start again by itself once the quota is reset.
 */
export function QuotaBar(props: { thread: Thread; quota: ThreadQuota }) {
  const { thread, quota } = props;
  const agents = useSyncExternalStore(connection.subscribe, connection.getState).agents;
  if (quota.state === "relief") {
    return (
      <div className="updb glass fbc" role="status">
        <span className="tx">
          {nameOf(agents, quota.to)} prend le relais
          <small>
            Quota {nameOf(agents, quota.from)} fini
            {quota.back ? ` · retour ${formatReset(quota.back)}` : ""}
          </small>
        </span>
        <button
          className="b2 soft press"
          onClick={() => send({ type: "thread.quotaWait", threadId: thread.id })}
        >
          Attendre
        </button>
      </div>
    );
  }
  const own = { agentId: quota.agentId, model: quota.model ?? "" };
  return (
    <div className="updb glass fbc" role="status">
      <span className="tx">
        {quota.until ? `Reprend ${formatReset(quota.until)}` : "Reprend quand le quota repart"}
        <small>Quota {nameOf(agents, own)} fini</small>
      </span>
      <button
        className="b2 soft press"
        onClick={() => send({ type: "thread.quotaCancel", threadId: thread.id })}
      >
        Annuler
      </button>
    </div>
  );
}
