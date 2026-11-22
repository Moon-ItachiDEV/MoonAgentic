import type { AgentInfo, Favorites, ModelChoice } from "@moonagentic/protocol";
import { useEffect } from "react";
import { connection } from "../connection.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconCheck, IconStar } from "./icons.tsx";

/** Agent and model menu above the composer. Agents are listed only for a new thread. */
export function Picker(props: {
  agents: AgentInfo[];
  agent: AgentInfo | undefined;
  model: string | undefined;
  favorites: Favorites;
  projectId: string | undefined;
  showAgents: boolean;
  onPickAgent: (agentId: string) => void;
  onPickModel: (model: string) => void;
  onClose: () => void;
}) {
  const { agent, favorites } = props;
  const models = agent?.models;
  const starred = agent ? (favorites[agent.id] ?? []) : [];

  const asking = !!agent?.available && !models && !agent.modelsError && !!props.projectId;
  const discover = () => {
    if (agent && props.projectId)
      connection.send({ type: "agent.discover", agentId: agent.id, projectId: props.projectId });
  };

  // The model list comes from the agent itself; the server starts it once to learn it.
  useEffect(() => {
    if (asking) discover();
  }, [agent?.id, asking, props.projectId]);

  const toggleStar = (id: string) => {
    if (!agent) return;
    connection.send({
      type: "favorites.toggle",
      agentId: agent.id,
      model: id,
      starred: !starred.includes(id),
    });
  };

  const row = (m: ModelChoice) => (
    <div key={m.id} className="mrow">
      <button
        role="menuitemradio"
        aria-checked={m.id === props.model}
        onClick={() => props.onPickModel(m.id)}
      >
        <span className="tx">
          {m.name}
          {m.description && <small>{m.description}</small>}
        </span>
        {m.id === props.model && (
          <span className="on-mark">
            <IconCheck />
          </span>
        )}
      </button>
      <button
        className={`star${starred.includes(m.id) ? " on" : ""}`}
        aria-label={starred.includes(m.id) ? "Retirer des favoris" : "Ajouter aux favoris"}
        aria-pressed={starred.includes(m.id)}
        onClick={() => toggleStar(m.id)}
      >
        <IconStar filled={starred.includes(m.id)} />
      </button>
    </div>
  );

  const favoriteModels = models?.filter((m) => starred.includes(m.id)) ?? [];
  const otherModels = models?.filter((m) => !starred.includes(m.id)) ?? [];

  return (
    <>
      <div className="menu-scrim" onClick={props.onClose} />
      <div className="menu" role="menu">
        {props.showAgents && (
          <>
            <div className="menu-h">Agent</div>
            {props.agents.map((a) => (
              <button
                key={a.id}
                role="menuitemradio"
                aria-checked={a.id === agent?.id}
                disabled={!a.available}
                onClick={() => props.onPickAgent(a.id)}
              >
                <AgentBadge agent={a} />
                <span className="tx">
                  {a.name}
                  {!a.available && a.hint && <small>{a.hint}</small>}
                </span>
                {a.id === agent?.id && (
                  <span className="on-mark">
                    <IconCheck />
                  </span>
                )}
              </button>
            ))}
          </>
        )}
        {agent?.available && (
          <div className="menu-models">
            {favoriteModels.length > 0 && <div className="menu-h">Favoris</div>}
            {favoriteModels.map(row)}
            {(otherModels.length > 0 || !models?.length) && (
              <div className="menu-h">
                {favoriteModels.length > 0 ? "Autres modèles" : `Modèles ${agent.name}`}
              </div>
            )}
            {!models && !props.projectId && (
              <div className="menu-note">Crée d'abord un projet pour voir les modèles.</div>
            )}
            {asking && <div className="menu-note">Je demande la liste à {agent.name}…</div>}
            {!models && agent.modelsError && (
              <div className="menu-note err">
                Impossible de lister les modèles de {agent.name}.<small>{agent.modelsError}</small>
                {props.projectId && (
                  <button className="retry" onClick={discover}>
                    Réessayer
                  </button>
                )}
              </div>
            )}
            {models?.length === 0 && (
              <div className="menu-note">{agent.name} ne propose pas de choix de modèle.</div>
            )}
            {otherModels.map(row)}
          </div>
        )}
        <button className="menu-close" onClick={props.onClose}>
          Fermer
        </button>
      </div>
    </>
  );
}
