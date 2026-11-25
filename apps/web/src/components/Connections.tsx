import type { AgentInfo, GithubStatus } from "@moonagentic/protocol";
import { useCallback, useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { githubStatusText } from "../github.ts";
import { splitCommandLine } from "../mcp-input.ts";
import { agentStatus } from "../status.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { GithubSignIn } from "./GithubSignIn.tsx";
import { GITHUB_APP_ACCESS } from "./NewProjectDialog.tsx";

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (at: number) =>
  new Date(at).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A value at the end of a line, cut with an ellipsis when it is long. */
const Value = ({ text, mono }: { text: string; mono?: boolean }) => (
  <span className="rt mcv">
    <span className={mono ? "mono" : undefined} title={text}>
      {text}
    </span>
  </span>
);

/** What a line of the list says about an agent: ready, to check, or missing. */
export function AgentState({ agent, checking }: { agent: AgentInfo; checking?: boolean }) {
  if (checking) {
    return (
      <span className="mst">
        <span className="t2-spin" />
        Vérification
      </span>
    );
  }
  const status = agentStatus(agent);
  if (status.tone === "ok") return <span className="dvon">{status.label}</span>;
  if (status.tone === "warn" || status.tone === "err") {
    return <span className="mer">{status.label}</span>;
  }
  return <span className="mof">{status.label}</span>;
}

/** Agents being checked, each with the time of its check before, until that time changes. */
export function useAgentChecks() {
  const [asked, setAsked] = useState<Record<string, number | null | undefined>>({});
  // A check is over once the agent's state carries another check.
  const checking = (agent: AgentInfo) =>
    asked[agent.id] !== undefined && asked[agent.id] === (agent.check?.at ?? null);
  const check = (agent: AgentInfo) => {
    if (!connection.send({ type: "agent.discover", agentId: agent.id })) {
      connection.notify("Pas de connexion au serveur MoonAgentic.");
      return;
    }
    setAsked((c) => ({ ...c, [agent.id]: agent.check?.at ?? null }));
  };
  return { checking, check };
}

/** One agent: how its last start went, the command behind it, and what can be done with it. */
export function AgentSheet(props: {
  agent: AgentInfo | undefined;
  checking: boolean;
  onCheck: () => void;
  onClose: () => void;
}) {
  const { agent } = props;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const check = agent?.check;
  const failed = check && !check.ok ? check.error?.split("\n")[0] : undefined;
  return (
    <>
      <Sheet open={!!agent} onClose={props.onClose} title={agent?.name ?? ""}>
        {agent && (
          <div className="sbody">
            {(failed || (!agent.available && agent.hint)) && (
              <div className="mcpe">
                <span className="erp" title={failed ?? agent.hint}>
                  <I n="warn" s={14} />
                  {failed ?? agent.hint}
                </span>
              </div>
            )}
            <div className="ins">
              <div className="it ro">
                <span className="tx">État</span>
                <span className="rt">
                  <AgentState agent={agent} checking={props.checking} />
                </span>
              </div>
              {agent.command && (
                <div className="it ro">
                  <span className="tx">Commande</span>
                  <Value text={agent.command} mono />
                </div>
              )}
              {check?.version && (
                <div className="it ro">
                  <span className="tx">Version</span>
                  <Value text={check.version} />
                </div>
              )}
              {agent.login && check && !check.ok && (
                <div className="it ro">
                  <span className="tx">Connexion</span>
                  <Value text={agent.login} mono />
                </div>
              )}
              {check && (
                <div className="it ro">
                  <span className="tx">Vérifié</span>
                  <span className="rt">{when(check.at)}</span>
                </div>
              )}
            </div>
            {(agent.available || agent.custom) && (
              <div className="ins">
                {agent.available && (
                  <button className="it acc" disabled={props.checking} onClick={props.onCheck}>
                    <span className="tx">Vérifier</span>
                  </button>
                )}
                {agent.custom && (
                  <button
                    className="it dng"
                    onClick={() =>
                      setConfirm({
                        title: `Retirer ${agent.name} ?`,
                        text: "Ses fils restent lisibles.",
                        action: "Retirer",
                        run: () => {
                          if (!connection.send({ type: "agent.removeCustom", agentId: agent.id })) {
                            throw new Error("Pas de connexion au serveur");
                          }
                          props.onClose();
                        },
                      })
                    }
                  >
                    <span className="tx">Retirer cet agent</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </Sheet>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

/** « Ajouter un agent »: any command that speaks ACP, under the name the user gives it. */
export function AgentAddSheet(props: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open) setError(null);
  }, [props.open]);

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
      props.onClose();
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Ajouter un agent">
      <form className="sbody" onSubmit={add}>
        <div className="ins">
          <label className="it ro npf">
            <input
              aria-label="Nom"
              placeholder="Nom"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="sep" />
          <label className="it ro npf">
            <input
              className="mono"
              aria-label="Commande qui le lance en mode ACP"
              placeholder="mon-agent acp"
              autoComplete="off"
              spellCheck={false}
              value={line}
              onChange={(e) => setLine(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="pcw t-err" role="alert">
            {error}
          </p>
        )}
        <div className="mga">
          <button
            type="submit"
            className="b2 ink press"
            disabled={busy || !name.trim() || !line.trim()}
          >
            Ajouter
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** GitHub on the machine running MoonAgentic, read anew each time it is asked for. */
export function useGithubStatus() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => {
    setChecking(true);
    setError(null);
    connection
      .ask({ type: "github.status", requestId: newId() })
      .then((reply) => setStatus(reply.status))
      .catch((e: unknown) => setError(why(e)))
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);
  return { status, checking, error, check };
}

/** GitHub: MoonAgentic's own sign-in, or the user's `git` and `gh`. */
export function GithubSheet(props: {
  open: boolean;
  github: ReturnType<typeof useGithubStatus>;
  onClose: () => void;
}) {
  const { status, checking, check } = props.github;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const text = status && githubStatusText(status);
  const own = status?.account === "moonagentic";
  const problem = props.github.error ?? (status && !status.login ? status.error : null);
  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title="GitHub">
        <div className="sbody">
          {problem && (
            <div className="mcpe">
              <span className="erp" title={problem}>
                <I n="warn" s={14} />
                {problem}
              </span>
            </div>
          )}
          <div className="ins">
            <div className="it ro">
              <span className="tx">Compte</span>
              <span className="rt">
                {checking ? (
                  <span className="mst">
                    <span className="t2-spin" />
                    Vérification
                  </span>
                ) : status?.login ? (
                  `@${status.login}`
                ) : (
                  (text?.label ?? "Non connecté")
                )}
              </span>
            </div>
            {status?.login && (
              <div className="it ro">
                <span className="tx">Connexion</span>
                <span className="rt">{own ? "MoonAgentic" : "gh"}</span>
              </div>
            )}
            {status && (
              <div className="it ro">
                <span className="tx">git</span>
                <span className="rt">{status.git ? "Installé" : "Introuvable"}</span>
              </div>
            )}
            {status && (
              <div className="it ro">
                <span className="tx">gh</span>
                <span className="rt">{status.gh ? "Installé" : "Absent"}</span>
              </div>
            )}
          </div>
          {status && !status.login && !status.canSignIn && status.git && (
            <div className="fvn">
              <span className="ppill mono">gh auth login</span>
            </div>
          )}
          {props.open && status && !own && status.canSignIn && <GithubSignIn onSignedIn={check} />}
          <div className="ins">
            <button className="it acc" disabled={checking} onClick={check}>
              <span className="tx">Vérifier</span>
            </button>
            {own && (
              <a className="it" href={GITHUB_APP_ACCESS} target="_blank" rel="noreferrer">
                <span className="tx">Accès des organisations</span>
                <I n="ext" s={15} />
              </a>
            )}
            {own && (
              <button
                className="it dng"
                disabled={checking}
                onClick={() =>
                  setConfirm({
                    title: "Se déconnecter de GitHub ?",
                    text: "Oublie la connexion sur cette machine.",
                    action: "Se déconnecter",
                    run: async () => {
                      await connection.ask({ type: "github.logout", requestId: newId() });
                      check();
                    },
                  })
                }
              >
                <span className="tx">Se déconnecter</span>
              </button>
            )}
          </div>
        </div>
      </Sheet>
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}
