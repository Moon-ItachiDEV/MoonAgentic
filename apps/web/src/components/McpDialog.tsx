import type { McpServerInfo, Project } from "@moonagentic/protocol";
import { useEffect, useId, useState } from "react";
import { connection, newId } from "../connection.ts";
import { mcpServerInput } from "../mcp-input.ts";
import { type McpScope, mcpScopeLabel, scopeOf } from "../mcp-scope.ts";
import { IconChevron } from "./icons.tsx";

/** Who gets a server: every project or some of them, and a team's every role or not. */
function ScopeFields({
  scope,
  projects,
  onChange,
}: {
  scope: McpScope;
  projects: Project[];
  onChange: (scope: McpScope) => void;
}) {
  const group = useId();
  const some = scope.projectIds !== null;
  const picked = new Set(scope.projectIds ?? []);
  return (
    <div className="mcp-scope">
      <fieldset>
        <legend>Projets</legend>
        <label>
          <input
            type="radio"
            name={group}
            checked={!some}
            onChange={() => onChange({ ...scope, projectIds: null })}
          />
          Tous les projets
        </label>
        <label>
          <input
            type="radio"
            name={group}
            checked={some}
            disabled={projects.length === 0}
            onChange={() => onChange({ ...scope, projectIds: [] })}
          />
          Seulement certains
        </label>
        {some && (
          <div className="mcp-projects">
            {projects.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={(e) =>
                    onChange({
                      ...scope,
                      projectIds: projects
                        .map((o) => o.id)
                        .filter((id) => (id === p.id ? e.target.checked : picked.has(id))),
                    })
                  }
                />
                {p.name}
              </label>
            ))}
            {picked.size === 0 && (
              <small>Coche au moins un projet : sinon aucun agent ne le reçoit.</small>
            )}
          </div>
        )}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={scope.allRoles}
          onChange={(e) => onChange({ ...scope, allRoles: e.target.checked })}
        />
        Aussi pour les relecteurs, testeurs et fusionneurs d'une équipe
      </label>
    </div>
  );
}

function ServerRow({ server, projects }: { server: McpServerInfo; projects: Project[] }) {
  // Removing drops secrets nobody can read back, so it takes a second, deliberate press.
  const [confirming, setConfirming] = useState(false);
  const [scoping, setScoping] = useState(false);
  // What was just asked for shows at once, until the server says what it kept.
  const [asked, setAsked] = useState<McpScope>();
  useEffect(() => setAsked(undefined), [server]);
  const scope = asked ?? scopeOf(server);
  return (
    <li className="mcp-row">
      <div className="mcp-tx">
        <b>{server.name}</b>
        <code title={server.target}>{server.target}</code>
        {server.secretNames.length > 0 && <small>Secrets : {server.secretNames.join(", ")}</small>}
        <button
          className={`mcp-for${scoping ? " open" : ""}`}
          aria-expanded={scoping}
          aria-label={`Pour qui est ${server.name} : ${mcpScopeLabel(scope, projects)}`}
          onClick={() => setScoping((open) => !open)}
        >
          Pour : {mcpScopeLabel(scope, projects)}
          <IconChevron />
        </button>
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
        className={confirming ? "btn danger sm" : "btn quiet sm"}
        aria-label={
          confirming ? `Confirmer le retrait de ${server.name}` : `Retirer ${server.name}`
        }
        onBlur={() => setConfirming(false)}
        onClick={() =>
          confirming ? connection.send({ type: "mcp.remove", id: server.id }) : setConfirming(true)
        }
      >
        {confirming ? "Confirmer ?" : "Retirer"}
      </button>
      {scoping && (
        <ScopeFields
          scope={scope}
          projects={projects}
          onChange={(next) => {
            if (connection.send({ type: "mcp.setScope", id: server.id, ...next })) setAsked(next);
          }}
        />
      )}
    </li>
  );
}

export function McpDialog({
  servers,
  projects,
  secretsError,
  onClose,
}: {
  servers: McpServerInfo[];
  projects: Project[];
  secretsError?: string | null;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(servers.length === 0);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [secrets, setSecrets] = useState("");
  const [scope, setScope] = useState<McpScope>({ projectIds: null, allRoles: false });
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
        requestId: newId(),
        server: {
          ...mcpServerInput(name.trim(), target, secrets),
          ...(scope.projectIds ? { projectIds: scope.projectIds } : {}),
          ...(scope.allRoles ? { allRoles: true } : {}),
        },
      });
      setName("");
      setTarget("");
      setSecrets("");
      setScope({ projectIds: null, allRoles: false });
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
          Donnés aux agents au démarrage d'un fil, pour tous les projets ou ceux que tu choisis.
          Dans une équipe, les relecteurs, testeurs et fusionneurs ne les reçoivent que si tu le
          demandes. Les secrets restent sur la machine où tourne MoonAgentic et ne s'affichent
          jamais ici.
        </p>
        {secretsError && <p className="error">{secretsError}</p>}
        {servers.length > 0 && (
          <ul className="mcp-list">
            {servers.map((s) => (
              <ServerRow key={s.id} server={s} projects={projects} />
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
            <ScopeFields scope={scope} projects={projects} onChange={setScope} />
            {error && <p className="error">{error}</p>}
            <div className="row">
              {servers.length > 0 && (
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
