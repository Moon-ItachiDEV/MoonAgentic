import {
  type GithubRepo,
  type GithubStatus,
  type LocalClone,
  PROJECT_COLORS,
  type ProjectColor,
} from "@moonagentic/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { COLOR_NAME } from "../project-colors.ts";
import { findProjectIcons, PROJECT_ICON_PREFIX, PROJECT_ICONS } from "../project-icons.ts";
import { shortAgo } from "../project-threads.ts";
import { Dropdown } from "../v2/Dropdown.tsx";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { useScreen } from "../v2/use-screen.ts";
import { GithubSignIn } from "./GithubSignIn.tsx";
import { ProjectIcon } from "./ProjectIcon.tsx";

type Source = "local" | "github";

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

/** The folder a path ends with, and what comes before it. */
const leaf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";
const above = (path: string) => path.replace(/[\\/]+[^\\/]+[\\/]*$/, "");

/**
 * The colours and the icons a project can wear, in a menu that drops from the name's icon
 * (iPad, computer): the same choices as « Réglages du projet › Icône ».
 */
function LookMenu(props: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  icon: string;
  color: ProjectColor | null;
  onIcon: (icon: string) => void;
  onColor: (color: ProjectColor | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const found = findProjectIcons(query);
  const q = query.trim().toLowerCase();
  const showFolder = !q || "dossier".startsWith(q) || "folder".startsWith(q);
  return (
    <Dropdown
      anchor={props.anchor}
      start
      role="dialog"
      className={`icp${props.color ? ` pc-${props.color}` : ""}`}
      label="Icône et couleur"
      onClose={props.onClose}
    >
      <div className="icsw" role="radiogroup" aria-label="Couleur">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={props.color === c}
            aria-label={COLOR_NAME[c]}
            title={COLOR_NAME[c]}
            style={{ "--c": `var(--pc-${c})` } as React.CSSProperties}
            onClick={() => props.onColor(props.color === c ? null : c)}
          />
        ))}
      </div>
      <label className="icq">
        <I n="search" s={14} />
        <input
          aria-label="Chercher une icône"
          placeholder="Chercher"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="ipk" role="radiogroup" aria-label="Icône">
        {showFolder && (
          <button
            type="button"
            role="radio"
            aria-checked={!props.icon}
            aria-label="Dossier"
            title="Dossier"
            onClick={() => props.onIcon("")}
          >
            <I n="folder" s={18} />
          </button>
        )}
        {found.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={props.icon === PROJECT_ICON_PREFIX + name}
            aria-label={PROJECT_ICONS[name][0]}
            title={PROJECT_ICONS[name][0]}
            onClick={() => props.onIcon(PROJECT_ICON_PREFIX + name)}
          >
            <svg width={18} height={18} aria-hidden="true">
              <use href={`#pi-${name}`} />
            </svg>
          </button>
        ))}
      </div>
      {found.length === 0 && !showFolder && <p className="snone">Aucune icône</p>}
    </Dropdown>
  );
}

