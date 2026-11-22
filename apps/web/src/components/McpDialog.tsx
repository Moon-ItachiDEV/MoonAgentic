import type { McpServerInfo } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { mcpServerInput } from "../mcp-input.ts";

function ServerRow({ server }: { server: McpServerInfo }) {
  return (
    <li className="mcp-row">
      <div className="mcp-tx">
        <b>{server.name}</b>
        <code title={server.target}>{server.target}</code>
        {server.secretNames.length > 0 && <small>Secrets : {server.secretNames.join(", ")}</small>}
      </div>
      <label className="switch" title={server.enabled ? "Activé" : "Désactivé"}>
        <input
          type="checkbox"
          checked={server.enabled}
          aria-label={`Activer ${server.name}`}
          onChange={(e) =>
            connection.send({ type: "mcp.setEnabled", id: server.id, enabled: e.target.checked })
          }
        />
        <span />
      </label>
      <button
        className="btn quiet sm"
        aria-label={`Retirer ${server.name}`}
        onClick={() => connection.send({ type: "mcp.remove", id: server.id })}
      >
        Retirer
      </button>
    </li>
  );
}

export function McpDialog({ servers, onClose }: { servers: McpServerInfo[]; onClose: () => void }) {
  const [adding, setAdding] = useState(servers.length === 0);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [secrets, setSecrets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const http = /^https?:\/\//i.test(target.trim());

  // Escape closes the dialog wherever the focus is, as in the other menus.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await connection.request({
        type: "mcp.add",
        requestId: crypto.randomUUID(),
        server: mcpServerInput(name.trim(), target, secrets),
      });
      setName("");
      setTarget("");
      setSecrets("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog mcp" role="dialog" aria-modal aria-labelledby="mcp-title">
        <h2 id="mcp-title">Serveurs MCP</h2>
        <p>
          Donnés à chaque agent au démarrage d'un fil. Les secrets restent sur la machine où tourne
          MoonAgentic et ne s'affichent jamais ici.
        </p>
        {servers.length > 0 && (
          <ul className="mcp-list">
            {servers.map((s) => (
              <ServerRow key={s.id} server={s} />
            ))}
          </ul>
        )}
        {adding ? (
          <form className="mcp-form" onSubmit={submit}>
            <label className="field">
              Nom
              <input
                autoFocus
                required
                placeholder="github"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              Commande ou adresse
              <input
                className="mono"
                required
                placeholder="npx -y @modelcontextprotocol/server-github"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <label className="field">
              {http ? "En-têtes secrets, un par ligne" : "Variables secrètes, une par ligne"}
              <textarea
                className="mono"
                rows={3}
                spellCheck={false}
                autoComplete="off"
                placeholder={http ? "Authorization: Bearer …" : "GITHUB_TOKEN=…"}
                value={secrets}
                onChange={(e) => setSecrets(e.target.value)}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              {servers.length > 0 && (
                <button type="button" className="btn quiet" onClick={() => setAdding(false)}>
                  Annuler
                </button>
              )}
              <button
                type="submit"
                className="btn pri"
                disabled={busy || !name.trim() || !target.trim()}
              >
                Ajouter
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            <button className="btn" onClick={() => setAdding(true)}>
              Ajouter un serveur
            </button>
            <button className="btn pri" onClick={onClose}>
              Fermer
            </button>
          </div>
        )}
        <p className="mcp-foot">
          Un changement vaut pour les fils démarrés ensuite. Un serveur par adresse ne va qu'aux
          agents qui savent le joindre.
        </p>
      </div>
    </div>
  );
}
