import type { Team, TeamTask, Thread } from "@moonagentic/protocol";
import { useState } from "react";
import { connection } from "../connection.ts";

const active = (team: Team) => team.phase === "planning" || team.phase === "coding";

function headline(team: Team): string {
  const done = team.tasks.filter((t) => t.status === "done").length;
  switch (team.phase) {
    case "planning":
      return "Le chef lit le projet et prépare le plan…";
    case "coding":
      return `Les codeurs travaillent : ${done} sur ${team.tasks.length} terminée${done > 1 ? "s" : ""}.`;
    case "done":
      return "Terminé : chaque sous-tâche est prête sur sa branche.";
    case "failed":
      return team.error ?? "L'équipe s'est arrêtée sur une erreur.";
    case "stopped":
      return team.error ?? "Équipe arrêtée.";
  }
}

/** What a task's coder is doing, from its own thread when it has one. */
function taskState(task: TeamTask, coder: Thread | undefined): string {
  if (task.status === "running" && coder?.status === "waiting") return "attend ton accord";
  return {
    waiting: "en attente d'un codeur",
    running: "en cours",
    done: "terminée",
    failed: "échouée",
    stopped: "arrêtée",
  }[task.status];
}

/** The team a lead's thread runs: the plan, each coder's progress, and a way to stop it. */
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
  return (
    <div className="card team-card" role="region" aria-label="Équipe">
      <div className="card-h">
        Équipe
        <span className={`team-phase ${team.phase}`}>{headline(team)}</span>
      </div>
      {team.tasks.length > 0 && (
        <ul className="team-tasks">
          {team.tasks.map((task, i) => {
            const coder = task.threadId ? threads.find((t) => t.id === task.threadId) : undefined;
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
                <small>{taskState(task, coder)}</small>
              </li>
            );
          })}
        </ul>
      )}
      {active(team) && (
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
