import type { GithubRepo, GithubStatus, LocalClone } from "@moonagentic/protocol";
import { useEffect, useMemo, useState } from "react";
import { connection, newId } from "../connection.ts";
import {
  canClone,
  filterRepos,
  githubOwner,
  joinPath,
  localFor,
  repoFolderName,
  repoFullName,
} from "../github.ts";
import { GithubMark, GithubSignIn } from "./GithubSignIn.tsx";
import { IconCheck } from "./icons.tsx";

type Source = "github" | "local";

/** Where the user lets MoonAgentic's GitHub app into an organisation, or revokes it. */
export const GITHUB_APP_ACCESS =
  "https://github.com/settings/connections/applications/Ov23liWxSjhPeMftaNXC";

/** The signed-in account and its repositories, once asked; null while unknown. */
function useGithub() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to ask again, after a sign-in. */
  const [check, setCheck] = useState(0);
  useEffect(() => {
    // The status and the list arrive in the same run, so nothing this run sets may be one of its
    // dependencies: a change would cancel the run before the list is in, leaving it loading.
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
  }, [check]);
  const recheck = () => {
    setError(null);
    setRepos(null);
    setStatus(null);
    setCheck((n) => n + 1);
  };
  return { status, repos, error, recheck };
}

/** Where projects go by default, and the git folders already on the machine. */
function useLocalClones() {
  const [found, setFound] = useState<{ parent: string; clones: LocalClone[] } | null>(null);
  useEffect(() => {
    let live = true;
    connection
      .ask({ type: "local.clones", requestId: newId() }, 60_000)
      .then((reply) => live && setFound({ parent: reply.parent, clones: reply.clones }))
      .catch(() => live && setFound({ parent: "~/Projets", clones: [] }));
    return () => {
      live = false;
    };
  }, []);
  return found;
}

