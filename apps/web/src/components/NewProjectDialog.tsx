import type { GithubRepo, GithubStatus } from "@moonagentic/protocol";
import { useEffect, useMemo, useState } from "react";
import { connection, newId } from "../connection.ts";
import { filterRepos, githubStatusText, parentFolder, repoFolderName } from "../github.ts";

type Source = "local" | "github";

/** The repositories of the signed-in `gh`, once asked; null while unknown. */
function useGithub(active: boolean) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || status) return;
    let live = true;
    connection
      .ask({ type: "github.status", requestId: newId() })
      .then(async (reply) => {
        if (!live) return;
        setStatus(reply.status);
        if (!reply.status.login) return;
        const list = await connection.ask({ type: "github.repos", requestId: newId() });
        if (live) setRepos(list.repos);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [active, status]);
  /** Asks again, after the user signed in to `gh` with the dialog open. */
  const recheck = () => {
    setError(null);
    setRepos(null);
    setStatus(null);
  };
  return { status, repos, error, recheck };
}

export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [source, setSource] = useState<Source>("local");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [repo, setRepo] = useState("");
  // Next to the last project added, so a clone takes two clicks.
  const [parent, setParent] = useState(() => {
    const last = [...connection.getState().projects].sort((a, b) => b.createdAt - a.createdAt)[0];
    return (last && parentFolder(last.path)) || "~/code";
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const github = useGithub(source === "github");

  const derivedName =
    name.trim() ||
    (source === "local"
      ? path.trim().split(/[\\/]/).filter(Boolean).pop() || ""
      : repoFolderName(repo));
  const shown = useMemo(
    () => filterRepos(github.repos ?? [], repo).slice(0, 50),
    [github.repos, repo],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id =
        source === "local"
          ? await connection.request({
              type: "project.create",
              requestId: newId(),
              name: derivedName,
              path: path.trim(),
            })
          : await connection.request({
              type: "project.clone",
              requestId: newId(),
              repo: repo.trim(),
              parent: parent.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
            });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const ready =
    source === "local"
      ? !!path.trim() && !!derivedName
      : !!repo.trim() && !!parent.trim() && !!derivedName;
  const status = github.status && githubStatusText(github.status);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog new-project"
        role="dialog"
        aria-modal
        aria-labelledby="np-title"
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
      >
        <h2 id="np-title">Nouveau projet</h2>
        <div className="np-src" role="radiogroup" aria-label="Source du projet">
          {(
            [
              ["local", "Dossier sur la machine"],
              ["github", "Cloner depuis GitHub"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              disabled={busy}
              onClick={() => {
                setSource(value);
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {source === "local" ? (
          <>
            <p>Un dossier de code sur la machine où tourne MoonAgentic.</p>
            <label className="field">
              Dossier
              <input
                className="mono"
                autoFocus
                required
                placeholder="~/code/mon-projet"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <p>
              Cloné avec ton propre git et ton gh, sur la machine où tourne MoonAgentic. Aucun jeton
              n'est gardé ici.
            </p>
            {status && !github.status?.login && (
              <p className={`np-gh ${status.tone}`}>
                <span>
                  <b>{status.label}.</b> {status.detail} Un dépôt public se clone quand même.
                </span>
                <button type="button" className="btn sm" disabled={busy} onClick={github.recheck}>
                  Vérifier
                </button>
              </p>
            )}
            <label className="field">
              Dépôt
              <input
                className="mono"
                autoFocus
                required
                placeholder="propriétaire/dépôt ou https://github.com/…"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                disabled={busy}
              />
            </label>
            {github.status?.login && !github.error && (
              <ul className="np-repos" aria-label="Tes dépôts GitHub">
                {github.repos === null && <li className="np-empty">Chargement de tes dépôts…</li>}
                {github.repos !== null && shown.length === 0 && (
                  <li className="np-empty">Aucun de tes dépôts ne correspond.</li>
                )}
                {shown.map((r) => (
                  <li key={r.fullName}>
                    <button
                      type="button"
                      aria-pressed={repo === r.fullName}
                      disabled={busy}
                      onClick={() => setRepo(r.fullName)}
                    >
                      <span className="np-name">{r.fullName}</span>
                      {r.private && <span className="np-tag">privé</span>}
                      {r.description && <small>{r.description}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {github.error && <p className="error">{github.error}</p>}
            <label className="field">
              Cloner dans
              <input
                className="mono"
                required
                placeholder="~/code"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                disabled={busy}
              />
            </label>
          </>
        )}
        <label className="field">
          Nom
          <input
            placeholder={derivedName || "mon-projet"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn pri" disabled={busy || !ready}>
            {source === "local" ? "Créer" : busy ? "Clonage…" : "Cloner"}
          </button>
        </div>
      </form>
    </div>
  );
}
