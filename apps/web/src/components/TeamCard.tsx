import type { Team, TeamTask, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";

/** Corrections a coder gets before the lead steps in, as the server counts them. */
const MAX_TRIES = 3;

const active = (team: Team) => team.phase === "planning" || team.phase === "coding";
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

function headline(team: Team): string {
  const done = team.tasks.filter((t) => t.status === "done").length;
  switch (team.phase) {
    case "planning":
      return "Le chef lit le projet et prépare le plan…";
    case "coding":
      return `L'équipe travaille : ${done} sur ${team.tasks.length} ${plural(done, "terminée", "terminées")}.`;
    case "blocked": {
      const left = team.tasks.filter((t) => t.status === "blocked").length;
      return `${left} ${plural(left, "sous-tâche t'attend", "sous-tâches t'attendent")} : ${plural(left, "ouvre son fil, puis relance-la", "ouvre leurs fils, puis relance-les")}.`;
    }
    case "done":
      return "Terminé : chaque sous-tâche est prête sur sa branche.";
    case "failed":
      return team.error ?? "L'équipe s'est arrêtée sur une erreur.";
    case "stopped":
      return team.error ?? "Équipe arrêtée.";
  }
}

/** What a piece is at, from the thread of whoever works on it when it waits on the user. */
function taskState(task: TeamTask, byId: (id: string | undefined) => Thread | undefined): string {
  const at =
    task.status === "running"
      ? byId(task.threadId)
      : task.status === "reviewing"
        ? byId(task.reviewThreadId)
        : task.status === "testing"
          ? byId(task.testThreadId)
          : undefined;
  if (at?.status === "waiting") return "attend ton accord";
  switch (task.status) {
    case "running":
      return task.tries ? `correction ${task.tries} sur ${MAX_TRIES}` : "en cours";
    case "reviewing":
      return "en relecture";
    case "testing":
      return "en tests";
    case "lead":
      return "le chef revoit la consigne";
    case "blocked":
      return "à toi de voir";
    case "waiting":
      return "en attente d'un codeur";
    case "done":
      return "terminée";
    case "failed":
      return "échouée";
    case "stopped":
      return "arrêtée";
  }
}

/** The team a lead's thread runs: the plan, each piece's progress, and a way to stop it. */
export function TeamCard({
  thread,
  team,
  threads,
  onOpenThread,
}: {
  thread: Thread;
  team: Team;
  threads: Thread[];
  onOpenThread: (id: string) => void;
}) {
  // Once asked, the button waits for the team to stop rather than asking again.
  const [stopping, setStopping] = useState(false);
  // A team started again after its stop can be stopped again.
  const isActive = active(team);
  useEffect(() => {
    if (!isActive) setStopping(false);
  }, [isActive]);
  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  // A piece asked to start again waits for its new state rather than being asked twice.
  const [retrying, setRetrying] = useState<number[]>([]);
  const states = team.tasks.map((t) => t.status).join();
  useEffect(() => setRetrying([]), [states]);
  const retry = (index: number) => {
    if (connection.send({ type: "team.retry", threadId: thread.id, index })) {
      setRetrying((r) => [...r, index]);
    }
  };
  return (
    <div className="card team-card" role="region" aria-label="Équipe">
      <div className="card-h">
        Équipe
        <span className={`team-phase ${team.phase}`}>{headline(team)}</span>
      </div>
      {team.tasks.length > 0 && (
        <ul className="team-tasks">
          {team.tasks.map((task, i) => {
            const coder = byId(task.threadId);
            const reviewer = byId(task.reviewThreadId);
            const tester = byId(task.testThreadId);
            const again =
              team.phase !== "planning" &&
              (task.status === "blocked" || task.status === "failed" || task.status === "stopped");
            return (
              <li key={i} className={`team-task ${task.status}`}>
                <span className="dot" aria-hidden />
                {coder ? (
                  <button className="lnk" onClick={() => onOpenThread(coder.id)}>
                    {task.title}
                  </button>
                ) : (
                  <span>{task.title}</span>
                )}
                <small>{taskState(task, byId)}</small>
                {(reviewer || tester || (task.status === "blocked" && task.note) || again) && (
                  <div className="team-more">
                    {task.status === "blocked" && task.note && (
                      <p className="team-note">{task.note.replace(/\n{2,}/g, "\n")}</p>
                    )}
                    <div className="team-links">
                      {reviewer && (
                        <button className="lnk sm" onClick={() => onOpenThread(reviewer.id)}>
                          Relecture
                        </button>
                      )}
                      {tester && (
                        <button className="lnk sm" onClick={() => onOpenThread(tester.id)}>
                          Tests
                        </button>
                      )}
                      {again && (
                        <button
                          className="btn sm"
                          aria-label={`Relancer « ${task.title} »`}
                          disabled={retrying.includes(i)}
                          onClick={() => retry(i)}
                        >
                          Relancer
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {isActive && (
        <div className="row">
          <button
            className="btn sm danger"
            disabled={stopping}
            onClick={() => {
              if (connection.send({ type: "team.stop", threadId: thread.id })) setStopping(true);
            }}
          >
            {stopping ? "Arrêt…" : "Arrêter l'équipe"}
          </button>
        </div>
      )}
    </div>
  );
}
