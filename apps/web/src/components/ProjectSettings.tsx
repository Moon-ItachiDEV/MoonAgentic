import {
  type AgentInfo,
  type FavoriteRef,
  MAX_FALLBACK_MODELS,
  PROJECT_COLORS,
  type Project,
  type ProjectColor,
  type ProjectSetup,
  type ProjectSkill,
} from "@moonagentic/protocol";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { connection, newId } from "../connection.ts";
import { modelLabel } from "../model-label.ts";
import { COLOR_NAME } from "../project-colors.ts";
import {
  claudeAction,
  commandProblem,
  fits,
  memoryFits,
  oneLine,
  skillProblem,
} from "../project-setup.ts";
import { notificationsOn, projectMuted, setProjectMuted } from "../notifications.ts";
import { syncPush } from "../push.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { BranchCleanup } from "./BranchCleanup.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  findProjectIcons,
  PROJECT_ICON_PREFIX,
  PROJECT_ICONS,
  projectIconName,
} from "../project-icons.ts";
import { ProjectIcon } from "./ProjectIcon.tsx";

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Pane = "main" | "icon" | "commands" | "skills" | "fallback";
const PANE_TITLE: Record<Pane, string> = {
  main: "Réglages du projet",
  icon: "Icône",
  commands: "Commandes",
  skills: "Skills",
  fallback: "Modèle de secours",
};

/** A project's fallback models while none were set: off, coming back once the quota is reset. */
const NO_FALLBACK = { on: false, back: true, models: [] as FavoriteRef[] };

/** The name a model goes by, from its agent's list, or its id while that is not known. */
const modelName = (agents: AgentInfo[], ref: FavoriteRef) => {
  const known = agents.find((a) => a.id === ref.agentId)?.models?.find((m) => m.id === ref.model);
  return known ? modelLabel(known) : ref.model;
};

/**
 * A project's settings, as one sheet: its name, icon and tint, what it gives its agents
 * (read from and written to its own folder: `AGENTS.md`, its `/` commands and its skills),
 * its shared memory, its repository, and what can be done with the project itself.
 */
