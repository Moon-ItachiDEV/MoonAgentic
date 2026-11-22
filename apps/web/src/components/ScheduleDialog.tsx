import type {
  AgentInfo,
  PermissionMode,
  Project,
  Schedule,
  ScheduleRepeat,
} from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { readPref } from "../prefs.ts";
import { fromField, nextHour, REPEATS, toField } from "../schedule.ts";

/**
 * Plans a task for later, or changes one already planned. At its time the server starts a
 * new thread of the project with the task's text; the agent is chosen here, once.
 */
export function ScheduleDialog({
  project,
  agents,
  text: initialText,
  schedule,
  onClose,
  onSaved,
}: {
  project: Project;
  agents: AgentInfo[];
  /** What was typed after `/planifier`. */
  text: string;
  /** The planned task being changed; a new one otherwise. */
  schedule?: Schedule | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ready = agents.filter((a) => a.available);
  const [text, setText] = useState(schedule?.text ?? initialText);
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [firstWhen] = useState(() =>
    toField(schedule?.enabled ? schedule.nextAt : nextHour(Date.now())),
  );
  const [when, setWhen] = useState(firstWhen);
  const [repeat, setRepeat] = useState<ScheduleRepeat>(schedule?.repeat ?? "once");
  const [agentId, setAgentId] = useState(() => {
    const last = readPref("agent");
    return schedule?.agentId ?? ready.find((a) => a.id === last)?.id ?? ready[0]?.id ?? "";
  });
  const agent = agents.find((a) => a.id === agentId);
  const [model, setModel] = useState(schedule?.model ?? "");
  // Nobody watches a planned task start: it asks before acting unless told otherwise.
  const [mode, setMode] = useState<PermissionMode>(schedule?.permissionMode ?? "supervised");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = fromField(when);

  // The models come from the agent itself: it is asked once, as the model picker does.
  useEffect(() => {
    if (schedule || !agent?.available || agent.models || agent.modelsError) return;
    connection.send({ type: "agent.discover", agentId: agent.id, projectId: project.id });
  }, [schedule, agent, project.id]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || at === null || (!schedule && !agentId)) return;
    setBusy(true);
    setError(null);
    try {
      if (schedule) {
        // Only what changed is sent: a task left as it was keeps its time, and a paused one
        // stays paused. A one-time task that has run is planned again.
        const moved =
          when !== firstWhen ||
          repeat !== schedule.repeat ||
          (!schedule.enabled && schedule.repeat === "once");
        await connection.request({
          type: "schedule.update",
          requestId: newId(),
          id: schedule.id,
          text: text.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(moved ? { at, repeat } : {}),
        });
      } else {
        const picked = model || agent?.defaultModel;
        await connection.request({
          type: "schedule.add",
          requestId: newId(),
          projectId: project.id,
          text: text.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          agentId,
          ...(picked ? { model: picked } : {}),
          permissionMode: mode,
          ...(project.git ? { isolated: true } : {}),
          repeat,
          at,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog sched"
        role="dialog"
        aria-modal
        aria-labelledby="sched-title"
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="sched-title">{schedule ? "Modifier la tâche planifiée" : "Planifier une tâche"}</h2>
        <p>
          À l'heure dite, MoonAgentic ouvre un nouveau fil dans « {project.name} » et y envoie cette
          tâche. Le serveur doit être allumé à ce moment-là : s'il ne l'était pas, la tâche part à
          son retour.
        </p>
        <label className="field">
          Tâche
          <textarea
            autoFocus
            required
            rows={3}
            value={text}
            placeholder="Lance les tests et corrige ce qui échoue"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="field">
          Nom
          <input
            value={title}
            maxLength={200}
            placeholder="Repris de la tâche si tu le laisses vide"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="team-row">
          <label className="field">
            Quand
            <input
              type="datetime-local"
              required
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <label className="field">
            Répéter
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as ScheduleRepeat)}>
              {REPEATS.map((r) => (
                <option key={r.repeat} value={r.repeat}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {schedule ? (
          <p className="hint">
            Avec {agent?.name ?? schedule.agentId}
            {schedule.permissionMode === "full"
              ? ", en accès complet"
              : ", qui demande avant d'agir"}
            . Pour changer d'agent, planifie une nouvelle tâche.
          </p>
        ) : (
          <>
            <div className="team-row">
              <label className="field">
                Agent
                <select
                  value={agentId}
                  onChange={(e) => {
                    setAgentId(e.target.value);
                    setModel("");
                  }}
                >
                  {ready.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              {agent?.models && agent.models.length > 0 && (
                <label className="field">
                  Modèle
                  <select
                    value={model || agent.defaultModel || ""}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {agent.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="field">
              Accès de l'agent
              <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                <option value="supervised">Il me demande avant d'agir (dans « À traiter »)</option>
                <option value="full">Accès complet, sans rien demander</option>
              </select>
            </label>
            {ready.length === 0 && (
              <p className="error">Aucun agent n'est prêt : ouvre les Connexions.</p>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" disabled={busy} onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn pri"
            disabled={busy || !text.trim() || at === null || (!schedule && !agentId)}
          >
            {busy ? "Enregistrement…" : schedule ? "Enregistrer" : "Planifier"}
          </button>
        </div>
      </form>
    </div>
  );
}
