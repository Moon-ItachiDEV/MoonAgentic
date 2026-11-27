import type { AgentInfo, McpServerInfo, McpTool, Project } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
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
  // Every project but some: those are ticked, so that one more is left out or let back in.
  const picked = new Set(
    scope.projectIds ??
      (scope.exceptProjectIds?.length
        ? projects.map((p) => p.id).filter((id) => !scope.exceptProjectIds?.includes(id))
        : []),
  );
  const { exceptProjectIds: _except, ...listed } = scope;
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
              aria-pressed={scope.projectIds === null && !scope.exceptProjectIds?.length}
              onClick={() => onChange({ ...listed, projectIds: null })}
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
                    ...listed,
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

/**
 * Which agents get a server, one switch each: `null` for every agent, the list once the user
 * leaves one out. An agent added later gets the servers that are for every agent.
 */
function AgentRows({
  agentIds,
  agents,
  onChange,
}: {
  agentIds: string[] | null;
  agents: AgentInfo[];
  onChange: (agentIds: string[] | null) => void;
}) {
  if (!agents.length) return null;
  const on = (id: string) => !agentIds || agentIds.includes(id);
  return (
    <>
      <div className="gl2">Agents</div>
      <div className="ins">
        {agents.map((a) => (
          <div key={a.id} className="it ro">
            <span className="tx">{a.name}</span>
            <button
              type="button"
              className="tog"
              role="switch"
              aria-checked={on(a.id)}
              aria-label={`Donner à ${a.name}`}
              onClick={() => {
                const next = agents
                  .map((o) => o.id)
                  .filter((id) => (id === a.id ? !on(id) : on(id)));
                onChange(next.length === agents.length ? null : next);
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

/** « Outils »: the server is started once to list them, on the first tap. */
function ToolRows({ server }: { server: McpServerInfo }) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpTool[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Each reading counts: one that answers after the server changed is not shown for it.
  const asked = useRef(0);
  useEffect(() => {
    asked.current += 1;
    setOpen(false);
    setTools(undefined);
    setError(undefined);
    setBusy(false);
  }, [server.id, server.target]);
  const load = () => {
    const mine = ++asked.current;
    const still = () => mine === asked.current;
    setBusy(true);
    setError(undefined);
    connection
      .ask({ type: "mcp.tools", requestId: newId(), id: server.id })
      .then((reply) => still() && setTools(reply.tools))
      .catch((e: unknown) => still() && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => still() && setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className="it"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !tools && !busy) load();
        }}
      >
        <span className="tx">Outils</span>
        <span className="rt">
          {busy ? (
            <span className="mst">
              <span className="t2-spin" />
              Lecture
            </span>
          ) : error ? (
            <span className="mer">Erreur</span>
          ) : (
            (tools?.length ?? "")
          )}
          <I n={open ? "down" : "right"} s={15} />
        </span>
      </button>
      {open && error && (
        <div className="it ro">
          <span className="tx">
            <small className="erx">{error}</small>
          </span>
          <button type="button" className="b2 soft press" onClick={load} disabled={busy}>
            Réessayer
          </button>
        </div>
      )}
      {open && tools && (
        <div className="chips wrap mtl" aria-label={`Outils de ${server.name}`}>
          {tools.length ? (
            tools.map((t) => (
              <span key={t.name} className="ppill mono" title={t.description}>
                {t.name}
              </span>
            ))
          ) : (
            <span className="ppill">Aucun outil</span>
          )}
        </div>
      )}
    </>
  );
}

/** One MCP server: on or off, what starts it, who gets it, and the way to remove it. */
export function McpServerSheet(props: {
  server: McpServerInfo | undefined;
  projects: Project[];
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const { server } = props;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // What was just asked for shows at once, until the server says what it kept.
  const [asked, setAsked] = useState<McpScope>();
  const [askedAgents, setAskedAgents] = useState<string[] | null>();
  useEffect(() => {
    setAsked(undefined);
    setAskedAgents(undefined);
  }, [server]);
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
              {server.enabled && <ToolRows server={server} />}
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
            <AgentRows
              agents={props.agents}
              agentIds={askedAgents !== undefined ? askedAgents : (server.agentIds ?? null)}
              onChange={(agentIds) => {
                if (connection.send({ type: "mcp.setAgents", id: server.id, agentIds })) {
                  setAskedAgents(agentIds);
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
export function McpAddSheet(props: {
  open: boolean;
  projects: Project[];
  agents: AgentInfo[];
  onClose: () => void;
}) {
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
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
          ...(agentIds ? { agentIds } : {}),
        },
      });
      setAgentIds(null);
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
        <AgentRows agents={props.agents} agentIds={agentIds} onChange={setAgentIds} />
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
