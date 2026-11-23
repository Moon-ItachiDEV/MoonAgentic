import {
  type AgentInfo,
  MASCOT_COLORS,
  MASCOT_SHAPES,
  type Mascot as MascotChoice,
} from "@moonagentic/protocol";
import { useState } from "react";
import { agentLogo } from "../agent-logos.ts";
import { connection } from "../connection.ts";
import { MASCOT_COLOR_NAMES, MASCOT_SHAPE_NAMES } from "../mascot.ts";
import { defineMoonMascot } from "../moon-mascot.ts";
import { AgentBadge } from "./AgentBadge.tsx";

defineMoonMascot();

/**
 * Settings › Mascottes: each agent's moon, its shape and colour, kept by the server for every
 * device. The large moon rests here: its other faces only show what an agent really does.
 */
export function MascotSettings({ agents }: { agents: AgentInfo[] }) {
  const [picked, setPicked] = useState(() => (agents.find((a) => a.mascot) ?? agents[0])?.id);
  const agent = agents.find((a) => a.id === picked) ?? agents[0];
  if (!agent) return <p className="set-empty">Aucun agent pour l'instant.</p>;
  const mascot = agent.mascot;

  const choose = (next: MascotChoice | null) =>
    connection.send({ type: "agent.setMascot", agentId: agent.id, mascot: next });

  return (
    <>
      <div className="mascot-agents" role="group" aria-label="Agent">
        {agents.map((a) => (
          <button
            key={a.id}
            className="mascot-tile"
            aria-pressed={a.id === agent.id}
            onClick={() => setPicked(a.id)}
          >
            <AgentBadge agent={a} small />
            {a.name}
          </button>
        ))}
      </div>
      <div className="set-card">
        <div className="mascot-set">
          {mascot ? (
            <div className="mascot-sky" data-moon={mascot.color}>
              <moon-mascot
                shape={mascot.shape}
                color={mascot.color}
                expression="idle"
                label={`Faire un clin d’œil à ${agent.name}`}
              />
            </div>
          ) : (
            <div className="mascot-sky none">
              Pas de mascotte : {agent.name} garde{" "}
              {agentLogo(agent.id) ? "son logo" : "ses lettres"}.
            </div>
          )}
          <div className="mascot-opts">
            <div>
              <h4>Forme</h4>
              <div className="mascot-grid" role="group" aria-label="Forme">
                <button className="mascot-tile" aria-pressed={!mascot} onClick={() => choose(null)}>
                  Aucune
                </button>
                {MASCOT_SHAPES.map((shape) => (
                  <button
                    key={shape}
                    className="mascot-tile"
                    aria-pressed={mascot?.shape === shape}
                    onClick={() => choose({ shape, color: mascot?.color ?? "ice" })}
                  >
                    {MASCOT_SHAPE_NAMES[shape]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h4>Couleur</h4>
              <div className="mascot-grid" role="group" aria-label="Couleur">
                {MASCOT_COLORS.map((color) => (
                  <button
                    key={color}
                    className="mascot-tile"
                    data-moon={color}
                    aria-pressed={mascot?.color === color}
                    disabled={!mascot}
                    onClick={() => mascot && choose({ shape: mascot.shape, color })}
                  >
                    <span className="mascot-swatch" aria-hidden />
                    {MASCOT_COLOR_NAMES[color]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="set-empty">
        La mascotte se montre dans le fil pendant que l'agent travaille, avec la tête de ce qu'il
        fait vraiment : elle lit, code, réfléchit, lance les tests, sourit quand ils passent et
        s'inquiète d'une erreur. Touche-la pour un clin d'œil. Gardé sur le serveur, pour tous tes
        appareils.
      </p>
    </>
  );
}
