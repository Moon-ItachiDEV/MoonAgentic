import type { AgentInfo, Favorites, TeamPreset, TeamRole } from "@moonagentic/protocol";
import { MAX_TEAM_PRESETS } from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import {
  addPreset,
  OPTIONAL_ROLES,
  presetMembers,
  ROLE_LABEL,
  setRole,
  TEAM_ROLES,
  teamPresets,
} from "../team-presets.ts";
import { modelNameOf } from "../model-label.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";

/** What each role does, after the model's name, in a team's one-line summary. */
const ROLE_VERB: Record<TeamRole, string> = {
  lead: "pilote",
  coder: "code",
  reviewer: "relit",
  reviewer2: "relit aussi",
  judge: "arbitre",
  tester: "teste",
  merger: "fusionne",
};

/** One role of a team: who takes it, and the sheet to pick someone else. */
function RoleRow(props: {
  role: TeamRole;
  team: string;
  agents: AgentInfo[];
  favorites: Favorites;
  value: { agentId: string; model?: string } | undefined;
  onChange: (pick: { agentId: string; model?: string } | undefined) => void;
}) {
  const [all, setAll] = useState(false);
  const { groups, favoritesOnly } = routeChoices(props.agents, props.favorites, props.value, all);
  const optional = OPTIONAL_ROLES.has(props.role);
  const choices: Choice[] = [
    ...(optional ? [{ value: "", label: "Personne" }] : []),
    ...groups.flatMap((g) =>
      g.options.map((o) => ({ value: o.value, label: o.label, group: g.agent.name })),
    ),
  ];
  const value = props.value ? routeValue(props.value.agentId, props.value.model) : "";
  return (
    <ChoiceRow
      title={ROLE_LABEL[props.role]}
      label={`${ROLE_LABEL[props.role]} de ${props.team}`}
      value={value}
      shown={choices.find((c) => c.value === value)?.label ?? (optional ? "Personne" : "")}
      choices={choices}
      {...(favoritesOnly || all
        ? { more: { label: all ? "Favoris" : "Tous", on: all, toggle: () => setAll((on) => !on) } }
        : {})}
      onPick={(picked) => props.onChange(parseRouteValue(picked))}
    />
  );
}

/**
 * The teams /equipe offers and the coordinator starts from: who takes each role, kept by
 * the server for every device. The suggested ones stand until the user changes one.
 */
