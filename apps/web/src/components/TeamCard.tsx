import type { AgentInfo, Team, TeamTask, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { Markdown } from "./Markdown.tsx";
import { Clamp } from "./Clamp.tsx";

/** Corrections a coder gets before the lead steps in, as the server counts them. */
const MAX_TRIES = 3;

const active = (team: Team) =>
  team.phase === "planning" || team.phase === "coding" || team.phase === "merging";
/** Every piece done, to be merged onto one branch: more than one, as the server does. */
const mergeable = (team: Team) =>
  team.tasks.length > 1 && team.tasks.every((t) => t.status === "done");
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

function headline(team: Team): string {
  const done = team.tasks.filter((t) => t.status === "done").length;
  switch (team.phase) {
    case "planning":
      return "Le chef lit le projet et prépare le plan…";
    case "coding":
      return `L'équipe travaille : ${done} sur ${team.tasks.length} ${plural(done, "terminée", "terminées")}.`;
    case "merging":
      return team.mergeStep === -1
        ? "Le fusionneur vérifie que les sous-tâches marchent ensemble…"
        : team.mergeStep !== undefined
          ? "Le fusionneur règle un conflit…"
          : "Fusion des sous-tâches sur une seule branche…";
    case "blocked": {
      const left = team.tasks.filter((t) => t.status === "blocked").length;
      // Nothing blocked but the merge: why is said on its step.
      if (!left) return "La fusion t'attend.";
      return `${left} ${plural(left, "sous-tâche t'attend", "sous-tâches t'attendent")} : ${plural(left, "ouvre son fil, puis relance-la", "ouvre leurs fils, puis relance-les")}.`;
    }
    case "done":
      return team.mergeThreadId
        ? "Terminé : tout est réuni sur une branche, prête à relire et à envoyer."
        : "Terminé : chaque sous-tâche est prête sur sa branche.";
    case "failed":
      return "L'équipe s'est arrêtée sur une erreur.";
    case "stopped":
      return "Équipe arrêtée.";
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
      return task.merged ? "fusionnée" : "terminée";
    case "failed":
      return "échouée";
    case "stopped":
      return "arrêtée";
  }
}

/** A verdict line is for the server: the note says what it means already. */
const noteText = (note: string) => note.replace(/^\s*VERDICT\s*:.*$/gim, "").trim() || note.trim();

/** What the lead is at: the plan, then the pieces it is asked to look at again. */
function leadState(team: Team): string {
  if (team.phase === "planning") return "en cours";
  if (!team.tasks.length && team.phase === "stopped") return "arrêté";
  if (team.tasks.some((t) => t.status === "lead")) return "revoit une consigne";
  const n = team.tasks.length;
  return n ? `${n} ${plural(n, "sous-tâche", "sous-tâches")}` : "pas de plan";
}

/** What the merge is at; before it starts, it waits on the coders. */
function mergeState(team: Team): string {
  switch (team.phase) {
    case "merging":
      return team.mergeStep === -1 ? "vérifie l'ensemble" : "en cours";
    case "done":
      return "faite";
    case "blocked":
      return team.tasks.some((t) => t.status === "blocked") ? "après les codeurs" : "à toi de voir";
    case "planning":
    case "coding":
      return "après les codeurs";
    default:
      return team.mergeThreadId ? "arrêtée" : "pas commencée";
  }
}

/**
 * The team a lead's thread runs, as a list of steps: the lead's plan, each piece with who
 * codes, reviews and tests it, then the merge. Long notes show their start only.
 */
export function TeamCard({
  thread,
  team,
  threads,
  agents,
  onOpenThread,
}: {
  thread: Thread;
  team: Team;
  threads: Thread[];
  agents: AgentInfo[];
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
  const nameOf = (agentId: string | undefined) =>
    agents.find((a) => a.id === agentId)?.name ?? "Agent retiré";
  // A piece asked to start again is not asked twice before the server answers.
  const [retrying, setRetrying] = useState<number[]>([]);
  const merge = byId(team.mergeThreadId);
  const retryMerge = !isActive && team.phase !== "done" && mergeable(team);
  const hasMerge = !!team.merger || !!merge;
  // Why the team stopped, said on the merge's step when it is the merge's doing.
  const mergeBlocked = team.phase === "blocked" && !team.tasks.some((t) => t.status === "blocked");
  const error =
    team.error && (team.phase === "blocked" || team.phase === "failed" || team.phase === "stopped")
      ? team.error
      : undefined;
  // -1 stands for the merge. The button waits for the server's answer, not for a guess.
  const retry = (index: number) => {
    setRetrying((r) => [...r, index]);
    connection
      .request({
        type: "team.retry",
        requestId: newId(),
        threadId: thread.id,
        ...(index >= 0 ? { index } : {}),
      })
      .catch((error: unknown) =>
        connection.notify(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setRetrying((r) => r.filter((i) => i !== index)));
  };
  const lead =
    team.phase === "planning" || (isActive && team.tasks.some((t) => t.status === "lead"))
      ? "running"
      : team.tasks.length
        ? "done"
        : team.phase === "stopped"
          ? "stopped"
          : "failed";
  const mergeDot =
    team.phase === "merging"
      ? "running"
      : team.phase === "done"
        ? "done"
        : mergeBlocked
          ? "blocked"
          : "waiting";
  return (
    <div className="card team-card" role="region" aria-label="Équipe">
      <div className="card-h">
        Équipe
        <span className={`team-phase ${team.phase}`}>{headline(team)}</span>
      </div>
      <ul className="team-tasks">
        <li className={`team-task step ${lead}`} aria-label="Plan du chef">
          <span className="dot" aria-hidden />
          <span className="team-what">
            <span>Découper la tâche</span>
            <span className="team-who">Chef · {nameOf(thread.agentId)}</span>
          </span>
          <small>{leadState(team)}</small>
        </li>
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
              <span className="team-what">
                {coder ? (
                  <button className="lnk" onClick={() => onOpenThread(coder.id)}>
                    {task.title}
                  </button>
                ) : (
                  <span>{task.title}</span>
                )}
                <span className="team-who">
                  Codeur · {nameOf(coder?.agentId ?? team.coder.agentId)}
                </span>
              </span>
              <small>{taskState(task, byId)}</small>
              {(reviewer || tester || (task.status === "blocked" && task.note) || again) && (
                <div className="team-more">
                  {task.status === "blocked" && task.note && (
                    <div className="team-note">
                      <Clamp>
                        <Markdown text={noteText(task.note)} />
                      </Clamp>
                    </div>
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
        {hasMerge && (
          <li className={`team-task step ${mergeDot}`} aria-label="Fusion">
            <span className="dot" aria-hidden />
            <span className="team-what">
              <span>Réunir les sous-tâches</span>
              <span className="team-who">
                Fusionneur · {nameOf(merge?.agentId ?? team.merger?.agentId)}
              </span>
            </span>
            <small>{mergeState(team)}</small>
            {(merge || retryMerge || (mergeBlocked && error)) && (
              <div className="team-more">
                {mergeBlocked && error && (
                  <div className="team-note">
                    <Clamp>
                      <Markdown text={noteText(error)} />
                    </Clamp>
                  </div>
                )}
                <div className="team-links">
                  {merge && (
                    <button className="lnk sm" onClick={() => onOpenThread(merge.id)}>
                      Ouvrir la fusion
                    </button>
                  )}
                  {retryMerge && (
                    <button
                      className="btn sm"
                      disabled={retrying.includes(-1)}
                      onClick={() => retry(-1)}
                    >
                      Relancer la fusion
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        )}
      </ul>
      {error && !(hasMerge && mergeBlocked) && (
        <div className="team-note">
          <Clamp>
            <Markdown text={noteText(error)} />
          </Clamp>
        </div>
      )}
      {!hasMerge && retryMerge && (
        <div className="row">
          <button className="btn sm" disabled={retrying.includes(-1)} onClick={() => retry(-1)}>
            Relancer la fusion
          </button>
        </div>
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
