import type { AgentInfo, AgentQuota, QuotaWindow } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { useQuotas } from "../use-quotas.ts";
import { formatPercent, formatReset, quotaLevel, readAgo } from "../quotas.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconRefresh } from "./icons.tsx";

/** Redraws now and then, so « Lu il y a » and the times stay true. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** One window: its name, the share used, a bar, and when it frees up. */
function WindowRow({ w, now }: { w: QuotaWindow; now: number }) {
  const level = quotaLevel(w.usedPercent);
  return (
    <div className={`qt-row ${level}`}>
      <div className="qt-top">
        <span className="qt-name">{w.label}</span>
        <span className="qt-pct">{formatPercent(w.usedPercent)}</span>
      </div>
      <div
        className="qt-bar"
        role="meter"
        aria-label={w.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(w.usedPercent))}
      >
        <i style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
      </div>
      {(w.resetsAt || level !== "ok") && (
        <div className="qt-sub">
          {level === "full" && <span className="qt-flag">Limite atteinte.</span>}
          {level === "warn" && <span className="qt-flag">Bientôt au bout.</span>}
          {w.resetsAt && (
            <span>
              Se libère <b>{formatReset(w.resetsAt, now)}</b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function QuotaCard({ agent, quota, now }: { agent: AgentInfo; quota: AgentQuota; now: number }) {
  const [asking, setAsking] = useState(false);
  // The button turns until new figures arrive, or a moment if nothing changes.
  useEffect(() => setAsking(false), [quota.readAt]);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 15_000);
    return () => clearTimeout(timer);
  }, [asking]);
  const readable = quota.state === "ok";
  const sub = quota.plan ?? (quota.state === "none" ? "Sans abonnement" : "Limites non lisibles");
  return (
    <section className="qt-card" aria-label={agent.name}>
      <div className="qt-head">
        <AgentBadge agent={agent} />
        <div className="qt-who">
          <b>{agent.name}</b>
          <small>{sub}</small>
        </div>
        {quota.state !== "none" && !quota.link && (
          <div className="qt-read">
            {quota.readAt && <span className="qt-ago">{readAgo(quota.readAt, now)}</span>}
            <button
              className={`qt-again${asking ? " on" : ""}`}
              aria-label={`Relire les limites de ${agent.name}`}
              title="Relire maintenant"
              onClick={() => {
                setAsking(true);
                connection.send({ type: "quotas.refresh", agentId: agent.id });
              }}
            >
              <IconRefresh size={14} />
            </button>
          </div>
        )}
      </div>
      {readable && quota.windows.map((w) => <WindowRow key={w.label} w={w} now={now} />)}
      {readable &&
        quota.extras.map((x) => (
          <div key={x.label} className="qt-kv">
            <span>{x.label}</span>
            <span>{x.value}</span>
          </div>
        ))}
      {!readable && (
        <div className="qt-none">
          <span>{quota.note}</span>
          {quota.link && (
            <a className="btn sm" href={quota.link} target="_blank" rel="noreferrer">
              Voir sur {new URL(quota.link).host.replace(/^www\./, "")} ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/** Réglages › Abonnements: one card per installed agent MoonAgentic knows how to ask. */
export function Subscriptions({ agents }: { agents: AgentInfo[] }) {
  const quotas = useQuotas();
  const now = useMinute();
  const shown = quotas.flatMap((q) => {
    const agent = agents.find((a) => a.id === q.agentId);
    return agent ? [{ agent, quota: q }] : [];
  });
  return (
    <>
      <p className="qt-lead">
        Ce qu'il reste dans chaque abonnement, lu chez l'agent lui-même. Rien n'est estimé : si un
        agent ne donne pas le chiffre, il n'y en a pas.
      </p>
      {shown.length ? (
        shown.map(({ agent, quota }) => (
          <QuotaCard key={agent.id} agent={agent} quota={quota} now={now} />
        ))
      ) : (
        <p className="set-empty">
          Aucun agent installé dont MoonAgentic sait lire les limites pour l'instant.
        </p>
      )}
      <p className="qt-foot">
        Relu toutes les 5 minutes tant que MoonAgentic tourne, et après chaque réponse d'un agent.
        Seuls les agents installés apparaissent.
      </p>
    </>
  );
}