export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [source, setSource] = useState<Source>("github");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  /** The parent folder typed by the user; the server's default until then. */
  const [parentTyped, setParentTyped] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const github = useGithub();
  const local = useLocalClones();
  const clones = local?.clones ?? [];
  const parent = parentTyped ?? local?.parent ?? "";

  const signedIn = !!github.status?.login;
  // A repository: the one picked in the list, or one whose address was pasted.
  const repo = picked ?? (repoFullName(query) ? query.trim() : "");
  const fullName = repo ? repoFullName(repo) : undefined;
  const already = fullName ? localFor(fullName, clones) : undefined;
  const owner = githubOwner(query);
  const shown = useMemo(
    () => (picked ? [] : filterRepos(github.repos ?? [], query).slice(0, 60)),
    [github.repos, query, picked],
  );
  const folderName = name.trim() || repoFolderName(repo);
  const freeFolders = clones.filter((c) => !c.projectId);
  const localName = name.trim() || folder.trim().split(/[\\/]/).filter(Boolean).pop() || "";

  const run = async (make: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await make());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const addFolder = (path: string, projectName: string) =>
    run(() =>
      connection.request({
        type: "project.create",
        requestId: newId(),
        name: projectName,
        path,
      }),
    );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (source === "local") {
      if (folder.trim() && localName) void addFolder(folder.trim(), localName);
      return;
    }
    if (already?.projectId) {
      onCreated(already.projectId);
      return;
    }
    if (already) {
      void addFolder(already.path, name.trim() || already.name);
      return;
    }
    if (!canClone(repo, parent, name)) return;
    void run(() =>
      connection.request({
        type: "project.clone",
        requestId: newId(),
        repo: repo.trim(),
        parent: parent.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    );
  };

  const ready =
    source === "local" ? !!folder.trim() && !!localName : !!already || canClone(repo, parent, name);
  const action =
    source === "local"
      ? "Ajouter le projet"
      : already?.projectId
        ? "Ouvrir le projet"
        : already
          ? "Utiliser ce clone"
          : busy
            ? "Clonage…"
            : "Cloner";

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
              ["github", "Depuis GitHub"],
              ["local", "Dossier sur la machine"],
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
                setName("");
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {source === "github" && github.status === null && !github.error && (
          <p className="np-empty">Vérification de GitHub…</p>
        )}

        {source === "github" && github.status && !signedIn && (
          <div className="gh-card">
            <span className="gh-logo" aria-hidden>
              <GithubMark size={22} />
            </span>
            <b>Connecte ton compte GitHub</b>
            <p>
              Une seule fois. Tu choisis ensuite ton dépôt dans la liste et MoonAgentic le clone
              pour toi.
            </p>
            {github.status.canSignIn ? (
              <GithubSignIn onSignedIn={github.recheck} />
            ) : (
              <p className="np-hint">
                Lance <code>gh auth login</code> dans un terminal sur cette machine.
              </p>
            )}
          </div>
        )}

        {source === "github" && (signedIn || github.status) && (
          <>
            {picked ? (
              <div className="np-picked">
                <GithubMark size={15} />
                <span className="np-name">{picked}</span>
                <button
                  type="button"
                  className="btn quiet sm"
                  aria-label="Changer de dépôt"
                  disabled={busy}
                  onClick={() => {
                    setPicked(null);
                    setName("");
                  }}
                >
                  Changer
                </button>
              </div>
            ) : (
              <label className="field">
                {signedIn ? `Dépôts de @${github.status?.login}` : "Ou l'adresse d'un dépôt public"}
                <input
                  className="mono"
                  aria-label="Dépôt"
                  autoFocus={signedIn}
                  placeholder={
                    signedIn ? "Rechercher, ou coller une adresse…" : "https://github.com/…/…"
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {owner && !picked && (
              <p className="np-hint">
                C'est l'adresse du compte @{owner}, pas celle d'un dépôt.{" "}
                {signedIn
                  ? "Choisis un de ses dépôts dans la liste."
                  : `Ajoute le nom du dépôt : github.com/${owner}/nom-du-dépôt.`}
              </p>
            )}
            {signedIn && !picked && !github.error && (
              <ul className="np-repos" aria-label="Tes dépôts GitHub">
                {github.repos === null && <li className="np-empty">Chargement de tes dépôts…</li>}
                {github.repos !== null && shown.length === 0 && !repoFullName(query) && (
                  <li className="np-empty">
                    {owner
                      ? `Aucun de tes dépôts n'appartient à @${owner}.`
                      : "Aucun de tes dépôts ne correspond."}
                  </li>
                )}
                {shown.map((r) => {
                  const here = localFor(r.fullName, clones);
                  return (
                    <li key={r.fullName}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setPicked(r.fullName);
                          setName("");
                          setError(null);
                        }}
                      >
                        <span className="np-name">{r.fullName}</span>
                        <span className="np-tags">
                          {r.private && <span className="np-tag">privé</span>}
                          {here && (
                            <span className="np-tag here">
                              {here.projectId ? "déjà un projet" : "déjà cloné"}
                            </span>
                          )}
                        </span>
                        {r.description && <small>{r.description}</small>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {signedIn && github.status?.account === "moonagentic" && !picked && (
              <p className="np-hint">
                Un dépôt d'organisation manque ?{" "}
                <a href={GITHUB_APP_ACCESS} target="_blank" rel="noreferrer">
                  Autorise MoonAgentic pour cette organisation
                </a>
                .
              </p>
            )}
            {github.error && <p className="error">{github.error}</p>}

            {fullName && already && (
              <div className="np-done" role="status">
                <IconCheck size={16} />
                <b>
                  {already.projectId
                    ? "Déjà un projet de MoonAgentic"
                    : "Déjà cloné sur cette machine"}
                </b>
                <span className="mono">{already.path}</span>
              </div>
            )}
            {fullName && !already && !editing && (
              <p className="np-where">
                Sera cloné dans{" "}
                <span className="mono">{parent ? joinPath(parent, folderName) : "…"}</span>{" "}
                <button
                  type="button"
                  className="np-link"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Changer
                </button>
              </p>
            )}
            {fullName && !already && editing && (
              <>
                <label className="field">
                  Cloner dans
                  <input
                    className="mono"
                    required
                    value={parent}
                    onChange={(e) => setParentTyped(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  Nom du dossier
                  <input
                    className="mono"
                    placeholder={repoFolderName(repo)}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </>
            )}
          </>
        )}

        {source === "local" && (
          <>
            {freeFolders.length > 0 && (
              <ul className="np-repos" aria-label="Dossiers git trouvés sur cette machine">
                {freeFolders.slice(0, 60).map((c) => (
                  <li key={c.path}>
                    <button
                      type="button"
                      aria-pressed={folder === c.path}
                      disabled={busy}
                      onClick={() => {
                        setFolder(c.path);
                        setName("");
                      }}
                    >
                      <span className="np-name">{c.name}</span>
                      {c.repo && <span className="np-tag">{c.repo}</span>}
                      <small className="mono">{c.path}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {local && freeFolders.length === 0 && (
              <p>
                Aucun dépôt git trouvé dans ton dossier personnel qui ne soit pas déjà un projet.
              </p>
            )}
            {local === null && <p className="np-empty">Recherche de tes dossiers…</p>}
            <label className="field">
              {freeFolders.length > 0 ? "Ou un autre dossier" : "Dossier"}
              <input
                className="mono"
                aria-label="Dossier"
                placeholder={local?.parent ? joinPath(local.parent, "mon-projet") : "~/mon-projet"}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                disabled={busy}
              />
            </label>
            {folder.trim() && (
              <label className="field">
                Nom
                <input
                  placeholder={localName || "mon-projet"}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn pri" disabled={busy || !ready}>
            {action}
          </button>
        </div>
      </form>
    </div>
  );
}
