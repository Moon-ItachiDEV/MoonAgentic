import type { AgentInfo, TeamPreset } from "@moonagentic/protocol";
import { MAX_TEAM_PRESETS } from "@moonagentic/protocol";
import { useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import {
  addPreset,
  OPTIONAL_ROLES,
  presetMembers,
  ROLE_LABEL,
  TEAM_ROLES,
  teamPresets,
  withRoles,
} from "../team-presets.ts";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { ModelSelect } from "./ModelSelect.tsx";

/**
 * The teams /equipe offers and the coordinator starts from: who takes each role, kept by
 * the server for every device. The suggested ones stand until the user changes one.
 */
export function TeamPresets(props: { agents: AgentInfo[]; projectId: string | undefined }) {
  const saved = useSyncExternalStore(connection.subscribe, () => connection.getState().teamPresets);
  const presets = teamPresets(saved ?? undefined, props.agents);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // The name being typed, by team, until it is left.
  const [naming, setNaming] = useState<Record<string, string>>({});
  const keep = (next: TeamPreset[] | null) => {
    connection.send({ type: "teamPresets.set", presets: next });
  };

  return (
    <>
      <p className="set-empty">
        {saved
          ? "La première sert au coordinateur quand tu n'as pas encore lancé d'équipe toi-même."
          : "Des équipes suggérées d'après les modèles de tes agents. Change un rôle : elles deviennent les tiennes."}
      </p>
      {presets.map((preset, index) => {
        const members = presetMembers(preset, props.agents);
        const name = naming[preset.id] ?? preset.label;
        const rename = () => {
          const label = name.trim();
          setNaming(({ [preset.id]: _gone, ...rest }) => rest);
          if (label && label !== preset.label) {
            keep(presets.map((p) => (p.id === preset.id ? { ...p, label } : p)));
          }
        };
        return (
          <div key={preset.id} className="set-card tp-card">
            <div className="tp-head">
              <input
                className="tp-name"
                aria-label={`Nom de l'équipe ${preset.label}`}
                value={name}
                maxLength={40}
                onChange={(e) => setNaming((n) => ({ ...n, [preset.id]: e.target.value }))}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setNaming(({ [preset.id]: _gone, ...rest }) => rest);
                  }
                }}
              />
              {index === 0 ? (
                <span className="tp-tag">Par défaut</span>
              ) : (
                <button
                  className="btn quiet sm"
                  onClick={() => keep([preset, ...presets.filter((p) => p.id !== preset.id)])}
                >
                  Mettre en premier
                </button>
              )}
              {presets.length > 1 && (
                <button
                  className="btn quiet sm tp-del"
                  aria-label={`Supprimer l'équipe ${preset.label}`}
                  onClick={() =>
                    setConfirm({
                      title: `Supprimer « ${preset.label} » ?`,
                      text: "Elle n'est plus proposée par /equipe ni au coordinateur.",
                      action: "Supprimer",
                      run: () => keep(presets.filter((p) => p.id !== preset.id)),
                    })
                  }
                >
                  Supprimer
                </button>
              )}
            </div>
            {TEAM_ROLES.map((role) => (
              <div key={role} className="set-row tp-row">
                <span className="tp-role">{ROLE_LABEL[role]}</span>
                <ModelSelect
                  label={`${ROLE_LABEL[role]} de ${preset.label}`}
                  agents={props.agents}
                  value={members[role]}
                  {...(OPTIONAL_ROLES.has(role) ? { none: "Personne" } : {})}
                  {...(props.projectId ? { projectId: props.projectId } : {})}
                  onChange={(pick) =>
                    keep(withRoles(presets, preset.id, { ...members, [role]: pick }))
                  }
                />
              </div>
            ))}
          </div>
        );
      })}
      <div className="tp-acts">
        {presets.length < MAX_TEAM_PRESETS && (
          <button
            className="btn"
            onClick={() =>
              keep(
                addPreset(
                  presets,
                  presets[0] ? presets[0].roles : {},
                  `equipe-${newId()
                    .replace(/[^\w-]/g, "")
                    .slice(0, 12)}`,
                ),
              )
            }
          >
            Nouvelle équipe
          </button>
        )}
        {saved && (
          <button
            className="btn quiet"
            onClick={() =>
              setConfirm({
                title: "Revenir aux équipes suggérées ?",
                text: "Tes équipes sont remplacées par celles que MoonAgentic suggère d'après les modèles de tes agents.",
                action: "Revenir aux suggestions",
                run: () => keep(null),
              })
            }
          >
            Revenir aux suggestions
          </button>
        )}
      </div>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
