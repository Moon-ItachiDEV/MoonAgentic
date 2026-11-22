import type { AgentInfo, ClientMessage, Schedule, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { momentLabel, repeatLabel, scheduleState } from "../schedule.ts";

type ScheduleRequest = Extract<ClientMessage, { type: `schedule.${string}` }>;

/** Sends a change to the server; a refusal is shown rather than lost. */
const call = (message: ScheduleRequest) =>
  connection.request(message).catch((error: unknown) => {
    connection.notify(error instanceof Error ? error.message : String(error));
    return undefined;
  });

/**
 * The project's tasks planned for later. Each line says what the server really holds: when
 * the task next starts, when it last did, and why it did not when that is the case.
 */
export function PlanSchedules({
  schedules,
  threads,
  agents,
  onEdit,
  onNew,
  onOpenThread,
}: {
  schedules: Schedule[];
  threads: Thread[];
  agents: AgentInfo[];
  onEdit: (schedule: Schedule) => void;
  onNew: () => void;
  onOpenThread: (id: string) => void;
}) {
  // « Demain » becomes « aujourd'hui » while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (schedules.length === 0) {
    return (
      <div className="pl-sch-none">
        <p>
          Aucune tâche planifiée. Une tâche planifiée part toute seule à son heure, une fois ou à
          intervalles réguliers, dans un nouveau fil.
        </p>
        <button className="btn pri" onClick={onNew}>
          Planifier une tâche
        </button>
        <small>
          Ou tape <code>/planifier</code> dans une discussion.
        </small>
      </div>
    );
  }

  return (
    <div className="pl-sch" role="list" aria-label="Tâches planifiées">
      {schedules.map((s) => {
        const state = scheduleState(s, now);
        const last = threads.find((t) => t.id === s.lastThreadId);
        const agent = agents.find((a) => a.id === s.agentId);
        // What the thread of its last run is really doing now.
        const live =
          last?.status === "running"
            ? ", en cours"
            : last?.status === "waiting"
              ? ", attend ton accord"
              : "";
        return (
          <article key={s.id} className={`pl-sch-row ${state.tone}`} role="listitem">
            <div className="pl-sch-tx">
              <b>{s.title}</b>
              <p>
                {repeatLabel(s)} · {agent?.name ?? s.agentId}
                {s.permissionMode === "full" ? " · accès complet" : ""}
              </p>
              <p className="pl-sch-state">
                <i />
                {state.label}
                {state.tone === "done" ? live : ""}
              </p>
              {s.lastAt !== undefined && state.tone !== "done" && (
                <p>
                  Dernier lancement {momentLabel(s.lastAt, now)}
                  {live}
                  {s.runs > 1 ? ` · ${s.runs} lancements` : ""}
                </p>
              )}
              {s.lastError && <p className="pl-sch-err">{s.lastError}</p>}
            </div>
            <div className="pl-sch-ctl">
              {/* A one-time task that has run is planned again from « Modifier ». */}
              {state.tone !== "done" && (
                <button
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`Activer ${s.title}`}
                  title={s.enabled ? "Mettre en pause" : "Réactiver"}
                  className={`set-sw${s.enabled ? " on" : ""}`}
                  onClick={() =>
                    void call({
                      type: "schedule.update",
                      requestId: newId(),
                      id: s.id,
                      enabled: !s.enabled,
                    })
                  }
                />
              )}
              {last && (
                <button className="btn quiet" onClick={() => onOpenThread(last.id)}>
                  Ouvrir le fil
                </button>
              )}
              <button
                className="btn quiet"
                onClick={() =>
                  void call({ type: "schedule.run", requestId: newId(), id: s.id }).then(
                    (id) => id && onOpenThread(id),
                  )
                }
              >
                Lancer maintenant
              </button>
              <button className="btn quiet" onClick={() => onEdit(s)}>
                Modifier
              </button>
              <button
                className="btn quiet danger"
                aria-label={`Supprimer ${s.title}`}
                onClick={() => void call({ type: "schedule.remove", requestId: newId(), id: s.id })}
              >
                Supprimer
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
