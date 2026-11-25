import {
  type AgentInfo,
  MASCOT_COLORS,
  MASCOT_SHAPES,
  type Mascot as MascotChoice,
} from "@moonagentic/protocol";
import { useState } from "react";
import { connection } from "../connection.ts";
import { MASCOT_COLOR_NAMES, MASCOT_SHAPE_NAMES } from "../mascot.ts";
import { defineMoonMascot } from "../moon-mascot.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";

defineMoonMascot();

/**
 * Settings › Mascottes: each agent's moon, its shape and colour, kept by the server for every
 * device. The moon rests here: its other faces only show what an agent really does.
 */
export function MascotSettings({ agents: all }: { agents: AgentInfo[] }) {
  // Only Hermes and the user's Hermes bots have a moon.
  const agents = all.filter((a) => a.mascotAllowed);
  const [picked, setPicked] = useState<string>();
  const agent = agents.find((a) => a.id === picked);
  const mascot = agent?.mascot;
  if (!agents.length) return <p className="snone">Réservé à Hermes</p>;

  const choose = (next: MascotChoice | null) =>
    agent && connection.send({ type: "agent.setMascot", agentId: agent.id, mascot: next });

  return (
    <>
      <div className="gl2">Agents</div>
      <div className="ins">
        {agents.map((a) => (
          <button key={a.id} className="it mjr" onClick={() => setPicked(a.id)}>
            {a.mascot && (
              <span className="mjm" data-moon={a.mascot.color}>
                <moon-mascot shape={a.mascot.shape} color={a.mascot.color} expression="idle" />
              </span>
            )}
            <span className="tx">{a.name}</span>
            <span className="rt">
              {a.mascot ? MASCOT_SHAPE_NAMES[a.mascot.shape] : "Aucune"}
              <I n="right" s={15} />
            </span>
          </button>
        ))}
      </div>
      <Sheet open={!!agent} onClose={() => setPicked(undefined)} title={agent?.name ?? ""}>
        <div className="sbody">
          {mascot && agent && (
            <div className="mprev" data-moon={mascot.color}>
              <moon-mascot
                shape={mascot.shape}
                color={mascot.color}
                expression="idle"
                label={`Faire un clin d’œil à ${agent.name}`}
              />
            </div>
          )}
          <div className="gl2">Forme</div>
          <div className="ins">
            <div className="msh" role="group" aria-label="Forme">
              <button aria-pressed={!mascot} onClick={() => choose(null)}>
                <span>
                  <I n="x" s={18} />
                </span>
                Aucune
              </button>
              {MASCOT_SHAPES.map((shape) => (
                <button
                  key={shape}
                  aria-pressed={mascot?.shape === shape}
                  onClick={() => choose({ shape, color: mascot?.color ?? "ice" })}
                >
                  <span data-moon={mascot?.color ?? "ice"}>
                    <moon-mascot shape={shape} color={mascot?.color ?? "ice"} expression="idle" />
                  </span>
                  {MASCOT_SHAPE_NAMES[shape]}
                </button>
              ))}
            </div>
          </div>
          <div className="gl2">Teinte</div>
          <div className="ins">
            <div className="mtw" role="group" aria-label="Couleur">
              {MASCOT_COLORS.map((color) => (
                <button
                  key={color}
                  data-moon={color}
                  aria-pressed={mascot?.color === color}
                  disabled={!mascot}
                  onClick={() => mascot && choose({ shape: mascot.shape, color })}
                >
                  <i />
                  <span>{MASCOT_COLOR_NAMES[color]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Sheet>
    </>
  );
}
