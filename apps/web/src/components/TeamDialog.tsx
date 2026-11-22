import type { AgentInfo, PermissionMode, Project, TeamMember } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { pickMember, TEAM_PRESETS, type TeamRole } from "../team-presets.ts";

function MemberPicker({
  label,
  agents,
  member,
  onChange,
  optional,
}: {
  label: string;
  agents: AgentInfo[];
  member: TeamMember | undefined;
  onChange: (member: TeamMember | undefined) => void;
  /** Offers « Personne », for a role the team can do without. */
  optional?: boolean;
}) {
  const agent = agents.find((a) => a.id === member?.agentId);
  return (
    <div className="team-member">
      <label className="field">
        {label}
        <select
          aria-label={label}
          value={member?.agentId ?? ""}
          onChange={(e) => {
            const next = agents.find((a) => a.id === e.target.value);
            if (!next) onChange(undefined);
            else
              onChange({
                agentId: next.id,
                ...(next.defaultModel ? { model: next.defaultModel } : {}),
              });
          }}
        >
          {optional && <option value="">Personne</option>}
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
  const [presetId, setPresetId] = useState(TEAM_PRESETS[0]!.id);
  const preset = TEAM_PRESETS.find((p) => p.id === presetId) ?? TEAM_PRESETS[0]!;
  // Until the user picks, a role follows the preset and the agents as their models arrive;
  // `null` once the user said nobody, and the team does without that role.
  const [choices, setChoices] = useState<Partial<Record<TeamRole, TeamMember | null>>>({});
  const member = (role: TeamRole) => {
    const chosen = choices[role];
    return chosen === undefined ? pickMember(agents, preset.prefer[role]) : (chosen ?? undefined);
  };
  const choose = (role: TeamRole) => (m: TeamMember | undefined) =>
    setChoices((c) => ({ ...c, [role]: m ?? null }));
  const lead = member("lead");
  const coder = member("coder");
  const reviewer = member("reviewer");
  const tester = member("tester");
  const merger = member("merger");
  const noGit = !project.git;
  const [coders, setCoders] = useState(2);
  const [mode, setMode] = useState<PermissionMode>("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The models come from the agents themselves: each is asked once, as the model picker does.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const agent of agents) {
      if (!agent.available || agent.models || agent.modelsError) continue;
      if (asked.current.has(agent.id)) continue;
      asked.current.add(agent.id);
      connection.send({ type: "agent.discover", agentId: agent.id, projectId: project.id });
    }
  }, [agents, project.id]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lead || !coder || !task.trim() || noGit) return;
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
        ...(reviewer ? { reviewer } : {}),
        ...(tester ? { tester } : {}),
        ...(merger ? { merger } : {}),
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
          Le chef lit « {project.name} » sans rien modifier et découpe la tâche. Chaque codeur fait
          sa part en même temps, sur sa propre branche. Le relecteur et le testeur la vérifient : ce
          qu'ils trouvent repart au codeur trois fois au plus, puis au chef, puis à toi. Le
          fusionneur réunit enfin les branches sur une seule.
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
        <div className="field">
          Équipe
          <div className="seg presets" role="radiogroup" aria-label="Équipe">
            {TEAM_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === preset.id}
                className={p.id === preset.id ? "on" : ""}
                onClick={() => {
                  setPresetId(p.id);
                  setChoices({});
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <small className="hint">{preset.hint}</small>
        </div>
        <MemberPicker label="Chef" agents={agents} member={lead} onChange={choose("lead")} />
        <MemberPicker label="Codeurs" agents={agents} member={coder} onChange={choose("coder")} />
        <MemberPicker
          label="Relecteur"
          agents={agents}
          member={reviewer}
          onChange={choose("reviewer")}
          optional
        />
        <MemberPicker
          label="Testeur"
          agents={agents}
          member={tester}
          onChange={choose("tester")}
          optional
        />
        <MemberPicker
          label="Fusionneur"
          agents={agents}
          member={merger}
          onChange={choose("merger")}
          optional
        />
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
        {noGit && (
          <p className="error">
            « {project.name} » n'est pas un dépôt git : chaque codeur a besoin de sa propre branche.
            Lance <code>git init</code> dans ce dossier pour confier une tâche à une équipe.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" disabled={busy} onClick={onClose}>
            Annuler
          </button>
          <button className="btn pri" disabled={busy || noGit || !lead || !coder || !task.trim()}>
            {busy ? "Lancement…" : "Lancer l'équipe"}
          </button>
        </div>
      </form>
    </div>
  );
}
