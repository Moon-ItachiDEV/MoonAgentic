import {
  type AgentInfo,
  type Artifact,
  type CoordinatorSettings,
  type FavoriteRef,
  type InstalledSkill,
  type Favorites,
  MAX_FALLBACK_MODELS,
  MAX_PROJECT_MEMORY,
  MAX_SETUP_FILE,
  type McpServerInfo,
  PROJECT_COLORS,
  type Project,
  type ProjectColor,
  type ProjectSetup,
  type ProjectSkill,
  type RouteKind,
  routeFor,
  type Thread,
  utf8Bytes,
  WORK_KINDS,
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
import { isDiscussionsProject } from "../default-models.ts";
import { effortOf } from "../effort.ts";
import { modelLabel, modelNameOf } from "../model-label.ts";
import { COLOR_NAME } from "../project-colors.ts";
import {
  claudeAction,
  commandProblem,
  fits,
  oneLine,
  setupSkillOf,
  skillProblem,
} from "../project-setup.ts";
import { changeSkills, InstallSkill, SkillLists, useInstalledSkills } from "./Skills.tsx";
import { KIND_LABEL, shortAgo } from "../project-threads.ts";
import { renameKey } from "../rename.ts";
import { useThreadModel } from "../thread-model.ts";
import { I } from "../v2/I.tsx";
import { ModelChip, type Route } from "../v2/ModelChip.tsx";
import { type Section, SettingsWindow } from "../v2/SettingsWindow.tsx";
import { useScreen } from "../v2/use-screen.ts";
import { BranchCleanup } from "./BranchCleanup.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";
import { scopeSwitched } from "../mcp-switch.ts";
import { LookMenu } from "./NewProjectDialog.tsx";
import {
  findProjectIcons,
  PROJECT_ICON_PREFIX,
  PROJECT_ICONS,
  projectIconName,
} from "../project-icons.ts";
import { ProjectIcon } from "./ProjectIcon.tsx";

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type ProjectSection = "general" | "memory" | "env" | "usage" | "advanced";
const SECTIONS: Section<ProjectSection>[] = [
  { id: "general", label: "Général", icon: "gear" },
  { id: "memory", label: "Mémoire", icon: "book" },
  { id: "env", label: "Environnement", icon: "server" },
  { id: "usage", label: "Utilisation", icon: "chart" },
  { id: "advanced", label: "Avancée", icon: "wrench" },
];

/** A page of its own inside a section, with a way back to it. */
type Sub = "fallback" | "icon" | null;

/** A project's fallback models while none were set: off, coming back once the quota is reset. */
const NO_FALLBACK = { on: false, back: true, models: [] as FavoriteRef[] };

/** The name a model goes by, from its agent's list, or its id while that is not known. */
const modelName = (agents: AgentInfo[], ref: FavoriteRef) => {
  const known = agents.find((a) => a.id === ref.agentId)?.models?.find((m) => m.id === ref.model);
  return known ? modelLabel(known) : ref.model;
};

/** What a route is called: its model, or its agent while it has none. */
export const routeName = (agents: AgentInfo[], route: Route | undefined): string | undefined => {
  if (!route) return undefined;
  const agent = agents.find((a) => a.id === route.agentId);
  return modelNameOf(agent?.models, route.model) ?? agent?.name ?? route.agentId;
};

/** A size in kilobytes, as « 0,1 / 256 Ko » shows it. */
const kb = (bytes: number) =>
  (bytes / 1024).toLocaleString("fr-FR", { maximumFractionDigits: bytes < 10_240 ? 1 : 0 });

/** Thousands as « 12,4 k ». */
const thousands = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k` : String(n);

/**
 * A project's settings, in sections as the Claude app shows them: Général (name, icon, models,
 * archive), Mémoire (AGENTS.md, shared memory, skills, commands), Environnement (repository,
 * MCP servers), Utilisation (its threads and what they made) and Avancée (pause, restart,
 * lock). A window on an iPad or a computer, a sheet with the sections as pills on a phone.
 */
export function ProjectSettings(props: {
  project: Project;
  open: boolean;
  /** The section to open on. */
  section?: ProjectSection;
  coordinator: Thread | undefined;
  /** The project's threads, its coordinator left out. */
  threads: Thread[];
  agents: AgentInfo[];
  favorites: Favorites;
  settings: CoordinatorSettings;
  mcpServers: McpServerInfo[];
  projects: Project[];
  onClose: () => void;
  onLock: () => void;
  onRemove: () => void;
  onOpenThread: (id: string) => void;
  onOpenMcp: () => void;
}) {
  const { project, open } = props;
  const projectId = project.id;
  const [section, setSection] = useState<ProjectSection>(props.section ?? "general");
  const [sub, setSub] = useState<Sub>(null);
  const [setup, setSetup] = useState<ProjectSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSection(props.section ?? "general");
    setSub(null);
    setLoadError(undefined);
    let live = true;
    connection
      .ask({ type: "project.setup", requestId: newId(), projectId })
      .then((reply) => live && setSetup(reply.setup))
      .catch((e: unknown) => live && setLoadError(why(e)));
    return () => {
      live = false;
    };
    // Read again each time it opens: the folder may have changed meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  /** Sends a change and shows the folder as the server reads it after. */
  const change: Change = async (message) => {
    const reply = await connection.ask(message);
    setSetup(reply.setup);
  };
  /** Reads the folder again, after a skill was installed, moved or removed. */
  const reload = () => {
    connection
      .ask({ type: "project.setup", requestId: newId(), projectId })
      .then((reply) => setSetup(reply.setup))
      .catch(() => {});
  };
  const pick = (next: ProjectSection) => {
    setSub(null);
    setSection(next);
  };

  let body: ReactNode;
  if (sub === "fallback") {
    body = (
      <>
        <Back label="Général" onBack={() => setSub(null)} />
        <h2>Modèle de secours</h2>
        <FallbackPane
          agents={props.agents}
          fallback={project.quota?.fallback ?? NO_FALLBACK}
          onChange={(fallback) =>
            connection.send({ type: "project.setQuotaRules", projectId, fallback })
          }
        />
      </>
    );
  } else if (sub === "icon") {
    body = (
      <>
        <Back label="Général" onBack={() => setSub(null)} />
        <IconPane project={project} />
      </>
    );
  } else if (section === "general") {
    body = (
      <General
        {...props}
        onFallback={() => setSub("fallback")}
        onIcons={() => setSub("icon")}
        onConfirm={setConfirm}
      />
    );
  } else if (section === "memory") {
    body = (
      <Memory
        projectId={projectId}
        setup={setup}
        loadError={loadError}
        change={change}
        onReload={reload}
        onConfirm={setConfirm}
      />
    );
  } else if (section === "env") {
    body = (
      <Environment
        project={project}
        projects={props.projects}
        mcpServers={props.mcpServers}
        onBranches={() => setCleaning(true)}
        onOpenMcp={props.onOpenMcp}
      />
    );
  } else if (section === "usage") {
    body = (
      <Usage
        project={project}
        open={open}
        threads={props.threads}
        agents={props.agents}
        onOpenThread={props.onOpenThread}
      />
    );
  } else {
    body = (
      <Advanced
        project={project}
        coordinator={props.coordinator}
        threads={props.threads}
        agents={props.agents}
        onLock={props.onLock}
      />
    );
  }

  return (
    <>
      <SettingsWindow
        open={open}
        onClose={props.onClose}
        title="Paramètres du projet"
        sections={SECTIONS}
        section={section}
        onSection={pick}
        className="pset"
      >
        {body}
      </SettingsWindow>
      <BranchCleanup open={cleaning} project={project} onClose={() => setCleaning(false)} />
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

/** A way back from a page of its own to its section. */
function Back(props: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="ppback" onClick={props.onBack}>
      <I n="back" s={15} />
      {props.label}
    </button>
  );
}

/** One setting on a line: its name, maybe a second line, and what changes it on the right. */
export function Row(props: {
  label: ReactNode;
  sub?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className={`ppr${props.className ? ` ${props.className}` : ""}`} style={props.style}>
      <div className="ppl">
        {props.label}
        {props.sub && <small>{props.sub}</small>}
      </div>
      {props.children}
    </div>
  );
}

/** An on/off switch at the end of a line. */
export function Toggle(props: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className="tog"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/** The project's name, saved when it is left or on Enter; Escape puts the saved one back. */
function NameField(props: { project: Project; onIcons: () => void }) {
  const { project } = props;
  const { roomy } = useScreen();
  const [name, setName] = useState(project.name);
  const [look, setLook] = useState(false);
  const icon = useRef<HTMLButtonElement>(null);
  useEffect(() => setName(project.name), [project.name]);
  const save = () => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) return setName(project.name);
    if (clean !== project.name) {
      connection.send({ type: "project.rename", projectId: project.id, name: clean });
    }
  };
  return (
    <label className={`ppnm${project.color ? ` pc-${project.color}` : ""}`}>
      <button
        ref={icon}
        type="button"
        className="ppic"
        aria-label="Icône et couleur"
        aria-expanded={look}
        onClick={(e) => {
          e.preventDefault();
          if (roomy) setLook((on) => !on);
          else props.onIcons();
        }}
      >
        <ProjectIcon project={project} size={18} />
      </button>
      <input
        aria-label="Nom du projet"
        value={name}
        maxLength={120}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          // Not while a word is being composed (Japanese, Chinese…): that Enter ends the word.
          const does = renameKey({ key: e.key, isComposing: e.nativeEvent.isComposing });
          if (does === "save") e.currentTarget.blur();
          if (does === "cancel") {
            e.preventDefault();
            e.stopPropagation();
            setName(project.name);
          }
        }}
      />
      {look && (
        <LookMenu
          anchor={icon}
          icon={project.icon ?? ""}
          color={project.color ?? null}
          onIcon={(next) => sendLook(project.id, next, project.color)}
          onColor={(next) => sendLook(project.id, project.icon, next ?? undefined)}
          onClose={() => setLook(false)}
        />
      )}
    </label>
  );
}

function General(props: {
  project: Project;
  coordinator: Thread | undefined;
  agents: AgentInfo[];
  favorites: Favorites;
  settings: CoordinatorSettings;
  onFallback: () => void;
  onIcons: () => void;
  onConfirm: (confirm: Confirmation) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { project, coordinator, agents, favorites, settings } = props;
  const { roomy } = useScreen();
  const projectId = project.id;
  const [kinds, setKinds] = useState(false);
  const setCoordinator = useThreadModel(coordinator);
  const own = settings.projectRoutes?.[projectId] ?? {};
  const fallback = project.quota?.fallback ?? NO_FALLBACK;
  const general = (kind: RouteKind) =>
    routeFor({ routes: settings.routes }, undefined, kind === "default" ? undefined : kind);
  const coordinatorName = coordinator
    ? (routeName(agents, coordinator) ?? "Coordinateur")
    : undefined;
  const setRoute = (kind: RouteKind, route: Route | undefined) =>
    connection.send({
      type: "coordinator.setRoute",
      kind,
      projectId,
      ...(route ? { agentId: route.agentId } : {}),
      ...(route?.model ? { model: route.model } : {}),
      ...(route?.settings ? { settings: route.settings } : {}),
    });
  const routeChip = (kind: RouteKind, label: string) => {
    // What applies while the project sets nothing: the general route, or its own default.
    const inherited =
      kind === "default"
        ? (routeName(agents, general("default")) ?? coordinatorName ?? "Coordinateur")
        : (routeName(agents, own.default ?? general(kind)) ?? coordinatorName ?? "Coordinateur");
    return (
      <ModelChip
        label={label}
        agents={agents}
        favorites={favorites}
        value={own[kind]}
        unset={inherited}
        clear={kind === "default" ? "Réglage général" : "Comme les fils"}
        row={!roomy}
        onChange={(route) => setRoute(kind, route)}
      />
    );
  };
  const fallbackText =
    !fallback.on || !fallback.models.length
      ? "Non"
      : modelName(agents, fallback.models[0]!) +
        (fallback.models.length > 1 ? ` +${fallback.models.length - 1}` : "");
  const running = coordinator?.status === "running" || coordinator?.status === "waiting";
  const coordinatorEffort =
    coordinator &&
    effortOf(
      agents.find((a) => a.id === coordinator.agentId),
      coordinator.model,
      coordinator.settings,
    );

  const models = roomy ? (
    <>
      <h4>Modèles</h4>
      <Row label="Coordinateur">
        {coordinator ? (
          <ModelChip
            label="Coordinateur"
            agents={agents}
            favorites={favorites}
            value={{
              agentId: coordinator.agentId,
              ...(coordinator.model ? { model: coordinator.model } : {}),
              ...(coordinatorEffort
                ? { settings: { [coordinatorEffort.setting.id]: coordinatorEffort.value } }
                : {}),
            }}
            disabled={running}
            onChange={setCoordinator}
          />
        ) : (
          <span className="ppmu">Pas encore lancé</span>
        )}
      </Row>
      <Row label="Fils de discussion">{routeChip("default", "Fils de discussion")}</Row>
      <button
        type="button"
        className="ppkinds"
        aria-expanded={kinds}
        onClick={() => setKinds((on) => !on)}
      >
        Par type de travail
        <span className={`pprc${kinds ? " on" : ""}`}>
          <I n="right" s={13} />
        </span>
      </button>
      {kinds &&
        WORK_KINDS.map((kind, i) => (
          <Row
            key={kind}
            label={KIND_LABEL[kind]}
            className="sub pprt in"
            style={{ "--i": i } as React.CSSProperties}
          >
            {routeChip(kind, `Fils · ${KIND_LABEL[kind]}`)}
          </Row>
        ))}
      <Row label="Modèle de secours">
        <button
          type="button"
          className="ppch"
          aria-label={`Modèle de secours : ${fallbackText}`}
          onClick={props.onFallback}
        >
          {fallbackText}
          <span className="pcv">
            <I n="right" s={13} />
          </span>
        </button>
      </Row>
      <Row label="Reprendre automatiquement les fils quand les quotas sont remis à zéro">
        <Toggle
          on={!!project.quota?.resume}
          label="Reprendre les fils quand les quotas sont remis à zéro"
          onChange={(resume) =>
            connection.send({ type: "project.setQuotaRules", projectId, resume })
          }
        />
      </Row>
    </>
  ) : (
    <>
      <div className="gl2">Modèles</div>
      <div className="ins">
        {coordinator ? (
          <ModelChip
            row
            label="Coordinateur"
            agents={agents}
            favorites={favorites}
            value={{
              agentId: coordinator.agentId,
              ...(coordinator.model ? { model: coordinator.model } : {}),
              ...(coordinatorEffort
                ? { settings: { [coordinatorEffort.setting.id]: coordinatorEffort.value } }
                : {}),
            }}
            disabled={running}
            onChange={setCoordinator}
          />
        ) : null}
        {routeChip("default", "Fils de discussion")}
        <button type="button" className="it" onClick={() => setKinds((on) => !on)}>
          <span className="tx">Par type de travail</span>
          <span className={`pprc${kinds ? " on" : ""}`}>
            <I n="right" s={15} />
          </span>
        </button>
        {kinds &&
          WORK_KINDS.map((kind) => <div key={kind}>{routeChip(kind, KIND_LABEL[kind])}</div>)}
        <button type="button" className="it" onClick={props.onFallback}>
          <span className="tx">Modèle de secours</span>
          <span className="rt">
            {fallbackText}
            <I n="right" s={15} />
          </span>
        </button>
        <div className="it ro">
          <span className="tx">Reprendre les fils quand les quotas sont remis à zéro</span>
          <Toggle
            on={!!project.quota?.resume}
            label="Reprendre les fils quand les quotas sont remis à zéro"
            onChange={(resume) =>
              connection.send({ type: "project.setQuotaRules", projectId, resume })
            }
          />
        </div>
      </div>
    </>
  );

  const archive = () =>
    connection.send({ type: "project.setArchived", projectId, archived: !project.archived });
  const discussions = isDiscussionsProject(project);
  return (
    <>
      {roomy && <h2>Général</h2>}
      {roomy ? (
        <Row label="Nom et icône">
          <NameField project={project} onIcons={props.onIcons} />
        </Row>
      ) : (
        <>
          <div className="gl2">Nom et icône</div>
          <NameField project={project} onIcons={props.onIcons} />
        </>
      )}
      {models}
      {roomy ? (
        <>
          <div className="pphr" />
          {!discussions && (
            <Row label={project.archived ? "Sortir des archives" : "Archiver le projet"}>
              <button type="button" className="ppbt" onClick={archive}>
                <I n="archive" s={15} />
                {project.archived ? "Sortir" : "Archiver"}
              </button>
            </Row>
          )}
          <h4>Zone de danger</h4>
          <Row label="Retirer de MoonAgentic">
            <button
              type="button"
              className="ppbt red"
              onClick={() => {
                props.onClose();
                props.onRemove();
              }}
            >
              <I n="x" s={14} />
              Retirer
            </button>
          </Row>
        </>
      ) : (
        <div className="ins">
          {!discussions && (
            <button type="button" className="it" onClick={archive}>
              <span className="ic">
                <I n="archive" s={17} />
              </span>
              <span className="tx">
                {project.archived ? "Sortir des archives" : "Archiver le projet"}
              </span>
            </button>
          )}
          <button
            type="button"
            className="it dng"
            onClick={() => {
              props.onClose();
              props.onRemove();
            }}
          >
            <span className="ic">
              <I n="x" s={17} />
            </span>
            <span className="tx">Retirer de MoonAgentic</span>
          </button>
        </div>
      )}
    </>
  );
}

/** A text kept by MoonAgentic or in the folder, saved by its own button once changed. */
function TextSetting(props: {
  title: string;
  /** On the right of its title: its file, or when it was last written. */
  aside?: ReactNode;
  label: string;
  saved: string;
  disabled: boolean;
  placeholder: string;
  max: number;
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const now = text ?? props.saved;
  const bytes = utf8Bytes(now);
  const dirty = text !== undefined && text.replace(/\r\n/g, "\n").trim() !== props.saved.trim();
  const save = async () => {
    if (text === undefined || busy || bytes > props.max) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSave(text);
      setText(undefined);
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h4>
        {props.title}
        {props.aside && <span className="pps">{props.aside}</span>}
      </h4>
      <textarea
        className="ppta"
        aria-label={props.label}
        value={now}
        disabled={props.disabled}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="ppct">
        {error && <span className="mer">{error}</span>}
        <span className={bytes > props.max ? "mer" : undefined}>
          {kb(bytes)} / {kb(props.max)} Ko
        </span>
        {dirty && (
          <>
            <button type="button" className="ppbt sm" onClick={() => setText(undefined)}>
              Annuler
            </button>
            <button
              type="button"
              className="ppbt sm on"
              disabled={busy || bytes > props.max}
              onClick={() => void save()}
            >
              Enregistrer
            </button>
          </>
        )}
      </div>
    </>
  );
}

function Memory(props: {
  projectId: string;
  setup: ProjectSetup | undefined;
  loadError: string | undefined;
  change: Change;
  onReload: () => void;
  onConfirm: (confirm: Confirmation) => void;
}) {
  const { setup, projectId, change } = props;
  const { roomy } = useScreen();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const waiting = props.loadError ?? "Lecture du dossier…";
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
  return (
    <>
      {roomy && <h2>Mémoire</h2>}
      {setup?.rules.tooBig ? (
        <>
          <h4>Consignes pour les agents</h4>
          <Row label="AGENTS.md" sub="Trop gros pour être modifié ici" />
        </>
      ) : (
        <TextSetting
          key={`rules${setup ? "" : "-wait"}`}
          title="Consignes pour les agents"
          aside={
            <span className="ppfile">
              <I n="file" s={13} />
              AGENTS.md
            </span>
          }
          label="Contenu de AGENTS.md"
          saved={setup?.rules.text ?? ""}
          disabled={!setup}
          placeholder={setup ? "AGENTS.md" : waiting}
          max={MAX_SETUP_FILE}
          onSave={(text) =>
            change({ type: "project.saveRules", requestId: newId(), projectId, text })
          }
        />
      )}
      {setup && !setup.rules.tooBig && (
        <Row
          label="Claude Code"
          sub={
            setup.claude === "imports"
              ? "Lit AGENTS.md par CLAUDE.md"
              : setup.claude === "missing"
                ? "Lit CLAUDE.md, pas AGENTS.md"
                : "CLAUDE.md n'importe pas AGENTS.md"
          }
        >
          {setup.claude === "imports" ? (
            <span className="ppok">Relié</span>
          ) : (
            setup.rules.exists && (
              <button
                type="button"
                className="ppbt"
                title={claudeAction(setup.claude)}
                disabled={busy}
                onClick={() => void link()}
              >
                Relier
              </button>
            )
          )}
        </Row>
      )}
      {setup?.uncommitted && (
        <Row
          label="Pas encore commité"
          sub={<span className="mono">{setup.uncommitted.join(", ")}</span>}
        />
      )}
      {error && <p className="snone mer">{error}</p>}
      <TextSetting
        key={`memory${setup ? "" : "-wait"}`}
        title="Mémoire partagée"
        aside={
          setup?.memory.updatedAt ? `Mise à jour ${agoText(setup.memory.updatedAt)}` : undefined
        }
        label="Mémoire partagée du projet"
        saved={setup?.memory.text ?? ""}
        disabled={!setup}
        placeholder={setup ? "Décisions, conventions, pièges connus" : waiting}
        max={MAX_PROJECT_MEMORY}
        onSave={(text) =>
          change({ type: "project.saveMemory", requestId: newId(), projectId, text })
        }
      />
      <h4>Skills</h4>
      {setup ? (
        <SkillsTab setup={setup} projectId={projectId} change={change} onReload={props.onReload} />
      ) : (
        <p className="snone">{waiting}</p>
      )}
      <h4>Commandes</h4>
      {setup ? (
        <CommandsTab
          setup={setup}
          projectId={projectId}
          change={change}
          onConfirm={props.onConfirm}
        />
      ) : (
        <p className="snone">{waiting}</p>
      )}
    </>
  );
}

/** « il y a 2 h », « hier »… */
const agoText = (at: number) => {
  const said = shortAgo(at, Date.now());
  return /^\d/.test(said) ? `il y a ${said}` : said;
};

/** Whether the server reaches this project's threads, and the scope to send to change that. */
const inProject = (server: McpServerInfo, projectId: string) =>
  !server.projectIds || server.projectIds.includes(projectId);

function Environment(props: {
  project: Project;
  projects: Project[];
  mcpServers: McpServerInfo[];
  onBranches: () => void;
  onOpenMcp: () => void;
}) {
  const { project } = props;
  const { roomy } = useScreen();
  const folder = project.path.split(/[\\/]/).filter(Boolean).pop() ?? project.path;
  const toggle = (server: McpServerInfo, on: boolean) =>
    connection.send({
      type: "mcp.setScope",
      id: server.id,
      projectIds: scopeSwitched(server, project.id, on, props.projects),
      allRoles: !!server.allRoles,
    });
  const scope = (server: McpServerInfo) =>
    !server.projectIds
      ? "Tous les projets"
      : server.projectIds.length === 0
        ? "Aucun projet"
        : server.projectIds.length === 1 && server.projectIds[0] === project.id
          ? "Ce projet"
          : `${server.projectIds.length} projets`;
  return (
    <>
      {roomy && <h2>Environnement</h2>}
      <h4>Dépôt</h4>
      <div className="ppbox">
        <div className="ppi">
          <span className="ppii">
            <I n={project.git ? "branch" : "folder"} s={16} />
          </span>
          <span className="ppit">
            {folder}
            <small className="mono">{project.path}</small>
          </span>
        </div>
        {project.git && (
          <button type="button" className="ppi" onClick={props.onBranches}>
            <span className="ppii">
              <I n="branch" s={16} />
            </span>
            <span className="ppit">Branches</span>
            <span className="ppir">
              <I n="right" s={13} />
            </span>
          </button>
        )}
        {project.git && (
          <div className="ppi">
            <span className="ppii">
              <I n="merge" s={16} />
            </span>
            <span className="ppit">Supprimer la branche après la fusion</span>
            <Toggle
              on={project.deleteMerged !== false}
              label="Supprimer la branche après la fusion"
              onChange={(on) =>
                connection.send({ type: "project.setDeleteMerged", projectId: project.id, on })
              }
            />
          </div>
        )}
      </div>
      <h4>Serveurs MCP</h4>
      <div className="ppbox">
        {props.mcpServers.map((server) => (
          <div className="ppi" key={server.id}>
            <span className="ppii">
              <I n="plug" s={16} />
            </span>
            <span className="ppit">
              {server.name}
              <small>{server.enabled ? scope(server) : `${scope(server)} · désactivé`}</small>
            </span>
            {server.enabled ? (
              <Toggle
                on={inProject(server, project.id)}
                label={`${server.name} dans ce projet`}
                onChange={(on) => toggle(server, on)}
              />
            ) : (
              <span className="ppir">
                <span className="ppst off" />
                Désactivé
              </span>
            )}
          </div>
        ))}
        <button type="button" className="ppi add" onClick={props.onOpenMcp}>
          <span className="ppii">
            <I n="plus" s={16} />
          </span>
          <span className="ppit">Ajouter un serveur</span>
        </button>
      </div>
    </>
  );
}

/** What a thread is at, in a word, and its dot's tint. */
const stateOf = (t: Thread): [string, string] =>
  t.archived
    ? ["terminé", "ok"]
    : t.status === "waiting"
      ? ["t'attend", "w"]
      : t.status === "running"
        ? ["en cours", "ac"]
        : t.status === "error"
          ? ["erreur", "er"]
          : ["au repos", ""];

/** How many threads the table shows before « Afficher les autres ». */
const SHOWN_THREADS = 5;

function Usage(props: {
  project: Project;
  open: boolean;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
}) {
  const { threads, agents } = props;
  const { roomy } = useScreen();
  const [all, setAll] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  useEffect(() => {
    if (!props.open) return;
    let live = true;
    connection
      // This project's only: the others' folders are not looked at.
      .ask({ type: "artifacts.list", requestId: newId(), projectId: props.project.id })
      .then((reply) => live && setArtifacts(reply.artifacts))
      .catch(() => live && setArtifacts(null));
    return () => {
      live = false;
    };
  }, [props.open, props.project.id]);
  const mine = artifacts?.filter((a) => a.projectId === props.project.id);
  const done = threads.filter((t) => t.archived).length;
  const atWork = threads.filter(
    (t) => !t.archived && (t.status === "running" || t.status === "waiting"),
  ).length;
  const prs = threads.filter((t) => t.pr);
  const added = prs.reduce((n, t) => n + (t.pr?.additions ?? 0), 0);
  const removed = prs.reduce((n, t) => n + (t.pr?.deletions ?? 0), 0);
  const counted = prs.some((t) => t.pr?.additions !== undefined);
  const made = (t: Thread) => {
    const parts: string[] = [];
    if (t.pr) {
      parts.push(`PR #${t.pr.number}${t.pr.state === "merged" ? " fusionnée" : ""}`);
      if (t.pr.additions !== undefined) parts.push(`+${t.pr.additions} −${t.pr.deletions ?? 0}`);
    }
    const files = mine?.filter((a) => a.threadId === t.id).length ?? 0;
    if (files) parts.push(`${files} artefact${files > 1 ? "s" : ""}`);
    return parts.join(" · ") || "—";
  };
  // The threads at work first, then the most recent.
  const sorted = [...threads].sort(
    (a, b) => Number(!!a.archived) - Number(!!b.archived) || b.updatedAt - a.updatedAt,
  );
  const shown = all ? sorted : sorted.slice(0, SHOWN_THREADS);
  const modelOf = (t: Thread) =>
    routeName(agents, { agentId: t.agentId, ...(t.model ? { model: t.model } : {}) }) ?? "";
  return (
    <>
      {roomy && <h2>Utilisation</h2>}
      <div className="ppstats">
        <div>
          <b>{done}</b>
          <span>Fils terminés</span>
        </div>
        <div>
          <b>{atWork}</b>
          <span>Fils en cours</span>
        </div>
        <div>
          <b>{prs.length}</b>
          <span>Pull requests</span>
        </div>
        {counted && (
          <div className="wide2">
            <b>
              <span className="pl">+{thousands(added)}</span>{" "}
              <span className="mn">−{thousands(removed)}</span>
            </b>
            <span>Modifications du code</span>
          </div>
        )}
        {mine && (
          <div>
            <b>{mine.length}</b>
            <span>Artefacts</span>
          </div>
        )}
      </div>
      {threads.length > 0 && (
        <>
          <h4>Fils de discussion</h4>
          {roomy ? (
            <table className="pptb">
              <thead>
                <tr>
                  <th>Fil</th>
                  <th>Réalisations</th>
                  <th>Modèle</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const [state, tint] = stateOf(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <a
                          href={`#/thread/${t.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            props.onOpenThread(t.id);
                          }}
                        >
                          {t.title}
                        </a>
                      </td>
                      <td className="mu">{made(t)}</td>
                      <td className="mu">{modelOf(t)}</td>
                      <td>
                        <span className={`st ${tint}`}>
                          <i />
                          {state}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="ins ppthr">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="it"
                  onClick={() => props.onOpenThread(t.id)}
                >
                  <span className="tx">
                    {t.title}
                    <small>
                      {[made(t), modelOf(t), stateOf(t)[0]]
                        .filter((x) => x && x !== "—")
                        .join(" · ")}
                    </small>
                  </span>
                  <I n="right" s={15} />
                </button>
              ))}
            </div>
          )}
          {!all && sorted.length > SHOWN_THREADS && (
            <button type="button" className="ppmore" onClick={() => setAll(true)}>
              Afficher les {sorted.length - SHOWN_THREADS} autres
            </button>
          )}
        </>
      )}
    </>
  );
}

function Advanced(props: {
  project: Project;
  coordinator: Thread | undefined;
  threads: Thread[];
  agents: AgentInfo[];
  onLock: () => void;
}) {
  const { project, coordinator } = props;
  const { roomy } = useScreen();
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string>();
  const atWork = props.threads.filter((t) => !t.archived && t.status === "running").length;
  const coordinatorBusy = coordinator?.status === "running" || coordinator?.status === "waiting";
  const restart = async () => {
    setRestarting(true);
    setError(undefined);
    try {
      await connection.ask(
        { type: "coordinator.restart", requestId: newId(), projectId: project.id },
        30_000,
      );
    } catch (e) {
      setError(why(e));
    } finally {
      setRestarting(false);
    }
  };
  return (
    <>
      {roomy && <h2>Avancée</h2>}
      <div className="ppbox ppadv">
        <div className="ppi">
          <span className="ppii">
            <I n={project.paused ? "play" : "pause"} s={16} />
          </span>
          <span className="ppit">
            {project.paused ? "Reprendre le projet" : "Mettre le projet en pause"}
            <small>
              <span className={`ppst${project.paused ? " off" : ""}`} />{" "}
              {project.paused
                ? "En pause"
                : `Actif${atWork ? ` · ${atWork} fil${atWork > 1 ? "s" : ""} au travail` : ""}`}
            </small>
          </span>
          <button
            type="button"
            className={`ppbt act${project.paused ? " on" : ""}`}
            onClick={() =>
              connection.send({
                type: "project.setPaused",
                projectId: project.id,
                paused: !project.paused,
              })
            }
          >
            {project.paused ? "Reprendre" : "Pause"}
          </button>
        </div>
        <div className="ppi">
          <span className="ppii">
            <I n="refresh" s={16} />
          </span>
          <span className="ppit">
            Redémarrer le coordinateur
            <small>
              {coordinator
                ? `${routeName(props.agents, coordinator) ?? "Coordinateur"} · ${coordinatorBusy ? "au travail" : "au repos"}`
                : "Pas encore lancé"}
            </small>
          </span>
          <button
            type="button"
            className="ppbt act"
            disabled={!coordinator || restarting}
            onClick={() => void restart()}
          >
            {restarting ? "Redémarrage…" : "Redémarrer"}
          </button>
        </div>
        <div className="ppi">
          <span className="ppii">
            <I n="lock" s={16} />
          </span>
          <span className="ppit">
            Verrouiller par code
            <small>Code de l'app</small>
          </span>
          <button type="button" className="ppbt act" onClick={props.onLock}>
            Verrouiller
          </button>
        </div>
      </div>
      {error && <p className="snone mer">{error}</p>}
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
  /** Reads the project's folder again. */
  onReload: () => void;
}) {
  const [editing, setEditing] = useState<{ skill?: ProjectSkill; draft: Draft } | null>(null);
  const projects = useSyncExternalStore(connection.subscribe, connection.getState).projects;
  const { skills: installed, error } = useInstalledSkills();
  const skills = props.setup.skills;
  // A skill installed, moved or removed here changes the folder: it is read again, so the
  // skill just installed can be written from here at once.
  const reload = useRef(props.onReload);
  reload.current = props.onReload;
  useEffect(() => {
    if (installed) reload.current();
  }, [installed]);
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
          // The list of installed skills shows it too.
          void changeSkills(() => connection.ask({ type: "skills.list", requestId: newId() }));
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }
  // A skill of the project's own folders can be written here.
  const editable = (s: InstalledSkill) => {
    const own = setupSkillOf(s, props.projectId, skills);
    if (!own) return undefined;
    return () =>
      setEditing({
        skill: own,
        draft: { name: own.name, description: own.description, text: own.body },
      });
  };
  return (
    <>
      {error && <p className="snone">{error}</p>}
      {installed && (
        <SkillLists
          skills={installed}
          projects={projects}
          projectId={props.projectId}
          editable={editable}
        />
      )}
      <div className="ins">
        <InstallSkill projects={projects} installed={installed ?? []} projectId={props.projectId} />
        <button
          className="it acc"
          onClick={() => setEditing({ draft: { name: "", description: "", text: "" } })}
        >
          <I n="edit" s={18} />
          <span className="tx">Nouvelle skill</span>
        </button>
      </div>
    </>
  );
}
