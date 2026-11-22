import type { AgentInfo, McpServerInfo } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { splitCommandLine } from "../mcp-input.ts";
import { agentStatus } from "../status.ts";
import { AgentBadge } from "./AgentBadge.tsx";

const when = (at: number) =>
  new Date(at).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function AgentRow(props: { agent: AgentInfo; checking: boolean; onCheck: () => void }) {
  const { agent, checking } = props;
  const [confirming, setConfirming] = useState(false);
  const status = agentStatus(agent);
  const check = agent.check;
  return (
    <li className="cx-row">
      <AgentBadge agent={agent} />
      <div className="cx-tx">
        <div className="cx-top">
          <b>{agent.name}</b>
          <span className={`st ${status.tone}`}>{checking ? "Vérification…" : status.label}</span>
        </div>
        {agent.command && <code title={agent.command}>{agent.command}</code>}
        {check?.version && <small>Version : {check.version}</small>}
        {!agent.available && agent.hint && <small>{agent.hint}</small>}
        {check && !check.ok && check.error && (
          <small className="cx-err">{check.error.split("\n")[0]}</small>
        )}
        {agent.login && (check?.signInNeeded || !check?.ok) && (
          <small>Pour te connecter : {agent.login}.</small>
        )}
        {check && <small>Vérifié le {when(check.at)}</small>}
      </div>
      <div className="cx-acts">
        {agent.available && (
          <button className="btn sm" disabled={checking} onClick={props.onCheck}>
            Vérifier
          </button>
        )}
        {agent.custom && (
          <button
            className={confirming ? "btn danger sm" : "btn quiet sm"}
            aria-label={
              confirming ? `Confirmer le retrait de ${agent.name}` : `Retirer ${agent.name}`
            }
            onBlur={() => setConfirming(false)}
            onClick={() =>
              confirming
                ? connection.send({ type: "agent.removeCustom", agentId: agent.id })
                : setConfirming(true)
            }
          >
            {confirming ? "Confirmer ?" : "Retirer"}
          </button>
        )}
      </div>
    </li>
  );
}

/** Every agent with its state, the agents the user added, and the MCP servers. */
export function ConnectionsDialog(props: {
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  const { agents, onClose } = props;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Agents being checked, with the time of their check before, until it changes. */
  const [checking, setChecking] = useState<Record<string, number | null | undefined>>({});

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  // A check is over once the agent's state carries another check.
  const isChecking = (agent: AgentInfo) =>
    checking[agent.id] !== undefined && checking[agent.id] === (agent.check?.at ?? null);
  const check = (agent: AgentInfo) => {
    setChecking((c) => ({ ...c, [agent.id]: agent.check?.at ?? null }));
    connection.send({ type: "agent.discover", agentId: agent.id });
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const [command, ...args] = splitCommandLine(line);
      if (!command) throw new Error("Indique la commande qui lance l'agent.");
      await connection.request({
        type: "agent.addCustom",
        requestId: newId(),
        agent: { name: name.trim(), command, args },
      });
      setName("");
      setLine("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enabledMcp = props.mcpServers.filter((s) => s.enabled).length;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog connections" role="dialog" aria-modal aria-labelledby="cx-title">
        <h2 id="cx-title">Connexions</h2>
        <p>
          Les agents passent par leur propre outil et ta propre connexion. MoonAgentic ne voit ni ne
          garde aucun mot de passe ni jeton.
        </p>
        <ul className="cx-list">
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} checking={isChecking(a)} onCheck={() => check(a)} />
          ))}
        </ul>
        {adding ? (
          <form className="mcp-form" onSubmit={add}>
            <label className="field">
              Nom
              <input
                autoFocus
                required
                placeholder="Mon agent"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              Commande qui le lance en mode ACP
              <input
                className="mono"
                required
                placeholder="mon-agent acp"
                value={line}
                onChange={(e) => setLine(e.target.value)}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button
                type="button"
                className="btn quiet"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Annuler
              </button>
              <button
                type="submit"
                className="btn pri"
                disabled={busy || !name.trim() || !line.trim()}
              >
                Ajouter
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            <button className="btn" onClick={() => setAdding(true)}>
              Ajouter un agent
            </button>
          </div>
        )}
        <h3>Serveurs MCP</h3>
        <div className="cx-mcp">
          <span>
            {props.mcpServers.length === 0
              ? "Aucun serveur MCP."
              : `${enabledMcp} actif${enabledMcp > 1 ? "s" : ""} sur ${props.mcpServers.length}, donnés à chaque agent au démarrage d'un fil.`}
          </span>
          <button className="btn sm" onClick={props.onOpenMcp}>
            Gérer
          </button>
        </div>
        <div className="row">
          <button className="btn pri" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
