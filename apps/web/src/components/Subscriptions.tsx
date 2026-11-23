import type { AgentInfo, AgentQuota, QuotaWindow } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
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

function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
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
        aria-valuetext={formatPercent(w.usedPercent)}
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const readable = quota.state === "ok";
  const loading = quota.state === "loading";
  const canRefresh = !quota.fixed && quota.state !== "none" && !loading;
  const sub =
    quota.plan ??
    (loading
      ? "Lecture en cours…"
      : quota.state === "none"
        ? "Sans abonnement"
        : "Limites non lisibles");
  return (
    <section className="qt-card" aria-label={agent.name}>
      <div className="qt-head">
        <AgentBadge agent={agent} />
        <div className="qt-who">
          <b>{agent.name}</b>
          <small>{sub}</small>
        </div>
        {canRefresh && (
          <div className="qt-read">
            {quota.readAt !== undefined && (
              <span className="qt-ago">{readAgo(quota.readAt, now)}</span>
            )}
            <button
              className={`qt-again${asking ? " on" : ""}`}
              aria-label={`Relire les limites de ${agent.name}`}
              title="Relire maintenant"
              disabled={asking}
              onClick={() => {
                if (asking) return;
                setAsking(true);
                connection
                  .ask({ type: "quotas.refresh", requestId: newId(), agentId: agent.id })
                  .catch(() => undefined)
                  .finally(() => {
                    if (mounted.current) setAsking(false);
                  });
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
      {readable && quota.note && (
        <div className="qt-stale">Chiffres précédents conservés — {quota.note}</div>
      )}
      {loading && (
        <div className="qt-none">
          <span>Lecture des limites en cours…</span>
        </div>
      )}
      {!readable && !loading && (
        <div className="qt-none">
          <span>{quota.note}</span>
          {quota.link && (
            <a className="btn sm" href={quota.link} target="_blank" rel="noreferrer">
              Voir sur {linkHost(quota.link)} ↗
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
        Relu toutes les 5 minutes tant que MoonAgentic est ouvert, et après chaque réponse d'un
        agent. Seuls les agents installés apparaissent.
      </p>
    </>
  );
}
