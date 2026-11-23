import type { ActivityDay, AgentInfo, Thread } from "@moonagentic/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import {
  brief,
  byUrgency,
  dayLabel,
  heatmap,
  pullRequests,
  upcoming,
  type Heatmap,
} from "../overview.ts";
import { formatPercent } from "../quotas.ts";
import type { State } from "../state.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { homeCards } from "./HomeCards.tsx";
import {
  IconBoard,
  IconChat,
  IconCheck,
  IconChevron,
  IconClock,
  IconGrid,
  IconPullRequest,
} from "./icons.tsx";

/** Weeks the activity map covers: half a year on a computer, four months on a phone. */
const WEEKS_WIDE = 26;
const WEEKS_NARROW = 17;
/** The wait before counting again once a thread moved: answers come in bursts. */
const ACTIVITY_REFRESH_MS = 1500;

const agentOf = (agents: AgentInfo[], id: string) =>
  agents.find((a) => a.id === id) ?? { id, short: "?" };

/**
 * Messages per day, asked of the server when the home page opens and again a moment after a
 * thread moves (an answer just ended), so today's cell keeps up.
 */
function useActivity(days: number, latest: number, online: boolean) {
  const [data, setData] = useState<{ days: ActivityDay[]; firstAt?: number } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    // Asked only once the connection is open, and asked again when it opens anew: a request
    // sent while it reconnects would fail and leave the map empty.
    if (!online) return;
    let current = true;
    const ask = () =>
      connection
        .ask({
          type: "activity",
          requestId: newId(),
          tzOffset: new Date().getTimezoneOffset(),
          days,
        })
        .then((reply) => current && setData({ days: reply.days, firstAt: reply.firstAt }))
        .catch(() => current && setData((old) => old ?? { days: [] }));
    const timer = setTimeout(ask, first.current ? 0 : ACTIVITY_REFRESH_MS);
    first.current = false;
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [days, latest, online]);
  return data;
}

function ActivityTile({ map, loading }: { map: Heatmap; loading: boolean }) {
  const weeks = map.weeks.length;
  const cols = { gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` };
  return (
    <section className="ov-tile s3" aria-labelledby="ov-activity">
      <div className="ov-h">
        <IconGrid />
        <b id="ov-activity">Activité</b>
        <span className="ov-more">
          {map.sinceStart ? `depuis le ${dayLabel(firstShown(map)).slice(5)}` : `${weeks} semaines`}
        </span>
      </div>
      <div
        className={`ov-heat${loading ? " loading" : ""}`}
        style={cols}
        role="img"
        aria-label={`${map.total} messages sur ${weeks} semaines`}
      >
        {map.weeks.flat().map((c) => (
          <i
            key={c.day}
            className={`${c.state === "today" ? "today " : ""}${c.state === "before" ? "pre" : c.state === "after" ? "fut" : `l${c.level}`}`}
            title={
              c.state === "after"
                ? undefined
                : c.state === "before"
                  ? `${dayLabel(c.day)} · avant le premier fil`
                  : `${dayLabel(c.day)} · ${c.count} message${c.count > 1 ? "s" : ""}`
            }
          />
        ))}
      </div>
      <div className="ov-months" style={cols} aria-hidden>
        {map.months.map((m) => (
          <span key={m.column} style={{ gridColumn: m.column + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="ov-foot">
        <span>
          <b>{map.total.toLocaleString("fr-FR")}</b> message{map.total > 1 ? "s" : ""}
        </span>
        <span className="ov-scale" aria-hidden>
          Moins
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={`l${l}`} />
          ))}
          Plus
        </span>
      </div>
      {map.total > 0 && (
        <div className="ov-foot ov-note">
          {map.streak > 0 && `${map.streak} jour${map.streak > 1 ? "s" : ""} d'affilée · `}
          {map.busiest && `surtout le ${map.busiest}`}
        </div>
      )}
    </section>
  );
}

const firstShown = (map: Heatmap) =>
  map.weeks.flat().find((c) => c.state !== "before")?.day ?? map.weeks[0]![0]!.day;

/**
 * The home page's overview: what needs the user, the conversations worth coming back to,
 * the activity of the last months, the pull requests and what comes next. Everything is read
 * from the server's state; a tile with nothing to show says so or stays away.
 */