function Body({
  onCreated,
  onBusy,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
}) {
  // On an iPad or a computer: the name first, the source in a frame, « Annuler » and « Créer ».
  const { roomy } = useScreen();
  const [icon, setIcon] = useState("");
  const [lookOpen, setLookOpen] = useState(false);
  const lookButton = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<Source>("local");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  /** « Autre dossier »: a path typed by hand. */
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProjectColor | null>(null);
  /** The parent folder typed by the user; the server's default until then. */
  const [parentTyped, setParentTyped] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
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
    () => filterRepos(github.repos ?? [], query).slice(0, 60),
    [github.repos, query],
  );
  const freeFolders = clones.filter((c) => !c.projectId);
  const localName = name.trim() || leaf(folder.trim());
  const gh = source === "github";

  const run = async (make: () => Promise<string>) => {
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const id = await make();
      if (color || icon)
        connection.send({ type: "project.setLook", projectId: id, icon: icon || null, color });
      onBusy(false);
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      onBusy(false);
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
    if (busy || !ready) return;
    if (!gh) {
      void addFolder(folder.trim(), localName);
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

  const ready = gh
    ? !!fullName && (!!already || canClone(repo, parent, name))
    : !!folder.trim() && !!localName;
  const chosen = gh ? !!fullName : !!folder.trim();
  const isProject = gh && !!already?.projectId;
  const action = !gh ? "Créer" : isProject ? "Ouvrir" : already ? "Créer" : "Cloner";
  // On a phone the name is asked once the folder is chosen, and starts again with it. On an
  // iPad or a computer it is typed first: it stays.
  const forgetName = () => {
    if (!roomy) setName("");
  };
  const switchTo = (next: Source) => {
    setSource(next);
    setError(null);
    forgetName();
  };

  const mark = (on: boolean, idle: "plus" | "folder" = "plus") => (
    <span className="npri" aria-hidden>
      <I n={on ? "check" : idle} s={16} />
    </span>
  );

  return (
    <form className={roomy ? "sbody npd" : "sbody"} onSubmit={submit}>
      {roomy && (
        <>
          <div className="npfl">Nom</div>
          <div className="npnm">
            <button
              ref={lookButton}
              type="button"
              className="npic"
              aria-haspopup="dialog"
              aria-label="Icône et couleur"
              disabled={busy || isProject}
              onClick={() => setLookOpen((on) => !on)}
            >
              <ProjectIcon
                project={{ icon: icon || undefined, color: color ?? undefined }}
                size={17}
              />
            </button>
            <input
              aria-label={gh && !already ? "Nom du dossier" : "Nom du projet"}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                chosen
                  ? gh
                    ? (already?.name ?? repoFolderName(repo))
                    : leaf(folder.trim())
                  : gh
                    ? "Choisis un dépôt"
                    : "Choisis un dossier"
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || isProject}
            />
          </div>
          {lookOpen && (
            <LookMenu
              anchor={lookButton}
              icon={icon}
              color={color}
              onIcon={(next) => {
                setIcon(next);
                setLookOpen(false);
              }}
              onColor={setColor}
              onClose={() => setLookOpen(false)}
            />
          )}
        </>
      )}
      <div
        className={roomy ? "npbox" : undefined}
        style={roomy ? undefined : { display: "contents" }}
      >
        {roomy && (
          <div className="npbh">
            <b>{gh ? "Dépôt" : "Dossier"}</b>
            <SourceTabs gh={gh} busy={busy} onPick={switchTo} small />
          </div>
        )}
        {!roomy && <SourceTabs gh={gh} busy={busy} onPick={switchTo} />}
        <div
          className={roomy ? "npl" : undefined}
          style={roomy ? undefined : { display: "contents" }}
        >
          {!gh && roomy && freeFolders.length > 0 && <div className="nps">Suggéré</div>}
          {!gh && (
            <div className="ins" role="group" aria-label="Dossiers git trouvés sur cette machine">
              {local === null && (
                <div className="fvn">
                  <span className="t2-spin" />
                </div>
              )}
              {freeFolders.slice(0, 60).map((c) => (
                <button
                  key={c.path}
                  type="button"
                  className="it fva"
                  aria-pressed={!typing && folder === c.path}
                  disabled={busy}
                  onClick={() => {
                    setTyping(false);
                    setFolder(folder === c.path && !typing ? "" : c.path);
                    forgetName();
                  }}
                >
                  {mark(!typing && folder === c.path)}
                  <span className="tx">
                    {c.name}
                    <small>{above(c.path)}</small>
                  </span>
                  <span className="fvc">
                    <I n="check" s={14} />
                  </span>
                </button>
              ))}
              {typing ? (
                <label className="it ro npf">
                  <input
                    className="mono"
                    aria-label="Dossier"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      local?.parent ? joinPath(local.parent, "mon-projet") : "~/mon-projet"
                    }
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    disabled={busy}
                  />
                </label>
              ) : (
                <button
                  type="button"
                  className="it"
                  disabled={busy}
                  onClick={() => {
                    setTyping(true);
                    setFolder("");
                    forgetName();
                  }}
                >
                  {mark(false, "folder")}
                  <span className="tx">Autre dossier</span>
                  <I n="right" s={15} />
                </button>
              )}
            </div>
          )}

          {gh && github.status === null && !github.error && (
            <div className="fvn">
              <span className="t2-spin" />
            </div>
          )}
          {gh && github.status && !signedIn && github.status.canSignIn && (
            <GithubSignIn onSignedIn={github.recheck} />
          )}
          {gh && github.status && (
            <>
              <label className="fvs">
                <I n="search" s={17} />
                <input
                  className={signedIn ? undefined : "mono"}
                  aria-label="Dépôt"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={signedIn ? "Rechercher un dépôt" : "https://github.com/…/…"}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPicked(null);
                  }}
                  disabled={busy}
                />
              </label>
              {!signedIn && !github.status.canSignIn && !fullName && (
                <div className="fvn">
                  <span className="ppill mono">gh auth login</span>
                </div>
              )}
              {signedIn && !github.error && roomy && shown.length > 0 && (
                <div className="nps">Tes dépôts</div>
              )}
              {signedIn && !github.error && (
                <div className="ins" role="group" aria-label="Tes dépôts GitHub">
                  {github.repos === null && (
                    <div className="fvn">
                      <span className="t2-spin" />
                    </div>
                  )}
                  {github.repos !== null && shown.length === 0 && !fullName && (
                    <div className="fvn">{owner ? `Aucun dépôt de @${owner}` : "Aucun dépôt"}</div>
                  )}
                  {shown.map((r) => {
                    const here = localFor(r.fullName, clones);
                    const [account, short] = r.fullName.split("/");
                    return (
                      <button
                        key={r.fullName}
                        type="button"
                        className="it fva"
                        aria-pressed={picked === r.fullName}
                        disabled={busy}
                        onClick={() => {
                          setPicked(picked === r.fullName ? null : r.fullName);
                          forgetName();
                          setEditing(false);
                          setError(null);
                        }}
                      >
                        {mark(picked === r.fullName)}
                        <span className="tx">
                          <span className="npn">
                            {short}
                            {r.private && <I n="lock" s={12} />}
                          </span>
                          <small>
                            {account}
                            {r.pushedAt ? ` · ${shortAgo(r.pushedAt, now)}` : ""}
                          </small>
                        </span>
                        {here && (
                          <span className="npk">{here.projectId ? "Projet" : "Sur le PC"}</span>
                        )}
                        <span className="fvc">
                          <I n="check" s={14} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {signedIn && github.status.account === "moonagentic" && !fullName && (
                <div className="ins">
                  <a className="it" href={GITHUB_APP_ACCESS} target="_blank" rel="noreferrer">
                    <span className="tx">Accès des organisations</span>
                    <I n="ext" s={15} />
                  </a>
                </div>
              )}
            </>
          )}
          {gh && github.error && (
            <p className="pcw t-err" role="alert">
              {github.error}
            </p>
          )}
        </div>
      </div>

      {chosen && (
        <div className="npx on">
          {!roomy && <div className="gl2">Projet</div>}
          <div className="ins">
            {!isProject && !roomy && (
              <>
                <label className="it ro npf">
                  <span style={{ color: color ? `var(--pc-${color})` : "var(--muted)" }}>
                    <I n="folder" s={20} />
                  </span>
                  <input
                    aria-label={gh && !already ? "Nom du dossier" : "Nom du projet"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={gh ? (already?.name ?? repoFolderName(repo)) : leaf(folder.trim())}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <div className="sep" />
                <div className="sw" role="radiogroup" aria-label="Couleur">
                  {PROJECT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={color === c}
                      aria-pressed={color === c}
                      aria-label={COLOR_NAME[c]}
                      title={COLOR_NAME[c]}
                      style={{ "--c": `var(--pc-${c})` } as React.CSSProperties}
                      disabled={busy}
                      onClick={() => setColor(color === c ? null : c)}
                    />
                  ))}
                </div>
              </>
            )}
            {gh && already && (
              <div className="it ro" role="status">
                <span className="tx">
                  {already.projectId ? "Déjà un projet" : "Déjà sur le PC"}
                </span>
                <span className="rt mcv">
                  <span className="mono" title={already.path}>
                    {already.path}
                  </span>
                </span>
              </div>
            )}
            {gh && !already && !editing && (
              <button type="button" className="it" disabled={busy} onClick={() => setEditing(true)}>
                <span className="tx">Emplacement</span>
                <span className="rt mcv">
                  <span className="mono" title={parent}>
                    {parent || "…"}
                  </span>
                </span>
                <I n="right" s={15} />
              </button>
            )}
            {gh && !already && editing && (
              <label className="it ro npf">
                <input
                  className="mono"
                  aria-label="Cloner dans"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={parent}
                  onChange={(e) => setParentTyped(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="pcw t-err" role="alert">
          {error}
        </p>
      )}
      <div className={roomy ? "npft" : "mga"}>
        {roomy && (
          <button type="button" className="b2 soft press" disabled={busy} onClick={onCancel}>
            Annuler
          </button>
        )}
        <button
          type="submit"
          className={`b2 ink press npgo${busy ? " busy" : ""}`}
          disabled={busy || !ready}
        >
          {busy && <span className="t2-spin" />}
          {busy && gh && !already ? "Clonage" : roomy ? `${action} le projet` : action}
        </button>
      </div>
    </form>
  );
}

/** « Nouveau projet »: a git folder of the machine, or a GitHub repository cloned onto it. */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  // While a repository is cloned, the sheet stays: closing it would hide whether it worked.
  const [busy, setBusy] = useState(false);
  const close = () => !busy && onClose();
  return (
    <Sheet open={open} onClose={close} title="Nouveau projet" modal={busy}>
      {open && <Body onCreated={onCreated} onBusy={setBusy} onCancel={close} />}
    </Sheet>
  );
}

/** Where the project comes from: a folder of this machine, or GitHub. */
function SourceTabs(props: {
  gh: boolean;
  busy: boolean;
  onPick: (source: Source) => void;
  /** The small tabs in the frame's header (iPad, computer). */
  small?: boolean;
}) {
  const s = props.small ? 14 : 16;
  return (
    <div className={props.small ? "npt" : "seg"} role="radiogroup" aria-label="Source du projet">
      <button
        type="button"
        role="radio"
        aria-checked={!props.gh}
        aria-pressed={!props.gh}
        disabled={props.busy}
        onClick={() => props.onPick("local")}
      >
        <I n="folder" s={s} />
        Sur le PC
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={props.gh}
        aria-pressed={props.gh}
        disabled={props.busy}
        onClick={() => props.onPick("github")}
      >
        <I n="gh" s={s} />
        GitHub
      </button>
    </div>
  );
}
