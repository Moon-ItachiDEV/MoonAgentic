import type { AgentInfo, Team, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useState } from "react";
import { connection, newId } from "../connection.ts";
import { clock, mergeable, noteText, shipTarget, teamActive, teamRows } from "../team-rows.ts";
import { memberThreadIds, teamTree } from "../team-tree.ts";
import { useThreadItems } from "../use-thread-items.ts";
import { Glyph, I } from "../v2/I.tsx";
import { Masc } from "../v2/Masc.tsx";

/**
 * A team at work, as the mockup draws it: one line per role, its mascot's eyes on what the
 * role really does, then only what is the user's to do. A team at work is not stopped from
 * here: that is in the thread's menu.
 */
export function TeamPanel({
  lead,
  team,
  threads,
  agents,
  onOpenThread,
  own,
}: {
  lead: Thread;
  team: Team;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
  /** Shown on the lead's own thread: with what there is to do. A member's thread only links back. */
  own: boolean;
}) {
  const ids = useMemo(() => [lead.id, ...memberThreadIds(team)], [lead.id, team]);
  const items = useThreadItems(ids);
  const model = useMemo(
    () => teamTree({ lead, team, threads, agents, items }),
    [lead, team, threads, agents, items],
  );
  const running = teamActive(team);
  // The present moves on, once a second, only while the team works.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const events = team.timeline ?? [];
  const start = events[0]?.at ?? lead.createdAt;
  const end = running ? now : (events.at(-1)?.at ?? start);

  const rows = teamRows(team, model, agents, end);
  const doneRows = rows.filter((r) => r.state === "ok").length;
  const head =
    team.phase === "done"
      ? "Terminée"
      : team.phase === "blocked"
        ? "T'attend"
        : team.phase === "failed"
          ? "Échouée"
          : team.phase === "stopped"
            ? "Arrêtée"
            : "Au travail";

  // What is the user's to do: the same steps as before, under the list.
  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  const [retrying, setRetrying] = useState<number[]>([]);
  const [shipping, setShipping] = useState(false);
  const refused = (error: unknown) =>
    connection.notify(error instanceof Error ? error.message : String(error));
  // -1 stands for the merge. The button waits for the server's answer, not for a guess.
  const retry = (index: number) => {
    setRetrying((r) => [...r, index]);
    connection
      .request({
        type: "team.retry",
        requestId: newId(),
        threadId: lead.id,
        ...(index >= 0 ? { index } : {}),
      })
      .catch(refused)
      .finally(() => setRetrying((r) => r.filter((i) => i !== index)));
  };
  const ship = () => {
    setShipping(true);
    connection
      .request({ type: "team.ship", requestId: newId(), threadId: lead.id })
      .catch(refused)
      .finally(() => setShipping(false));
  };
  const merge = byId(team.mergeThreadId);
  const retryMerge = !running && team.phase !== "done" && mergeable(team);
  const mergeBlocked = team.phase === "blocked" && !team.tasks.some((t) => t.status === "blocked");
  const again = team.tasks
    .map((task, i) => ({ task, i }))
    .filter(
      ({ task }) =>
        team.phase !== "planning" &&
        (task.status === "blocked" || task.status === "failed" || task.status === "stopped"),
    );
  const error =
    team.error && (team.phase === "blocked" || team.phase === "failed" || team.phase === "stopped")
      ? noteText(team.error)
      : undefined;
  const shipNote = team.shipError ?? team.shipped?.note;
  const note = (shipNote ?? error)?.split("\n").find((l) => l.trim());
  const canShip =
    team.phase === "done" && !team.shipping && !team.shipped?.opened && !!shipTarget(team);
  // Done, the merge is one tap away on its own line: only a merge that waits is pointed at.
  const showMerge = !!merge && (mergeBlocked || retryMerge);
  const prNumber = /\/pull\/(\d+)/.exec(team.shipped?.url ?? "")?.[1];

  if (!own) {
    return (
      <button className="tmc tmlk press" onClick={() => onOpenThread(lead.id)}>
        <span className="tmh">
          <span className="ppill">
            {team.phase === "done" ? <I n="check" s={13} /> : running ? <Glyph /> : null}
            Équipe · {head} · {doneRows} sur {rows.length}
          </span>
          <span className="tmo">{lead.title}</span>
          <I n="right" s={14} />
        </span>
      </button>
    );
  }

  return (
    <div className="tmc" role="region" aria-label="Équipe">
      <div className="tmh">
        <span className="ppill">
          {team.phase === "done" ? <I n="check" s={13} /> : running ? <Glyph /> : null}
          {head} · {doneRows} sur {rows.length}
        </span>
        <span className="tmt" role="timer">
          {clock(end - start)}
        </span>
      </div>
      <div className="tml">
        {rows.map((r) => (
          <button
            key={r.key}
            className={`tmr ${r.state}`}
            disabled={!r.threadId}
            aria-label={`${r.name}, ${r.model}${r.text ? ` : ${r.text}` : ""}`}
            onClick={() => r.threadId && onOpenThread(r.threadId)}
          >
            <span className="tmb mb">
              <Masc job={r.job} state={r.face} />
              <i />
            </span>
            <span className="tx">
              <span className="nm">
                {r.name}
                <small>{r.model}</small>
              </span>
              {r.text && (
                <small className={`ds${r.bad ? " mer" : ""}`}>
                  {r.live ? <span className="shimmer">{r.text}</span> : r.text}
                </small>
              )}
            </span>
            {r.time && <span className="tm">{r.time}</span>}
          </button>
        ))}
      </div>
      {running && !!team.missions?.length && (
        <div className="tmms" aria-label="Missions ajoutées">
          {team.missions.map((m, i) => {
            const planned = m.status === "planned";
            return (
              <div key={i} className={`tmmi${planned ? " ok" : ""}`} title={m.note ?? m.text}>
                <span className="ic">
                  <I n={planned ? "check" : "plus"} s={15} />
                </span>
                <span className="t">{m.text}</span>
                <span className="s">
                  {m.status === "waiting" || m.status === "reading" ? (
                    <span className="shimmer">Le chef la lit</span>
                  ) : planned ? (
                    m.added ? (
                      `Au plan · ${m.added} partie${m.added > 1 ? "s" : ""}`
                    ) : (
                      "Déjà au plan"
                    )
                  ) : m.status === "failed" ? (
                    "Pas mise au plan"
                  ) : (
                    "Arrêtée"
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {note && (
        <p className={`pcw${team.phase === "failed" || team.shipError ? " t-err" : ""}`}>{note}</p>
      )}
      {again.map(({ task, i }) => (
        <div key={i} className="tmpr">
          <span className="nm">{task.title}</span>
          <button
            className="b2 ink press"
            aria-label={`Relancer « ${task.title} »`}
            disabled={retrying.includes(i)}
            onClick={() => retry(i)}
          >
            Relancer
          </button>
        </div>
      ))}
      {(showMerge || retryMerge) && (
        <div className="tmpr">
          <span className="nm">Fusion</span>
          {showMerge && merge && (
            <button className="b2 soft press" onClick={() => onOpenThread(merge.id)}>
              Ouvrir la fusion
            </button>
          )}
          {retryMerge && (
            <button
              className="b2 ink press"
              disabled={retrying.includes(-1)}
              onClick={() => retry(-1)}
            >
              Relancer la fusion
            </button>
          )}
        </div>
      )}
      {(team.shipped?.url || canShip || team.shipping) && (
        <div className="tmpr">
          {prNumber && (
            <span className="prn mono">
              <I n="gh" s={14} />#{prNumber}
            </span>
          )}
          <span className="nm">{team.shipping ? "Ouverture de la PR…" : lead.title}</span>
          {team.shipped?.url && (
            <a className="b2 ink press" href={team.shipped.url} target="_blank" rel="noreferrer">
              {team.shipped.opened ? "Voir la PR" : "Créer la PR sur GitHub"}
            </a>
          )}
          {canShip && (
            <button className="b2 ink press" disabled={shipping} onClick={ship}>
              {team.shipError || team.shipped ? "Réessayer" : "Ouvrir la PR"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
