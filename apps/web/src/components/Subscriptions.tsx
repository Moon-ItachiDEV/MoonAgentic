import type { AgentInfo, AgentQuota, QuotaWindow } from "@moonagentic/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { useQuotas } from "../use-quotas.ts";
import { formatPercent, formatReset, quotaLevel, readAgo } from "../quotas.ts";
import { I } from "../v2/I.tsx";
import { usageColor } from "../v2/Ring.tsx";

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
  const [name, ...rest] = w.label.split(", ");
  return (
    <div className={`qrow ${level}`} style={{ "--qc": usageColor(w.usedPercent) } as CSSProperties}>
      <div className="qh">
        <span className="l">
          {name}
          {rest.length > 0 && <em>{rest.join(", ")}</em>}
        </span>
        <span className="p">{formatPercent(w.usedPercent)}</span>
      </div>
      <div
        className="qb"
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
        <div className="qr">
          {level === "full" && <b className="qf">Limite atteinte.</b>}
          {level === "warn" && <b className="qf">Bientôt au bout.</b>}
          {w.resetsAt && (
            <>
              Se libère <b>{formatReset(w.resetsAt, now)}</b>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Asks the server to read an agent's limits again; `busy` holds while it does. */
function useReread(agentId: string): [boolean, () => void] {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reread = () => {
    if (busy) return;
    setBusy(true);
    connection
      .ask({ type: "quotas.refresh", requestId: newId(), agentId })
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };
  return [busy, reread];
}

function QuotaCard({ agent, quota, now }: { agent: AgentInfo; quota: AgentQuota; now: number }) {
  const [asking, reread] = useReread(agent.id);
  const readable = quota.state === "ok";
  const loading = quota.state === "loading" || asking;
  const canRefresh = !quota.fixed && quota.state !== "none" && quota.state !== "loading";
  const sub =
    quota.plan ??
    (quota.state === "loading"
      ? undefined
      : quota.state === "none"
        ? "Sans abonnement"
        : "Limites non lisibles");
  const read = loading
    ? "Lecture…"
    : quota.readAt !== undefined
      ? readAgo(quota.readAt, now)
      : undefined;
  return (
    <section className="qsec" aria-label={agent.name}>
      <div className="uhead">
        <span className="un">
          <b>{agent.name}</b>
          {sub && <small>{sub}</small>}
        </span>
        {canRefresh ? (
          <button
            className={`rd${loading || !readable ? " ld" : ""}`}
            aria-label={`Relire les limites de ${agent.name}`}
            title="Relire maintenant"
            disabled={asking}
            onClick={reread}
          >
            {read ?? "Relire"}
          </button>
        ) : (
          read && <span className={`rd${loading ? " ld" : ""}`}>{read}</span>
        )}
      </div>
      {readable && (quota.windows.length > 0 || quota.extras.length > 0) && (
        <div className="ins qcard">
          {quota.windows.map((w) => (
            <WindowRow key={w.label} w={w} now={now} />
          ))}
          {quota.extras.map((x) => (
            <div key={x.label} className="qkv">
              <span>{x.label}</span>
              <b>{x.value}</b>
            </div>
          ))}
        </div>
      )}
      {readable && quota.note && <p className="qnote">Chiffres précédents · {quota.note}</p>}
      {!readable && quota.state !== "loading" && (quota.note || quota.link) && (
        <div className="ins">
          {quota.note && (
            <div className="it ro">
              <span className="tx">
                <small>{quota.note}</small>
              </span>
            </div>
          )}
          {quota.link && (
            <a className="it" href={quota.link} target="_blank" rel="noreferrer">
              <span className="tx">Voir sur {linkHost(quota.link)}</span>
              <I n="ext" s={15} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What is left of each subscription, read from the agent itself: one group per installed agent
 * MoonAgentic knows how to ask. `first` puts an agent at the top (the one in use).
 */
export function QuotaList({ agents, first }: { agents: AgentInfo[]; first?: string | undefined }) {
  const quotas = useQuotas();
  const now = useMinute();
  const shown = quotas.flatMap((q) => {
    const agent = agents.find((a) => a.id === q.agentId);
    return agent ? [{ agent, quota: q }] : [];
  });
  if (first) shown.sort((a, b) => Number(b.agent.id === first) - Number(a.agent.id === first));
  if (!shown.length) return <p className="snone">Aucune limite lisible</p>;
  return (
    <>
      {shown.map(({ agent, quota }) => (
        <QuotaCard key={agent.id} agent={agent} quota={quota} now={now} />
      ))}
    </>
  );
}

/** Réglages › Abonnements. */
export function Subscriptions({ agents }: { agents: AgentInfo[] }) {
  return <QuotaList agents={agents} />;
}
