import type { McpServerInfo, Project } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { mcpServerInput } from "../mcp-input.ts";
import { type McpScope, mcpScopeLabel, scopeOf } from "../mcp-scope.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";

/** Who gets a server: every project or some of them, and a team's every role or not. */
function ScopeRows({
  scope,
  projects,
  onChange,
}: {
  scope: McpScope;
  projects: Project[];
  onChange: (scope: McpScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = new Set(scope.projectIds ?? []);
  return (
    <>
      <div className="ins">
        <button
          type="button"
          className="it"
          aria-expanded={open}
          aria-label={`Projets : ${mcpScopeLabel({ ...scope, allRoles: false }, projects)}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tx">Projets</span>
          <span className="rt">
            {mcpScopeLabel({ ...scope, allRoles: false }, projects)}
            <I n={open ? "down" : "right"} s={15} />
          </span>
        </button>
        {open && (
          <>
            <button
              type="button"
              className="it fva"
              aria-pressed={scope.projectIds === null}
              onClick={() => onChange({ ...scope, projectIds: null })}
            >
              <span className="tx">Tous les projets</span>
              <span className="fvc">
                <I n="check" s={14} />
              </span>
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="it fva"
                aria-pressed={picked.has(p.id)}
                onClick={() =>
                  onChange({
                    ...scope,
                    projectIds: projects
                      .map((o) => o.id)
                      .filter((id) => (id === p.id ? !picked.has(id) : picked.has(id))),
                  })
                }
              >
                <span className="tx">{p.name}</span>
                <span className="fvc">
                  <I n="check" s={14} />
                </span>
              </button>
            ))}
          </>
        )}
        <div className="it ro">
          <span className="tx">
            Toute l'équipe
            <small>Relecteurs, testeurs, fusionneurs</small>
          </span>
          <button
            type="button"
            className="tog"
            role="switch"
            aria-checked={scope.allRoles}
            aria-label="Aussi pour les relecteurs, testeurs et fusionneurs d'une équipe"
            onClick={() => onChange({ ...scope, allRoles: !scope.allRoles })}
          />
        </div>
      </div>
    </>
  );
}

/** One MCP server: on or off, what starts it, who gets it, and the way to remove it. */
export function McpServerSheet(props: {
  server: McpServerInfo | undefined;
  projects: Project[];
  onClose: () => void;
}) {
  const { server } = props;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // What was just asked for shows at once, until the server says what it kept.
  const [asked, setAsked] = useState<McpScope>();
  useEffect(() => setAsked(undefined), [server]);
  return (
    <>
      <Sheet open={!!server} onClose={props.onClose} title={server?.name ?? ""}>
        {server && (
          <div className="sbody">
            <div className="ins">
              <div className="it ro">
                <span className="tx">Actif</span>
                <button
                  className="tog"
                  role="switch"
                  aria-checked={server.enabled}
                  aria-label={`Activer ${server.name}`}
                  onClick={() =>
                    connection.send({
                      type: "mcp.setEnabled",
                      id: server.id,
                      enabled: !server.enabled,
                    })
                  }
                />
              </div>
              <div className="it ro">
                <span className="tx">{server.transport === "http" ? "Adresse" : "Commande"}</span>
                <span className="rt mcv">
                  <span className="mono" title={server.target}>
                    {server.target}
                  </span>
                </span>
              </div>
              {server.secretNames.length > 0 && (
                <div className="it ro">
                  <span className="tx">Secrets</span>
                  <span className="rt mcv">
                    <span className="mono" title={server.secretNames.join(", ")}>
                      {server.secretNames.join(", ")}
                    </span>
                  </span>
                </div>
              )}
            </div>
            <ScopeRows
              scope={asked ?? scopeOf(server)}
              projects={props.projects}
              onChange={(next) => {
                if (connection.send({ type: "mcp.setScope", id: server.id, ...next })) {
                  setAsked(next);
                }
              }}
            />
            <div className="ins">
              <button
                className="it dng"
                onClick={() =>
                  setConfirm({
                    title: `Retirer ${server.name} ?`,
                    text: server.secretNames.length ? "Ses secrets sont effacés." : "",
                    action: "Retirer",
                    run: () => {
                      if (!connection.send({ type: "mcp.remove", id: server.id })) {
                        throw new Error("Pas de connexion au serveur");
                      }
                      props.onClose();
                    },
                  })
                }
              >
                <span className="tx">Retirer ce serveur</span>
              </button>
            </div>
          </div>
        )}
      </Sheet>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

/** « Ajouter un serveur »: a command or an address, its secrets, and who gets it. */
export function McpAddSheet(props: { open: boolean; projects: Project[]; onClose: () => void }) {
  const [kind, setKind] = useState<"cmd" | "url">("cmd");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [secrets, setSecrets] = useState("");
  const [scope, setScope] = useState<McpScope>({ projectIds: null, allRoles: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An address typed under « Commande » is an address all the same.
  const http = kind === "url" || /^https?:\/\//i.test(target.trim());
  useEffect(() => {
    if (props.open) setError(null);
  }, [props.open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (http && !/^https?:\/\//i.test(target.trim())) {
        throw new Error("Cette adresse n'est pas valide.");
      }
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
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Ajouter un serveur">
      <form className="sbody" onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Type de serveur">
          <button
            type="button"
            role="radio"
            aria-checked={!http}
            aria-pressed={!http}
            onClick={() => setKind("cmd")}
          >
            <I n="code" s={16} />
            Commande
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={http}
            aria-pressed={http}
            onClick={() => setKind("url")}
          >
            <I n="wifi" s={16} />
            URL
          </button>
        </div>
        <div className="ins">
          <label className="it ro npf">
            <input
              aria-label="Nom"
              placeholder="Nom"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="sep" />
          <label className="it ro npf">
            <input
              className="mono"
              aria-label={http ? "Adresse" : "Commande"}
              placeholder={http ? "https://…/mcp" : "npx -y @modelcontextprotocol/server-github"}
              autoComplete="off"
              spellCheck={false}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
        </div>
        <div className="gl2">Secrets</div>
        <textarea
          className="rni mono mcps"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          aria-label={http ? "En-têtes secrets, un par ligne" : "Variables secrètes, une par ligne"}
          placeholder={http ? "Authorization: Bearer …" : "GITHUB_TOKEN=…"}
          value={secrets}
          onChange={(e) => setSecrets(e.target.value)}
        />
        <ScopeRows scope={scope} projects={props.projects} onChange={setScope} />
        {error && (
          <p className="pcw t-err" role="alert">
            {error}
          </p>
        )}
        <div className="mga">
          <button
            type="submit"
            className="b2 ink press"
            disabled={busy || !name.trim() || !target.trim()}
          >
            Ajouter
          </button>
        </div>
      </form>
    </Sheet>
  );
}
