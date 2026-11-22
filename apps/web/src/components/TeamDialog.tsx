import type { AgentInfo, PermissionMode, Project, TeamMember } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";

/** The agent and model to start a role on: the model the role prefers, when an agent offers it. */
export function pickMember(agents: AgentInfo[], prefer: RegExp): TeamMember | undefined {
  const usable = agents.filter((a) => a.available);
  for (const agent of usable) {
    const model = agent.models?.find((m) => prefer.test(m.name) || prefer.test(m.id));
    if (model) return { agentId: agent.id, model: model.id };
  }
  const first = usable[0];
  return (
    first && { agentId: first.id, ...(first.defaultModel ? { model: first.defaultModel } : {}) }
  );
}

function MemberPicker({
  label,
  agents,
  member,
  onChange,
}: {
  label: string;
  agents: AgentInfo[];
  member: TeamMember | undefined;
  onChange: (member: TeamMember) => void;
}) {
  const agent = agents.find((a) => a.id === member?.agentId);
  return (
    <div className="team-member">
      <label className="field">
        {label}
        <select
          value={member?.agentId ?? ""}
          onChange={(e) => {
            const next = agents.find((a) => a.id === e.target.value);
            if (next)
              onChange({
                agentId: next.id,
                ...(next.defaultModel ? { model: next.defaultModel } : {}),
              });
          }}
        >
          {agents
            .filter((a) => a.available)
            .map((a) => (
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
            aria-label={`Modèle : ${label.toLowerCase()}`}
            value={member?.model ?? ""}
            onChange={(e) => onChange({ agentId: agent.id, model: e.target.value })}
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
  );
}

/** Gives a task to a team: a lead plans it, then coders do the pieces at once. */
export function TeamDialog({
  project,
  agents,
  task: initialTask,
  onClose,
  onStarted,
}: {
  project: Project;
  agents: AgentInfo[];
  task: string;
  onClose: () => void;
  onStarted: (leadId: string) => void;
}) {
  const [task, setTask] = useState(initialTask);
  const [lead, setLead] = useState(() => pickMember(agents, /fable/i));
  const [coder, setCoder] = useState(() => pickMember(agents, /opus/i));
  const [coders, setCoders] = useState(2);
  const [mode, setMode] = useState<PermissionMode>("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lead || !coder || !task.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await connection.request({
        type: "team.start",
        requestId: newId(),
        projectId: project.id,
        task: task.trim(),
        lead,
        coder,
        coders,
        permissionMode: mode,
      });
      onStarted(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog team"
        role="dialog"
        aria-modal
        aria-labelledby="team-title"
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="team-title">Confier à une équipe</h2>
        <p>
          Le chef lit {project.name} sans rien modifier et découpe la tâche. Chaque codeur fait sa
          part en même temps, sur sa propre branche.
        </p>
        <label className="field">
          Tâche
          <textarea
            autoFocus
            required
            rows={3}
            value={task}
            placeholder="Ajoute l'export CSV aux rapports"
            onChange={(e) => setTask(e.target.value)}
          />
        </label>
        <MemberPicker label="Chef" agents={agents} member={lead} onChange={setLead} />
        <MemberPicker label="Codeurs" agents={agents} member={coder} onChange={setCoder} />
        <div className="team-row">
          <div className="field">
            Codeurs en même temps
            <div className="seg" role="radiogroup" aria-label="Codeurs en même temps">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={coders === n}
                  className={coders === n ? "on" : ""}
                  onClick={() => setCoders(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            Accès des codeurs
            <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              <option value="full">Accès complet à leur branche</option>
              <option value="supervised">Ils me demandent avant d'agir</option>
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" disabled={busy} onClick={onClose}>
            Annuler
          </button>
          <button className="btn" disabled={busy || !lead || !coder || !task.trim()}>
            {busy ? "Lancement…" : "Lancer l'équipe"}
          </button>
        </div>
      </form>
    </div>
  );
}
