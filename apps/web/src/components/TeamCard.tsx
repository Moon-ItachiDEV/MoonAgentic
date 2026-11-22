import type { Team, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";

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
      if (team.shipped?.opened) return "Terminé : la PR est ouverte, prête à relire.";
      return team.mergeThreadId
        ? "Terminé : tout est réuni sur une branche, prête à relire et à envoyer."
        : "Terminé : chaque sous-tâche est prête sur sa branche.";
    case "failed":
      return "L'équipe s'est arrêtée sur une erreur.";
    case "stopped":
      return "Équipe arrêtée.";
  }
}

/** A verdict line is for the server: the note says what it means already. */
const noteText = (note: string) => note.replace(/^\s*VERDICT\s*:.*$/gim, "").trim() || note.trim();

/** The branch that holds a finished team's work: the merge's, or its only piece's. */
const shipTarget = (team: Team) =>
  team.mergeThreadId ?? (team.tasks.length === 1 ? team.tasks[0]?.threadId : undefined);

/**
 * What there is to do about the team, right under its timeline: nothing while it works but
 * a way to stop it, then the pieces to start again, the merge to open, the pull request.
 * The timeline already says who does what; this says only what is yours to do.
 */
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
  // A piece asked to start again is not asked twice before the server answers.
  const [retrying, setRetrying] = useState<number[]>([]);
  const merge = byId(team.mergeThreadId);
  const retryMerge = !isActive && team.phase !== "done" && mergeable(team);
  // Why the team stopped is the merge's doing: its thread tells the whole story.
  const mergeBlocked = team.phase === "blocked" && !team.tasks.some((t) => t.status === "blocked");
  const error =
    team.error && (team.phase === "blocked" || team.phase === "failed" || team.phase === "stopped")
      ? team.error
      : undefined;
  const canShip =
    team.phase === "done" && !team.shipping && !team.shipped?.opened && !!shipTarget(team);
  const shipNote = team.shipError ?? team.shipped?.note;
  const [shipping, setShipping] = useState(false);
  const shipAgain = () => {
    setShipping(true);
    connection
      .request({ type: "team.ship", requestId: newId(), threadId: thread.id })
      .catch((error: unknown) =>
        connection.notify(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setShipping(false));
  };
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
  const again = team.tasks
    .map((task, i) => ({ task, i }))
    .filter(
      ({ task }) =>
        team.phase !== "planning" &&
        (task.status === "blocked" || task.status === "failed" || task.status === "stopped"),
    );
  const showMerge = !!merge && (mergeBlocked || team.phase === "done" || retryMerge);
  const showShip = !!team.shipped?.url || canShip;
  // While it works, the timeline says it all: only the way to stop it stays.
  const say = isActive ? undefined : headline(team);
  const note = mergeBlocked ? undefined : (shipNote ?? (error && noteText(error)));
  if (!isActive && !again.length && !showMerge && !retryMerge && !showShip && !note) {
    return say ? (
      <div className="team-acts" role="region" aria-label="Équipe">
        <span className={`team-phase ${team.phase}`}>{say}</span>
      </div>
    ) : null;
  }
  return (
    <div className="team-acts" role="region" aria-label="Équipe">
      {say && <span className={`team-phase ${team.phase}`}>{say}</span>}
      {note && (
        <span className="team-acts-note" title={note}>
          {note.split("\n").find((l) => l.trim())}
        </span>
      )}
      <span className="team-acts-row">
        {again.map(({ task, i }) => {
          const coder = byId(task.threadId);
          return (
            <span key={i} className="team-acts-piece">
              {coder && (
                <button className="lnk sm" onClick={() => onOpenThread(coder.id)}>
                  {task.title}
                </button>
              )}
              <button
                className="btn sm"
                aria-label={`Relancer « ${task.title} »`}
                disabled={retrying.includes(i)}
                onClick={() => retry(i)}
              >
                Relancer
              </button>
            </span>
          );
        })}
        {showMerge && merge && (
          <button className="lnk sm" onClick={() => onOpenThread(merge.id)}>
            Ouvrir la fusion
          </button>
        )}
        {retryMerge && (
          <button className="btn sm" disabled={retrying.includes(-1)} onClick={() => retry(-1)}>
            Relancer la fusion
          </button>
        )}
        {team.shipped?.url && (
          <a className="lnk sm" href={team.shipped.url} target="_blank" rel="noreferrer">
            {team.shipped.opened ? "Voir la PR" : "Créer la PR sur GitHub"}
          </a>
        )}
        {canShip && (
          <button className="btn sm" disabled={shipping} onClick={shipAgain}>
            {team.shipError || team.shipped ? "Réessayer" : "Ouvrir la PR"}
          </button>
        )}
        {isActive && (
          <button
            className="btn sm danger"
            disabled={stopping}
            onClick={() => {
              if (connection.send({ type: "team.stop", threadId: thread.id })) setStopping(true);
            }}
          >
            {stopping ? "Arrêt…" : "Arrêter l'équipe"}
          </button>
        )}
      </span>
    </div>
  );
}
