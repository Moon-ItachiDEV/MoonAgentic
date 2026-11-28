import type { AgentInfo, ClientMessage, Project, Schedule, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { momentLabel, repeatLabel, scheduleState } from "../schedule.ts";
import { Fab } from "../v2/Fab.tsx";
import { I } from "../v2/I.tsx";

type ScheduleRequest = Extract<ClientMessage, { type: `schedule.${string}` }>;

/** Sends a change to the server; a refusal is shown rather than lost. */
const call = (message: ScheduleRequest) =>
  connection.request(message).catch((error: unknown) => {
    connection.notify(error instanceof Error ? error.message : String(error));
    return undefined;
  });

/**
 * The tasks planned for later, of every project shown. Each card says what the server really
 * holds: when the task next starts, when it last did, and why it did not when that is the case.
 */
export function PlanSchedules({
  schedules,
  projects,
  threads,
  agents,
  onEdit,
  onNew,
  onOpenThread,
}: {
  schedules: Schedule[];
  /** The projects whose tasks are listed; a locked one's stay out of sight. */
  projects: Project[];
  threads: Thread[];
  agents: AgentInfo[];
  onEdit: (schedule: Schedule) => void;
  /** Nothing to plan in when there is no project yet. */
  onNew: (() => void) | undefined;
  onOpenThread: (id: string) => void;
}) {
  // « Demain » becomes « aujourd'hui » while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const shown = schedules.filter((s) => projects.some((p) => p.id === s.projectId));

  return (
    <div className="view" id="view" role="list" aria-label="Tâches planifiées">
      {shown.length === 0 && (
        <div className="empty2">
          <span className="eic n">
            <I n="clock" s={26} />
          </span>
          <b>Aucune tâche planifiée</b>
        </div>
      )}
      {shown.map((s) => {
        const state = scheduleState(s, now);
        const project = projects.find((p) => p.id === s.projectId);
        const last = threads.find((t) => t.id === s.lastThreadId);
        const agent = agents.find((a) => a.id === s.agentId);
        // What the thread of its last run is really doing now.
        const live =
          last?.status === "running"
            ? ", en cours"
            : last?.status === "waiting"
              ? ", attend ton accord"
              : "";
        const missed = !!s.lastError;
        return (
          <article key={s.id} className={`sc2${s.enabled ? "" : " off"}`} role="listitem">
            <div className="sch">
              <span className="rep">
                <I n="clock" s={14} />
                {repeatLabel(s)}
              </span>
              <span className="sp" />
              {/* A one-time task that has run is planned again from « Modifier ». */}
              {state.tone !== "done" && (
                <button
                  className="tog"
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`Activer ${s.title}`}
                  title={s.enabled ? "Mettre en pause" : "Réactiver"}
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
            </div>
            <button className="sct" onClick={() => onEdit(s)} aria-label={`Modifier ${s.title}`}>
              {s.title}
            </button>
            <span className="pcm">
              {project && <i className={`pdot${project.color ? ` pc-${project.color}` : ""}`} />}
              {project?.name}
              <span className="dotsep" />
              {agent?.name ?? s.agentId}
              {s.permissionMode === "full" && (
                <>
                  <span className="dotsep" />
                  accès complet
                </>
              )}
              {s.permissionMode === "edits" && (
                <>
                  <span className="dotsep" />
                  éditions auto
                </>
              )}
            </span>
            {s.by === "hermes" && <span className="pco">Ajoutée par Hermes</span>}
            {s.lastError && <p className="pcw t-err">{s.lastError}</p>}
            <div className="scf">
              <span className={`scs${missed ? " warn" : state.tone === "done" ? " ok" : ""}`}>
                {state.label}
                {state.tone === "done"
                  ? live
                  : s.lastAt !== undefined
                    ? ` · dernier ${momentLabel(s.lastAt, now)}${live}`
                    : ""}
                {s.runs > 1 ? ` · ${s.runs} lancements` : ""}
              </span>
              <span className="sp" />
              {last && (
                <button
                  className="mini press"
                  aria-label={`Ouvrir le fil de ${s.title}`}
                  onClick={() => onOpenThread(last.id)}
                >
                  Fil
                </button>
              )}
              <button
                className="mini press"
                aria-label={`Lancer maintenant ${s.title}`}
                onClick={() =>
                  void call({ type: "schedule.run", requestId: newId(), id: s.id }).then(
                    (id) => id && onOpenThread(id),
                  )
                }
              >
                Lancer
              </button>
              <button
                className="mini ic press"
                aria-label={`Supprimer ${s.title}`}
                onClick={() => void call({ type: "schedule.remove", requestId: newId(), id: s.id })}
              >
                <I n="x" s={14} />
              </button>
            </div>
          </article>
        );
      })}
      <div className="end" style={{ height: 110 }} />
      {onNew && (
        <Fab>
          <button className="newd press" onClick={onNew}>
            <I n="plus" s={20} />
            Planifier une tâche
          </button>
        </Fab>
      )}
    </div>
  );
}