export function TeamPresets(props: { agents: AgentInfo[]; projectId: string | undefined }) {
  const kept = useSyncExternalStore(connection.subscribe, () => connection.getState().teamPresets);
  // What this window just sent, until the server sends it back: a click right after leaving
  // a name (renamed on blur) builds on the new name, not on the list from before.
  const [sent, setSent] = useState<{ presets: TeamPreset[] | null; over: typeof kept }>();
  const saved = sent && sent.over === kept ? sent.presets : kept;
  const presets = teamPresets(saved ?? undefined, props.agents);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // The name being typed, by team, until it is left.
  const [naming, setNaming] = useState<Record<string, string>>({});
  const favorites = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().favorites,
  );
  const [openId, setOpenId] = useState<string>();
  const keep = (next: TeamPreset[] | null) => {
    setSent({ presets: next, over: kept });
    connection.send({ type: "teamPresets.set", presets: next });
  };

  // The suggested teams need each agent's models: asked for once, as /equipe does, or the
  // first change would keep teams made before the models were known.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const agent of props.agents) {
      if (!agent.available || agent.models || agent.modelsError) continue;
      if (asked.current.has(agent.id)) continue;
      asked.current.add(agent.id);
      connection.send({
        type: "agent.discover",
        agentId: agent.id,
        ...(props.projectId ? { projectId: props.projectId } : {}),
      });
    }
  }, [props.agents, props.projectId]);

  const open = presets.find((p) => p.id === openId);
  const openAt = open ? presets.indexOf(open) : -1;
  const name = open ? (naming[open.id] ?? open.label) : "";
  const rename = () => {
    if (!open) return;
    const label = name.trim();
    setNaming(({ [open.id]: _gone, ...rest }) => rest);
    if (label && label !== open.label) {
      keep(presets.map((p) => (p.id === open.id ? { ...p, label } : p)));
    }
  };
  const who = (preset: TeamPreset) => {
    const members = presetMembers(preset, props.agents);
    return TEAM_ROLES.flatMap((role) => {
      const m = members[role];
      if (!m) return [];
      const agent = props.agents.find((a) => a.id === m.agentId);
      const model = modelNameOf(agent?.models, m.model)?.replace(
        / \((par défaut|recommandé)\)$/,
        "",
      );
      return [`${model ?? agent?.name ?? m.agentId} ${ROLE_VERB[role]}`];
    }).join(" · ");
  };

  return (
    <>
      <div className="ins">
        {presets.map((preset, index) => (
          <button
            key={preset.id}
            className="it"
            aria-haspopup="dialog"
            onClick={() => setOpenId(preset.id)}
          >
            <span className="tx">
              {preset.label}
              <small>{who(preset)}</small>
            </span>
            <span className="rt">
              {index === 0 && "Par défaut"}
              <I n="right" s={15} />
            </span>
          </button>
        ))}
        {presets.length < MAX_TEAM_PRESETS && (
          <button
            className="it acc"
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
            <I n="plus" s={18} />
            <span className="tx">Nouvelle équipe</span>
          </button>
        )}
      </div>
      {saved && (
        <div className="ins">
          <button
            className="it acc"
            onClick={() =>
              setConfirm({
                title: "Revenir aux équipes suggérées ?",
                text: "Tes équipes sont remplacées",
                action: "Revenir aux suggestions",
                run: () => keep(null),
              })
            }
          >
            <span className="tx">Revenir aux suggestions</span>
          </button>
        </div>
      )}
      <Sheet
        open={!!open}
        onClose={() => {
          rename();
          setOpenId(undefined);
        }}
        title="Équipe"
        tall
      >
        {open && (
          <div className="sbody">
            <div className="rnb">
              <input
                className="rni"
                aria-label={`Nom de l'équipe ${open.label}`}
                value={name}
                maxLength={40}
                autoComplete="off"
                onChange={(e) => setNaming((n) => ({ ...n, [open.id]: e.target.value }))}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setNaming(({ [open.id]: _gone, ...rest }) => rest);
                  }
                }}
              />
            </div>
            <div className="gl2">Rôles</div>
            <div className="ins">
              {TEAM_ROLES.map((role) => (
                <RoleRow
                  key={role}
                  role={role}
                  team={open.label}
                  agents={props.agents}
                  favorites={favorites}
                  value={presetMembers(open, props.agents)[role]}
                  // Only this role changes: the others stay as saved, even one whose
                  // agent is away for now.
                  onChange={(pick) => keep(setRole(presets, open.id, role, pick))}
                />
              ))}
            </div>
            {presets.length > 1 && (
              <div className="ins">
                {openAt > 0 && (
                  <button
                    className="it acc"
                    onClick={() => keep([open, ...presets.filter((p) => p.id !== open.id)])}
                  >
                    <span className="tx">Mettre en premier</span>
                  </button>
                )}
                <button
                  className="it dng"
                  aria-label={`Supprimer l'équipe ${open.label}`}
                  onClick={() =>
                    setConfirm({
                      title: `Supprimer « ${open.label} » ?`,
                      text: "",
                      action: "Supprimer",
                      run: () => {
                        setOpenId(undefined);
                        keep(presets.filter((p) => p.id !== open.id));
                      },
                    })
                  }
                >
                  <span className="tx">Supprimer</span>
                </button>
              </div>
            )}
          </div>
        )}
      </Sheet>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