export function Overview(props: {
  state: State;
  narrow: boolean;
  onOpenThread: (thread: Thread) => void;
  onOpenPlanner: () => void;
  onOpenSubscriptions: () => void;
  onHide: () => void;
}) {
  const { state, narrow } = props;
  const weeks = narrow ? WEEKS_NARROW : WEEKS_WIDE;
  const latest = state.threads.reduce((m, t) => Math.max(m, t.updatedAt), 0);
  const activity = useActivity(weeks * 7, latest, state.status === "open");
  // Sorted by urgency before it is cut, so an older thread that waits for the user still
  // shows; « autres » counts the cards left out, never threads at rest.
  const all = useMemo(() => byUrgency(homeCards(state, 50)), [state]);
  const cards = all.slice(0, 4);
  const pills = brief(all, state.quotas);
  const prs = pullRequests(state.threads.filter((t) => !t.archived || t.pr));
  const next = upcoming(state.schedules, state.plan);
  const map = heatmap(activity?.days ?? [], weeks, activity?.firstAt);
  const more = all.length - cards.length;
  const quotaAgent = pills.quota && state.agents.find((a) => a.id === pills.quota!.agentId);

  return (
    <div className="ov">
      <div className="ov-top">
        <h2>Aperçu</h2>
        <span className="ov-scope">tous les projets</span>
        <button className="ov-hide" onClick={props.onHide} aria-label="Masquer l'aperçu">
          Masquer
        </button>
      </div>
      {(!!pills.quota || pills.waiting + pills.working + pills.review > 0) && (
        <div className="ov-pills">
          {pills.quota && (
            <button className="ov-pill q" onClick={props.onOpenSubscriptions}>
              <i />
              {quotaAgent?.name ?? pills.quota.agentId} à{" "}
              <b>{formatPercent(pills.quota.usedPercent)}</b> de sa limite ({pills.quota.label})
            </button>
          )}
          {pills.waiting > 0 && (
            <span className="ov-pill w">
              <i />
              <b>{pills.waiting}</b> {pills.waiting > 1 ? "fils attendent" : "fil attend"} ta
              réponse
            </span>
          )}
          {pills.working > 0 && (
            <span className="ov-pill r">
              <i />
              <b>{pills.working}</b> au travail
            </span>
          )}
          {pills.review > 0 && (
            <span className="ov-pill v">
              <i />
              <b>{pills.review}</b> à revoir
            </span>
          )}
        </div>
      )}
      <div className="ov-grid">
        {narrow || <ActivityTile map={map} loading={!activity} />}
        <section className="ov-tile s3" aria-labelledby="ov-resume">
          <div className="ov-h">
            <IconChat size={14} />
            <b id="ov-resume">À reprendre</b>
            {more > 0 && <span className="ov-more">{more} autres</span>}
          </div>
          {cards.length ? (
            <div className="ov-rows">
              {cards.map((c) => (
                <button
                  key={c.thread.id}
                  className="ov-row"
                  onClick={() => props.onOpenThread(c.thread)}
                >
                  <span className={`stk${c.agentIds.length > 1 ? " many" : ""}`}>
                    {c.agentIds.slice(0, 3).map((id) => (
                      <AgentBadge key={id} agent={agentOf(state.agents, id)} small />
                    ))}
                  </span>
                  <span className="ov-tx">
                    <span className="ov-t">{c.thread.title}</span>
                    <span className={`ov-s ${c.tone}`}>
                      {c.tone === "work" && <i className="live" />}
                      {c.sub}
                      <span className="ov-pj">
                        · {state.projects.find((p) => p.id === c.thread.projectId)?.name}
                      </span>
                    </span>
                    {c.pieces && c.pieces.length > 0 && (
                      <span className="ov-pieces" aria-hidden>
                        {c.pieces.map((p, i) => (
                          <i key={i} className={p} />
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="ov-empty">Aucun agent ne travaille ni ne t'attend.</p>
          )}
        </section>
        {narrow && <ActivityTile map={map} loading={!activity} />}
        <section className="ov-tile s3" aria-labelledby="ov-prs">
          <div className="ov-h">
            <IconPullRequest />
            <b id="ov-prs">Pull requests</b>
            {prs.open > 0 && (
              <span className="ov-more">
                {prs.open} ouverte{prs.open > 1 ? "s" : ""}
              </span>
            )}
          </div>
          {prs.rows.length ? (
            <div className="ov-rows">
              {prs.rows.map((r) => (
                <a
                  key={r.thread.id}
                  className="ov-row"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="ov-num">#{r.number}</span>
                  <span className="ov-tx">
                    <span className="ov-t">{r.thread.title}</span>
                    <span className={`ov-st ${r.tone}`}>
                      {r.tone === "ok" && <IconCheck size={11} />}
                      {r.label}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p className="ov-empty">Aucune pull request ouverte depuis MoonAgentic.</p>
          )}
        </section>
        <section className="ov-tile s3" aria-labelledby="ov-next">
          <div className="ov-h">
            <IconClock size={14} />
            <b id="ov-next">À venir</b>
            <button className="ov-more link" onClick={props.onOpenPlanner}>
              Planner <IconChevron size={11} />
            </button>
          </div>
          {next.length ? (
            <div className="ov-rows">
              {next.map((u) => (
                <button key={u.id} className="ov-row" onClick={props.onOpenPlanner}>
                  <span className="ov-ic">
                    {u.kind === "plan" ? <IconBoard size={13} /> : <IconClock size={13} />}
                  </span>
                  <span className="ov-tx">
                    <span className="ov-t">{u.title}</span>
                    <span className="ov-s">
                      <b>{u.when}</b> · {u.detail}
                    </span>
                  </span>
                  {u.agentId && <AgentBadge agent={agentOf(state.agents, u.agentId)} small />}
                </button>
              ))}
            </div>
          ) : (
            <p className="ov-empty">
              Rien de planifié pour l'instant.{" "}
              <button className="ov-link" onClick={props.onOpenPlanner}>
                Planifier une tâche
              </button>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
