import type { AgentInfo, GithubStatus, McpServerInfo } from "@moonagentic/protocol";
import { useCallback, useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { githubStatusText } from "../github.ts";
import { GithubMark, GithubSignIn } from "./GithubSignIn.tsx";
import { GITHUB_APP_ACCESS } from "./NewProjectDialog.tsx";
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
        {agent.login && check && !check.ok && <small>Pour te connecter : {agent.login}.</small>}
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

/** GitHub on the machine running MoonAgentic: its own sign-in, or the user's `git` and `gh`. */
function GithubRow() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const check = useCallback(() => {
    setChecking(true);
    setError(null);
    setConfirming(false);
    connection
      .ask({ type: "github.status", requestId: newId() })
      .then((reply) => setStatus(reply.status))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);
  const logout = () => {
    connection
      .ask({ type: "github.logout", requestId: newId() })
      .then(check, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const text = status && githubStatusText(status);
  const own = status?.account === "moonagentic";
  return (
    <li className="cx-row">
      <span className="ag gh" aria-hidden>
        <GithubMark size={15} />
      </span>
      <div className="cx-tx">
        <div className="cx-top">
          <b>GitHub</b>
          <span className={`st ${text?.tone ?? ""}`}>
            {checking ? "Vérification…" : (text?.label ?? "Inconnu")}
          </span>
        </div>
        {text && <small>{text.detail}</small>}
        {own && (
          <small>
            Se déconnecter oublie la connexion sur cette machine. Pour la retirer aussi chez GitHub
            :{" "}
            <a href={GITHUB_APP_ACCESS} target="_blank" rel="noreferrer">
              réglages GitHub
            </a>
            .
          </small>
        )}
        {status?.error && !status.login && <small className="cx-err">{status.error}</small>}
        {error && <small className="cx-err">{error}</small>}
        {signingIn && (
          <GithubSignIn
            onSignedIn={() => {
              setSigningIn(false);
              check();
            }}
          />
        )}
      </div>
      <div className="cx-acts">
        {status && !own && status.canSignIn && !signingIn && (
          <button className="btn sm pri" disabled={checking} onClick={() => setSigningIn(true)}>
            Se connecter
          </button>
        )}
        {own && (
          <button
            className={`btn sm ${confirming ? "danger" : ""}`}
            disabled={checking}
            onClick={() => (confirming ? logout() : setConfirming(true))}
          >
            {confirming ? "Confirmer ?" : "Se déconnecter"}
          </button>
        )}
        <button className="btn sm" disabled={checking} onClick={check}>
          Vérifier
        </button>
      </div>
    </li>
  );
}

/** Every agent with its state, the agents the user added, and the MCP servers. */
export function ConnectionsDialog(props: {
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  mcpSecretsError?: string | null;
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
    if (!connection.send({ type: "agent.discover", agentId: agent.id })) {
      connection.notify("Pas de connexion au serveur MoonAgentic.");
      return;
    }
    setChecking((c) => ({ ...c, [agent.id]: agent.check?.at ?? null }));
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
          Les agents et GitHub passent par leur propre outil et ta propre connexion. MoonAgentic ne
          voit ni ne garde aucun mot de passe ni jeton.
        </p>
        <ul className="cx-list">
          <GithubRow />
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
        {props.mcpSecretsError && <p className="error">{props.mcpSecretsError}</p>}
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