export function ProjectSettings(props: {
  project: Project;
  open: boolean;
  /** Something of the project is not read yet. */
  unread: boolean;
  /** Who coordinates it, in words, once it has a coordinator. */
  coordinator?: string | undefined;
  onClose: () => void;
  onOpenCoordinator: () => void;
  onOpenUsage: () => void;
  onOpenPlanner: () => void;
  onLock: () => void;
  onRemove: () => void;
}) {
  const { project } = props;
  const projectId = project.id;
  const [pane, setPane] = useState<Pane>("main");
  const [setup, setSetup] = useState<ProjectSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [muted, setMuted] = useState(() => projectMuted(projectId));
  const [name, setName] = useState(project.name);
  const [rules, setRules] = useState<string>();
  const [memory, setMemory] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agents = useSyncExternalStore(connection.subscribe, connection.getState).agents;
  const fallback = project.quota?.fallback ?? NO_FALLBACK;
  const setFallback = (next: typeof fallback) =>
    connection.send({ type: "project.setQuotaRules", projectId, fallback: next });

  useEffect(() => {
    if (!props.open) return;
    setPane("main");
    setName(project.name);
    setRules(undefined);
    setMemory(undefined);
    setError(undefined);
    let live = true;
    connection
      .ask({ type: "project.setup", requestId: newId(), projectId })
      .then((reply) => live && setSetup(reply.setup))
      .catch((e: unknown) => live && setLoadError(why(e)));
    return () => {
      live = false;
    };
    // Read again each time the sheet opens: the folder may have changed meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, projectId]);

  /** Sends a change and shows the folder as the server reads it after. */
  const change: Change = async (message) => {
    const reply = await connection.ask(message);
    setSetup(reply.setup);
  };

  const savedRules = setup?.rules.text ?? "";
  const text = rules ?? savedRules;
  // Kept by MoonAgentic, not in the folder: shared at once by every agent, thread and branch.
  const savedMemory = setup?.memory.text ?? "";
  const notes = memory ?? savedMemory;
  const memoryChanged =
    memory !== undefined && memory.replace(/\r\n/g, "\n").trim() !== savedMemory;
  const newName = name.trim();
  const dirty =
    (!!newName && newName !== project.name) ||
    (rules !== undefined && rules !== savedRules) ||
    memoryChanged;
  const canSave = dirty && !busy && fits(text) && memoryFits(notes);
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      if (newName && newName !== project.name) {
        connection.send({ type: "project.rename", projectId, name: newName });
      }
      if (rules !== undefined && rules !== savedRules) {
        await change({ type: "project.saveRules", requestId: newId(), projectId, text: rules });
        setRules(undefined);
      }
      if (memory !== undefined && memoryChanged) {
        await change({ type: "project.saveMemory", requestId: newId(), projectId, text: memory });
        setMemory(undefined);
      }
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  const link = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await change({ type: "project.linkClaude", requestId: newId(), projectId });
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    props.onClose();
  };
  const leave = (run: () => void) => () => {
    close();
    run();
  };

  let body: ReactNode;
  if (pane === "icon") {
    body = <IconPane project={project} />;
  } else if (pane === "fallback") {
    body = <FallbackPane agents={agents} fallback={fallback} onChange={setFallback} />;
  } else if (pane !== "main") {
    body = loadError ? (
      <p className="snone">{loadError}</p>
    ) : !setup ? (
      <p className="snone">Lecture du dossier…</p>
    ) : pane === "commands" ? (
      <CommandsTab setup={setup} projectId={projectId} change={change} onConfirm={setConfirm} />
    ) : (
      <SkillsTab setup={setup} projectId={projectId} change={change} onConfirm={setConfirm} />
    );
  } else {
    body = (
      <>
        <div className="gl2">Nom</div>
        <label className={`fld${project.color ? ` pc-${project.color}` : ""}`}>
          <ProjectIcon project={project} size={20} />
          <input
            aria-label="Nom du projet"
            value={name}
            maxLength={120}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>
        <div className="gl2">Apparence</div>
        <LookTab project={project} onOpenIcons={() => setPane("icon")} />
        <div className="gl2">Consignes pour les agents</div>
        {setup?.rules.tooBig ? (
          <div className="ins">
            <div className="it ro">
              <span className="tx">AGENTS.md</span>
              <span className="rt">Trop gros pour être modifié ici</span>
            </div>
          </div>
        ) : (
          <label className="fld ta">
            <textarea
              aria-label="Contenu de AGENTS.md"
              value={text}
              disabled={!setup}
              placeholder={setup ? "AGENTS.md" : (loadError ?? "Lecture du dossier…")}
              spellCheck={false}
              onChange={(e) => setRules(e.target.value)}
            />
          </label>
        )}
        {setup && !setup.rules.tooBig && (
          <div className="ins">
            {!fits(text) && (
              <div className="it ro">
                <span className="tx mer">Texte trop long</span>
              </div>
            )}
            <div className="it ro">
              <span className="tx">
                Claude Code
                <small>
                  {setup.claude === "imports"
                    ? "Lit AGENTS.md par CLAUDE.md"
                    : setup.claude === "missing"
                      ? "Lit CLAUDE.md, pas AGENTS.md"
                      : "CLAUDE.md n'importe pas AGENTS.md"}
                </small>
              </span>
              {setup.claude === "imports" ? (
                <span className="okp">Relié</span>
              ) : (
                // Linking needs AGENTS.md written first.
                setup.rules.exists && (
                  <button
                    className="mini"
                    title={claudeAction(setup.claude)}
                    disabled={busy}
                    onClick={() => void link()}
                  >
                    Relier
                  </button>
                )
              )}
            </div>
            {setup.uncommitted && (
              <div className="it ro">
                <span className="tx">
                  Pas encore commité
                  <small className="mono">{setup.uncommitted.join(", ")}</small>
                </span>
              </div>
            )}
          </div>
        )}
        <div className="gl2">Mémoire partagée</div>
        <label className="fld ta">
          <textarea
            aria-label="Mémoire partagée du projet"
            value={notes}
            disabled={!setup}
            placeholder={
              setup ? "Décisions, conventions, pièges connus" : (loadError ?? "Lecture du dossier…")
            }
            spellCheck={false}
            onChange={(e) => setMemory(e.target.value)}
          />
        </label>
        {!memoryFits(notes) && (
          <div className="ins">
            <div className="it ro">
              <span className="tx mer">Mémoire trop longue (16 Ko max)</span>
            </div>
          </div>
        )}
        <div className="gl2">Dépôt</div>
        <div className="ins">
          <div className="it ro">
            <span className="ic">
              <I n={project.git ? "branch" : "folder"} s={17} />
            </span>
            <span className="tx repo">
              <span>{project.git ? "Dépôt git" : "Dossier"}</span>
              <span className="mono2">{project.path}</span>
            </span>
          </div>
          {project.git && (
            <button className="it" onClick={() => setCleaning(true)}>
              <span className="ic">
                <I n="branch" s={17} />
              </span>
              <span className="tx">Branches</span>
              <I n="right" s={15} />
            </button>
          )}
        </div>
        <div className="gl2">Coordinateur</div>
        <div className="ins">
          <button className="it" onClick={leave(props.onOpenCoordinator)}>
            <span className="tx">{props.coordinator ?? "Aucun"}</span>
            <span className="rt">
              Régler
              <I n="right" s={15} />
            </span>
          </button>
          <div className="it ro">
            <span className="tx">Reprendre les fils quand les quotas sont remis à zéro</span>
            <button
              className="tog"
              role="switch"
              aria-checked={!!project.quota?.resume}
              aria-label="Reprendre les fils quand les quotas sont remis à zéro"
              onClick={() =>
                connection.send({
                  type: "project.setQuotaRules",
                  projectId,
                  resume: !project.quota?.resume,
                })
              }
            />
          </div>
          <button className="it" onClick={() => setPane("fallback")}>
            <span className="tx">Modèle de secours</span>
            <span className="rt">
              {!fallback.on || !fallback.models.length
                ? "Non"
                : modelName(agents, fallback.models[0]!) +
                  (fallback.models.length > 1 ? ` +${fallback.models.length - 1}` : "")}
              <I n="right" s={15} />
            </span>
          </button>
        </div>
        <div className="ins">
          <button className="it" onClick={() => setPane("skills")}>
            <span className="ic">
              <span className="key">$</span>
            </span>
            <span className="tx">Skills</span>
            <span className="rt">
              {setup?.skills.length ?? ""}
              <I n="right" s={15} />
            </span>
          </button>
          <button className="it" onClick={() => setPane("commands")}>
            <span className="ic">
              <span className="key">/</span>
            </span>
            <span className="tx">Commandes</span>
            <span className="rt">
              {setup?.commands.length ?? ""}
              <I n="right" s={15} />
            </span>
          </button>
          <button className="it" onClick={leave(props.onOpenPlanner)}>
            <span className="ic">
              <I n="grid" s={17} />
            </span>
            <span className="tx">Planner du projet</span>
            <I n="right" s={15} />
          </button>
          <button className="it" onClick={leave(props.onOpenUsage)}>
            <span className="ic">
              <I n="gauge" s={17} />
            </span>
            <span className="tx">Utilisation</span>
            <I n="right" s={15} />
          </button>
        </div>
        <div className="ins">
          <div className="it ro">
            <span className="tx">Épinglé</span>
            <button
              className="tog"
              role="switch"
              aria-checked={!!project.pinned}
              aria-label="Épingler le projet"
              onClick={() =>
                connection.send({
                  type: "project.setPinned",
                  projectId,
                  pinned: !project.pinned,
                })
              }
            />
          </div>
          {/* Only where this device notifies at all: nothing to cut otherwise. */}
          {notificationsOn() && (
            <div className="it ro">
              <span className="tx">Notifications</span>
              <button
                className="tog"
                role="switch"
                aria-checked={!muted}
                aria-label="Notifications du projet"
                onClick={() => {
                  setProjectMuted(projectId, !muted);
                  setMuted(!muted);
                  // The server, which sends Web Push, must know it too.
                  syncPush();
                }}
              />
            </div>
          )}
          {props.unread && (
            <button
              className="it acc"
              onClick={() => void connection.send({ type: "project.markRead", projectId })}
            >
              <span className="tx">Tout marquer comme lu</span>
            </button>
          )}
          <button
            className="it acc"
            onClick={() => window.open(location.href, "_blank", "noopener")}
          >
            <span className="tx">Ouvrir dans une nouvelle fenêtre</span>
          </button>
        </div>
        <div className="ins">
          <button className="it" onClick={leave(props.onLock)}>
            <span className="ic">
              <I n="lock" s={17} />
            </span>
            <span className="tx">Verrouiller par code</span>
          </button>
          <button className="it dng" onClick={leave(props.onRemove)}>
            <span className="ic">
              <I n="x" s={17} />
            </span>
            <span className="tx">Retirer de MoonAgentic</span>
          </button>
        </div>
        {error && <p className="snone mer">{error}</p>}
      </>
    );
  }

  return (
    <>
      <Sheet
        open={props.open}
        onClose={close}
        title={PANE_TITLE[pane]}
        tall
        className="pset"
        right={
          pane === "main" ? (
            <button
              className={`ok2 press${canSave ? " on" : ""}`}
              aria-label="Enregistrer"
              disabled={!canSave}
              onClick={() => void save()}
            >
              <I n="check" s={19} />
            </button>
          ) : (
            <button className="hmore press" onClick={() => setPane("main")}>
              Retour
            </button>
          )
        }
      >
        <div className="sbody">{body}</div>
      </Sheet>
      <BranchCleanup open={cleaning} project={project} onClose={() => setCleaning(false)} />
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

type SetupRequest = Extract<
  Parameters<typeof connection.ask>[0],
  {
    type:
      | "project.saveRules"
      | "project.saveMemory"
      | "project.linkClaude"
      | "project.saveCommand"
      | "project.removeCommand"
      | "project.saveSkill"
      | "project.removeSkill";
  }
>;
type Change = (message: SetupRequest) => Promise<void>;

/**
 * « Modèle de secours »: when a model's quota runs out, the thread goes on with the first of
 * these that still has some, in the order they were picked; and goes back to its own once
 * that one's quota is reset, unless told not to.
 */
function FallbackPane(props: {
  agents: AgentInfo[];
  fallback: { on: boolean; back: boolean; models: FavoriteRef[] };
  onChange: (next: { on: boolean; back: boolean; models: FavoriteRef[] }) => void;
}) {
  const { agents, fallback, onChange } = props;
  const ready = agents.filter((a) => a.available && a.models?.length !== 0);
  // The check each agent had when « Lire ses modèles » was pressed: over once it has another.
  const [asked, setAsked] = useState<Record<string, number | null>>({});
  const discover = (agent: AgentInfo) => {
    if (!connection.send({ type: "agent.discover", agentId: agent.id })) {
      connection.notify("Pas de connexion au serveur MoonAgentic.");
      return;
    }
    setAsked((was) => ({ ...was, [agent.id]: agent.check?.at ?? null }));
  };
  const reading = (agent: AgentInfo) =>
    asked[agent.id] !== undefined && asked[agent.id] === (agent.check?.at ?? null);
  const rankOf = (agentId: string, model: string) =>
    fallback.models.findIndex((m) => m.agentId === agentId && m.model === model);
  const toggle = (agentId: string, model: string) => {
    const rank = rankOf(agentId, model);
    const models =
      rank >= 0
        ? fallback.models.filter((_, i) => i !== rank)
        : [...fallback.models, { agentId, model }].slice(0, MAX_FALLBACK_MODELS);
    onChange({ ...fallback, models });
  };
  return (
    <>
      <div className="ins">
        <div className="it ro">
          <span className="tx">Passer au secours</span>
          <button
            className="tog"
            role="switch"
            aria-checked={fallback.on}
            aria-label="Passer au secours"
            onClick={() => onChange({ ...fallback, on: !fallback.on })}
          />
        </div>
        <div className="it ro">
          <span className="tx">Revenir quand le quota repart</span>
          <button
            className="tog"
            role="switch"
            aria-checked={fallback.back}
            aria-label="Revenir quand le quota repart"
            onClick={() => onChange({ ...fallback, back: !fallback.back })}
          />
        </div>
      </div>
      <div className={fallback.on ? "" : "fboff"}>
        {ready.map((agent) => (
          <div key={agent.id}>
            <div className="gl2">
              {agent.name}
              <span className="sp" />
              {reading(agent) ? (
                <span className="ppill" role="status">
                  Lecture des modèles…
                </span>
              ) : (
                !agent.models && (
                  <button className="lk" onClick={() => discover(agent)}>
                    {agent.modelsError ? "Réessayer" : "Lire ses modèles"}
                  </button>
                )
              )}
            </div>
            {agent.models && (
              <div className="ins">
                {agent.models.map((m) => {
                  const rank = rankOf(agent.id, m.id);
                  const name = modelLabel(m);
                  const full = rank < 0 && fallback.models.length >= MAX_FALLBACK_MODELS;
                  return (
                    <button
                      key={m.id}
                      className="it fva"
                      aria-pressed={rank >= 0}
                      aria-label={name}
                      disabled={!fallback.on || full}
                      onClick={() => toggle(agent.id, m.id)}
                    >
                      <span className="tx">{name}</span>
                      {rank >= 0 && <span className="fvr">{rank + 1}</span>}
                      <span className="fvc">
                        <I n="check" s={14} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Sends a project's icon and tint: an empty icon puts back the folder. */
const sendLook = (projectId: string, icon: string | undefined, color: ProjectColor | undefined) =>
  connection.send({
    type: "project.setLook",
    projectId,
    icon: (icon ?? "").trim() || null,
    color: color ?? null,
  });

/** What a project's icon is called: its folder, one of the drawn icons, or what was typed. */
const iconName = (icon: string | undefined) => {
  const drawn = projectIconName(icon);
  return !icon ? "Dossier" : drawn ? PROJECT_ICONS[drawn][0] : icon;
};

/** The tints a project can take; the one it has takes it back to the usual tint. */
function Swatches({ project }: { project: Project }) {
  return (
    <div className="sw" role="radiogroup" aria-label="Couleur">
      {PROJECT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={project.color === color}
          aria-pressed={project.color === color}
          aria-label={COLOR_NAME[color]}
          title={COLOR_NAME[color]}
          style={{ "--c": `var(--pc-${color})` } as React.CSSProperties}
          onClick={() =>
            sendLook(project.id, project.icon, project.color === color ? undefined : color)
          }
        />
      ))}
    </div>
  );
}

function LookTab({ project, onOpenIcons }: { project: Project; onOpenIcons: () => void }) {
  return (
    <div className={`ins${project.color ? ` pc-${project.color}` : ""}`}>
      <button className="ico-pick" onClick={onOpenIcons}>
        <span className="pv">
          <ProjectIcon project={project} size={20} />
        </span>
        <span className="tx">
          Icône
          <small>
            {iconName(project.icon)}
            {project.color ? ` · ${COLOR_NAME[project.color]}` : ""}
          </small>
        </span>
        <I n="right" s={15} />
      </button>
      <div className="sep" />
      <Swatches project={project} />
    </div>
  );
}

/** Every icon a project can wear, in its tint, with a search. */
function IconPane({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const keep = (icon: string) => sendLook(project.id, icon, project.color);
  const found = findProjectIcons(query);
  const q = query.trim().toLowerCase();
  const showFolder = !q || "dossier".startsWith(q) || "folder".startsWith(q);
  const current = project.icon ?? "";
  const tint = project.color ? ` pc-${project.color}` : "";

  return (
    <>
      <div className={`ipv${tint}`}>
        <span className="pv">
          <ProjectIcon project={project} size={28} />
        </span>
        <span className="tx">
          <b>{project.name}</b>
          <small>
            {iconName(project.icon)}
            {project.color ? ` · ${COLOR_NAME[project.color]}` : ""}
          </small>
        </span>
      </div>
      <div className="ins">
        <Swatches project={project} />
      </div>
      <label className="fld ipq">
        <I n="search" s={19} />
        <input
          aria-label="Chercher une icône"
          placeholder="Chercher"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className={`ins${tint}`}>
        <div className="ipk" role="radiogroup" aria-label="Icône">
          {showFolder && (
            <button
              type="button"
              role="radio"
              aria-checked={!current}
              aria-label="Dossier"
              title="Dossier"
              onClick={() => keep("")}
            >
              <I n="folder" s={22} />
            </button>
          )}
          {found.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={current === PROJECT_ICON_PREFIX + name}
              aria-label={PROJECT_ICONS[name][0]}
              title={PROJECT_ICONS[name][0]}
              onClick={() => keep(PROJECT_ICON_PREFIX + name)}
            >
              <svg width={22} height={22} aria-hidden="true">
                <use href={`#pi-${name}`} />
              </svg>
            </button>
          ))}
        </div>
        {found.length === 0 && !showFolder && <p className="snone">Aucune icône</p>}
      </div>
    </>
  );
}

interface Draft {
  name: string;
  description: string;
  text: string;
}

/** The form of a command or a skill being written. */
function Editor(props: {
  label: string;
  draft: Draft;
  /** Why the name typed cannot be kept, or nothing. */
  problemFor: (name: string) => string | undefined;
  descriptionNeeded?: boolean;
  textLabel: string;
  textHint: string;
  onSave: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Said once something is typed, not on an empty new form.
  const problem = props.problemFor(draft.name);
  const missing =
    (props.descriptionNeeded && !draft.description.trim()) ||
    !draft.text.trim() ||
    !fits(draft.text);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || missing) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSave(draft);
    } catch (e) {
      setError(why(e));
      setBusy(false);
    }
  };
  return (
    <form className="pse" onSubmit={submit} aria-label={props.label}>
      <div className="gl2">Nom</div>
      <label className="fld">
        <input
          className="mono"
          aria-label="Nom"
          value={draft.name}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value.trim() })}
        />
      </label>
      {draft.name && problem && <p className="snone mer">{problem}</p>}
      <div className="gl2">Description{props.descriptionNeeded ? "" : " (facultative)"}</div>
      <label className="fld">
        <input
          aria-label="Description"
          value={draft.description}
          maxLength={500}
          onChange={(e) => setDraft({ ...draft, description: oneLine(e.target.value) })}
        />
      </label>
      <div className="gl2">{props.textLabel}</div>
      <label className="fld ta">
        <textarea
          className="mono"
          aria-label={props.textLabel}
          placeholder={props.textHint}
          value={draft.text}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
      </label>
      {!fits(draft.text) && <p className="snone mer">Texte trop long</p>}
      {error && <p className="snone mer">{error}</p>}
      <div className="cfa">
        <button className="b2 ink press" disabled={busy || !!problem || missing}>
          Enregistrer
        </button>
        <button type="button" className="b2 soft press" onClick={props.onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function CommandsTab(props: {
  setup: ProjectSetup;
  projectId: string;
  change: Change;
  onConfirm: (confirm: Confirmation) => void;
}) {
  // The command being written: a new one (no previous name) or one of the project's.
  const [editing, setEditing] = useState<{ previous?: string; draft: Draft } | null>(null);
  const commands = props.setup.commands;
  if (editing) {
    return (
      <Editor
        label={editing.previous ? `Modifier /${editing.previous}` : "Nouvelle commande"}
        draft={editing.draft}
        problemFor={(name) => commandProblem(name, commands, editing.previous)}
        textLabel="Message envoyé à l'agent"
        textHint="$ARGUMENTS reprend ce que tu tapes après la commande."
        onSave={async (draft) => {
          await props.change({
            type: "project.saveCommand",
            requestId: newId(),
            projectId: props.projectId,
            name: draft.name,
            ...(editing.previous ? { previous: editing.previous } : {}),
            description: draft.description.trim(),
            template: draft.text,
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="ins">
      {commands.map((c) => (
        <div key={c.name} className="it ro">
          <button
            className="mpick"
            aria-label={`Modifier /${c.name}`}
            onClick={() =>
              setEditing({
                previous: c.name,
                draft: { name: c.name, description: c.description, text: c.template },
              })
            }
          >
            <span className="tx">
              <span className="mono">/{c.name}</span>
              {c.description && <small>{c.description}</small>}
            </span>
          </button>
          <button
            className="mini"
            aria-label={`Supprimer /${c.name}`}
            onClick={() =>
              props.onConfirm({
                title: `Supprimer /${c.name} ?`,
                text: "Son fichier est retiré du dossier du projet",
                action: "Supprimer",
                run: () =>
                  props.change({
                    type: "project.removeCommand",
                    requestId: newId(),
                    projectId: props.projectId,
                    name: c.name,
                  }),
              })
            }
          >
            Supprimer
          </button>
        </div>
      ))}
      <button
        className="it acc"
        onClick={() => setEditing({ draft: { name: "", description: "", text: "" } })}
      >
        <I n="plus" s={18} />
        <span className="tx">Nouvelle commande</span>
      </button>
    </div>
  );
}

function SkillsTab(props: {
  setup: ProjectSetup;
  projectId: string;
  change: Change;
  onConfirm: (confirm: Confirmation) => void;
}) {
  const [editing, setEditing] = useState<{ skill?: ProjectSkill; draft: Draft } | null>(null);
  const skills = props.setup.skills;
  if (editing) {
    return (
      <Editor
        label={editing.skill ? `Modifier ${editing.skill.name}` : "Nouvelle skill"}
        draft={editing.draft}
        problemFor={(name) => skillProblem(name, skills, editing.skill)}
        descriptionNeeded
        textLabel="Instructions"
        textHint="Ce que l'agent suit quand tu l'appelles avec $ ou quand elle sert."
        onSave={async (draft) => {
          await props.change({
            type: "project.saveSkill",
            requestId: newId(),
            projectId: props.projectId,
            ...(editing.skill ? { path: editing.skill.path } : {}),
            name: draft.name,
            description: draft.description.trim(),
            body: draft.text,
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="ins">
      {skills.map((s) => (
        <div key={s.path} className="it ro">
          <button
            className="mpick"
            aria-label={`Modifier ${s.name}`}
            onClick={() =>
              setEditing({
                skill: s,
                draft: { name: s.name, description: s.description, text: s.body },
              })
            }
          >
            <span className="tx">
              {s.name}
              <small>{s.description}</small>
            </span>
          </button>
          <button
            className="mini"
            aria-label={`Supprimer ${s.name}`}
            onClick={() =>
              props.onConfirm({
                title: `Supprimer ${s.name} ?`,
                text: "Son SKILL.md est retiré du projet. Les autres fichiers de son dossier restent.",
                action: "Supprimer",
                run: () =>
                  props.change({
                    type: "project.removeSkill",
                    requestId: newId(),
                    projectId: props.projectId,
                    path: s.path,
                  }),
              })
            }
          >
            Supprimer
          </button>
        </div>
      ))}
      <button
        className="it acc"
        onClick={() => setEditing({ draft: { name: "", description: "", text: "" } })}
      >
        <I n="plus" s={18} />
        <span className="tx">Nouvelle skill</span>
      </button>
    </div>
  );
}
