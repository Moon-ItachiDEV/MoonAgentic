import {
  type AgentInfo,
  type CoordinatorSettings,
  DEFAULT_MAX_TURNS,
  DEFAULT_PARALLEL,
  MAX_MAX_TURNS,
  MAX_PARALLEL,
  type Favorites,
  type HermesStatus,
  type McpServerInfo,
  type Project,
  type TeamMember,
  ROUTE_KINDS,
  type RouteKind,
} from "@moonagentic/protocol";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { modelNameOf } from "../model-label.ts";
import { KIND_LABEL } from "../project-threads.ts";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import {
  disableNotifications,
  enableNotifications,
  notificationPermission,
  notificationSupport,
  notificationsOn,
  showNotice,
} from "../notifications.ts";
import { appLock, LOCK_AFTER, type LockAfter } from "../app-lock.ts";
import { lockSheet, toggleLock } from "../lock.ts";
import { lockApp } from "./AppLock.tsx";
import { setDefault, useDefaults } from "../defaults.ts";
import { copyDiagnosticText, downloadDiagnosticText } from "../diagnostics.ts";
import { disablePush, enablePush, pushOn, pushReached, pushSupport } from "../push.ts";
import type { PushSupport } from "../push-device.ts";
import type { SettingsSection } from "../router.ts";
import { mcpAgentsLabel, mcpScopeLabel, scopeOf } from "../mcp-scope.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { matchSections } from "../settings-search.ts";
import { formatPercent, tightest } from "../quotas.ts";
import { useQuotas } from "../use-quotas.ts";
import { readTheme, setTheme, subscribeTheme, type Theme } from "../theme.ts";
import { I } from "../v2/I.tsx";
import type { IconName } from "../v2/sprite.ts";
import { Sheet } from "../v2/Sheet.tsx";
import { AppUpdateSettings, useApp } from "./AppUpdate.tsx";
import { openUpdateCard, pillOf, updateShown } from "../app-update.ts";
import type { AppInfo } from "@moonagentic/protocol";
import { RoleMascots } from "./RoleMascots.tsx";
import { MascotSettings } from "./MascotSettings.tsx";
import { ModelFavorites } from "./ModelFavorites.tsx";
import { RemoteAccess } from "./RemoteAccess.tsx";
import { HermesSettings } from "./HermesSettings.tsx";
import { Subscriptions } from "./Subscriptions.tsx";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { useHermesState } from "../hermes.ts";
import { TeamPresets } from "./TeamPresets.tsx";
import {
  AgentAddSheet,
  AgentSheet,
  AgentState,
  GithubSheet,
  useAgentChecks,
  useGithubStatus,
} from "./Connections.tsx";
import { McpAddSheet, McpServerSheet } from "./McpSheets.tsx";
import { SkillsSettings } from "./Skills.tsx";

/** The sections, in the groups the list shows them in. */
const GROUPS: { id: SettingsSection; label: string; icon: IconName | "half" | "$" }[][] = [
  [
    { id: "general", label: "Général", icon: "gear" },
    { id: "appearance", label: "Apparence", icon: "half" },
    { id: "mascots", label: "Mascottes", icon: "moon" },
  ],
  [
    { id: "agents", label: "Agents", icon: "shield" },
    { id: "models", label: "Modèles", icon: "star" },
    { id: "subscriptions", label: "Abonnements", icon: "gauge" },
  ],
  [
    { id: "coordinator", label: "Coordinateur", icon: "branch" },
    { id: "teams", label: "Équipes", icon: "users" },
    { id: "mcp", label: "Connexions et MCP", icon: "plug" },
    { id: "skills", label: "Skills", icon: "$" },
  ],
  [
    { id: "remote", label: "Accès distant", icon: "wifi" },
    { id: "hermes", label: "Hermes · Discord", icon: "tbubble" },
  ],
];
const SECTIONS = GROUPS.flat();
const THEMES: Record<Theme, string> = { system: "Système", light: "Clair", dark: "Sombre" };

/** One line of a group: what it sets, a word on its state when it has one, then its control. */
function Row(props: { title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="it ro">
      <span className="tx">
        {props.title}
        {props.text && <small>{props.text}</small>}
      </span>
      {props.children}
    </div>
  );
}

/** Foot of the settings list: a badge when a newer version is there, opening the update card. */
function VersionBadge(props: { app: AppInfo }) {
  if (!updateShown(props.app)) return <> · À jour</>;
  const pill = pillOf(props.app);
  return (
    <button
      className={`upbg press ${pill.tone}`}
      aria-haspopup="dialog"
      onClick={() => openUpdateCard()}
    >
      <svg className="upi" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="r" cx="8" cy="8" r="6.5" />
        <path className="a" d="M8 11.2V5M5.4 7.5 8 4.9l2.6 2.6" />
      </svg>
      {pill.text}
      {pill.tail && <span className="tl">{pill.tail}</span>}
    </button>
  );
}

function Toggle(props: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      className="tog"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/** A number set with − and +, between its bounds. */
function Stepper(props: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="stpr" role="group" aria-label={props.label}>
      <button
        aria-label="Moins"
        disabled={props.value <= 1}
        onClick={() => props.onChange(props.value - 1)}
      >
        −
      </button>
      <b key={props.value} className="bump">
        {props.value}
      </b>
      <button
        aria-label="Plus"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
      >
        +
      </button>
    </span>
  );
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Web Push for this device: the same notices, even with MoonAgentic closed. Shown as the
 * server sees it: on only when it really reaches this browser.
 */
function PushRow() {
  const support = pushSupport();
  // The desktop app goes on beside the clock when its window is closed: nothing to set.
  if (support === "desktop") return null;
  return <BrowserPushRow support={support} />;
}

function BrowserPushRow({ support }: { support: Exclude<PushSupport, "desktop"> }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(pushOn());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pushOn()) return;
    let live = true;
    pushReached().then(
      (reached) => {
        if (!live) return;
        setOn(reached);
        setBusy(false);
        if (!reached) setError("Ce navigateur n'est plus abonné");
      },
      (e: unknown) => {
        if (!live) return;
        setBusy(false);
        setError(reason(e));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const text =
    support === "unsupported" ? "Ouvre MoonAgentic depuis l'écran d'accueil" : (error ?? undefined);
  return (
    <Row title="Même quand l'app est fermée" text={text}>
      <Toggle
        label="Recevoir quand l'app est fermée"
        on={on}
        disabled={support !== "ok" || busy}
        onChange={(next) => {
          setBusy(true);
          setError(null);
          (next ? enablePush() : disablePush()).then(
            () => {
              setOn(next);
              setBusy(false);
            },
            (e: unknown) => {
              setBusy(false);
              setError(reason(e));
            },
          );
        }}
      />
    </Row>
  );
}

/** Browser notifications for this device: what is shown is what the browser really allows. */
function NotificationsRow() {
  const support = notificationSupport();
  const [on, setOn] = useState(notificationsOn);
  const [permission, setPermission] = useState(notificationPermission);
  const [tried, setTried] = useState<"sent" | "refused" | null>(null);
  const text =
    support === "insecure"
      ? "HTTPS requis à cette adresse"
      : support === "unsupported"
        ? "Ajoute d'abord MoonAgentic à l'écran d'accueil"
        : permission === "denied"
          ? "Bloquées par le navigateur pour ce site"
          : undefined;
  return (
    <>
      <Row title="Notifications" text={text}>
        {on && (
          <button
            className="mini press"
            onClick={() =>
              void showNotice({
                tag: "essai",
                threadId: "",
                title: "MoonAgentic",
                body: "Les notifications marchent sur cet appareil.",
              }).then((shown) => setTried(shown ? "sent" : "refused"))
            }
          >
            {tried === "sent" ? "Envoyée" : tried === "refused" ? "Refusée" : "Essayer"}
          </button>
        )}
        <Toggle
          label="Notifications"
          on={on}
          disabled={support !== "ok"}
          onChange={(next) => {
            setTried(null);
            if (!next) {
              disableNotifications();
              setOn(false);
              // None at all: those sent while the app is closed stop too.
              if (pushOn()) void disablePush().catch(() => undefined);
              return;
            }
            void enableNotifications().then((answer) => {
              setPermission(answer);
              setOn(answer === "granted");
            });
          }}
        />
      </Row>
      {on && support === "ok" && <PushRow />}
    </>
  );
}

/**
 * Whether agents' pages may load the known libraries and fonts (Tailwind, jsDelivr, Google
 * Fonts…), for every device: a mockup made with them shows as it was meant.
 */
function LibrariesRow() {
  const on = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().artifactLibraries,
  );
  return (
    <Row title="Bibliothèques en ligne">
      <Toggle
        label="Bibliothèques en ligne"
        on={on}
        onChange={(next) => connection.send({ type: "artifacts.setLibraries", on: next })}
      />
    </Row>
  );
}

/**
 * /lock: the code, kept on the computer, and the projects it hides. Locking or opening one
 * here does it for every device.
 */
function LockGroup(props: { projects: Project[]; lockPin: boolean }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const pairedDevice = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().pairedDevice,
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const after = useSyncExternalStore(appLock.subscribe, appLock.after);
  const projects = props.projects.filter((p) => !isDiscussionsProject(p));
  return (
    <>
      <div className="gl2">Verrouillage</div>
      <div className="ins">
        <Row title="Verrouiller l'app">
          <button className="mini press" onClick={() => lockApp(props.lockPin)}>
            Verrouiller
          </button>
        </Row>
        <ChoiceRow
          title="Verrouiller après"
          value={after}
          shown={LOCK_AFTER.find((o) => o.value === after)?.label ?? "Jamais"}
          choices={LOCK_AFTER.map((o) => ({ value: o.value, label: o.label }))}
          onPick={(value) => appLock.setAfter(value as LockAfter)}
        />
        <Row
          title="Code à 6 chiffres"
          text={pairedDevice ? "Se crée et se change sur l'ordinateur" : undefined}
        >
          {props.lockPin && <span className="okp">Défini</span>}
          {!pairedDevice && (
            <button
              className="mini press"
              onClick={() => lockSheet.open(props.lockPin ? { kind: "change" } : { kind: "set" })}
            >
              {props.lockPin ? "Changer le code" : "Définir le code"}
            </button>
          )}
        </Row>
        {projects.map((p) => (
          <Row key={p.id} title={p.name}>
            <Toggle
              label={p.locked ? `Déverrouiller ${p.name}` : `Verrouiller ${p.name}`}
              on={!!p.locked}
              onChange={() => toggleLock(p, props.lockPin)}
            />
          </Row>
        ))}
        <Row title="Raccourci">
          <span className="rt">
            <span className="mono">{mac ? "⌘ ⇧ L" : "Ctrl Maj L"}</span>
          </span>
        </Row>
        {props.lockPin && !pairedDevice && (
          <button className="it dng" onClick={() => setConfirmReset(true)}>
            <span className="tx">Réinitialiser le code</span>
          </button>
        )}
      </div>
      <Sheet
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        label="Réinitialiser le code de verrouillage ?"
      >
        <div className="cfw">
          <div className="grab" />
          <h3>Réinitialiser le code ?</h3>
          <span className="ppill">Tous les projets verrouillés redeviennent visibles</span>
          <div className="cfa">
            <button
              className="b2 red press"
              onClick={() => {
                setConfirmReset(false);
                void connection
                  .request({ type: "lock.reset", requestId: newId() })
                  .catch((e: unknown) => connection.notify(reason(e)));
              }}
            >
              Réinitialiser
            </button>
            <button className="b2 soft press" onClick={() => setConfirmReset(false)}>
              Annuler
            </button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

/** One-click redacted crash & multi-agent performance report export in Réglages › Général. */
function DiagnosticsGroup() {
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const [done, setDone] = useState<"copy" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 2_500);
    return () => clearTimeout(timer);
  }, [done]);

  const run = async (action: "copy" | "download") => {
    setBusy(action);
    setDone(null);
    setError(null);
    try {
      const report = await connection.diagnostics();
      if (action === "copy") {
        const ok = await copyDiagnosticText(report.text);
        if (!ok) {
          downloadDiagnosticText(report.text, report.generatedAt);
          setDone("download");
          return;
        }
      } else {
        downloadDiagnosticText(report.text, report.generatedAt);
      }
      setDone(action);
    } catch (e: unknown) {
      setError(reason(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="gl2">Diagnostic</div>
      <div className="ins">
        <Row
          title="Rapport de diagnostic"
          text={error ? <span className="erx">{error}</span> : undefined}
        >
          <button className="mini press" disabled={busy !== null} onClick={() => void run("copy")}>
            {busy === "copy" ? "Préparation…" : done === "copy" ? "Copié" : "Copier"}
          </button>
          <button
            className="mini press"
            disabled={busy !== null}
            onClick={() => void run("download")}
          >
            {busy === "download"
              ? "Préparation…"
              : done === "download"
                ? "Téléchargé"
                : "Télécharger"}
          </button>
        </Row>
      </div>
    </>
  );
}

/** The agent and model one kind of work goes to: its line, and the sheet to change it. */
function RouteRow(props: {
  kind: RouteKind;
  title: string;
  agents: AgentInfo[];
  favorites: Favorites;
  route: { agentId: string; model?: string } | undefined;
}) {
  const { kind, route } = props;
  const [all, setAll] = useState(false);
  const { groups, favoritesOnly } = routeChoices(props.agents, props.favorites, route, all);
  const none = kind === "default" ? "Agent du coordinateur" : "Par défaut";
  const value = route ? routeValue(route.agentId, route.model) : "";
  const choices: Choice[] = [
    { value: "", label: none },
    ...groups.flatMap((g) =>
      g.options.map((o) => ({ value: o.value, label: o.label, group: g.agent.name })),
    ),
  ];
  return (
    <ChoiceRow
      title={props.title}
      label={`Modèle pour ${KIND_LABEL[kind]}`}
      value={value}
      shown={choices.find((c) => c.value === value)?.label ?? none}
      choices={choices}
      {...(favoritesOnly || all
        ? { more: { label: all ? "Favoris" : "Tous", on: all, toggle: () => setAll((on) => !on) } }
        : {})}
      onPick={(picked) => {
        const to = parseRouteValue(picked);
        connection.send({
          type: "coordinator.setRoute",
          kind,
          ...(to ? { agentId: to.agentId } : {}),
          ...(to?.model ? { model: to.model } : {}),
        });
      }}
    />
  );
}

interface PageProps {
  agents: AgentInfo[];
  favorites: Favorites;
  coordinator: CoordinatorSettings;
  projects: Project[];
  /** Whether a code for /lock is set. */
  lockPin: boolean;
  projectId: string | undefined;
  mcpServers: McpServerInfo[];
  mcpSecretsError?: string | null;
  hermes: HermesStatus | null;
  onPickProject: (id: string) => void;
}

/** What the pages share with the layer: GitHub as the server reports it, and its sheet. */
interface GithubProps {
  github: ReturnType<typeof useGithubStatus>;
  onOpenGithub: () => void;
}

/** « Agents »: each one with its state; a line opens it, the last adds one. */
function AgentsPage({ agents }: { agents: AgentInfo[] }) {
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  const checks = useAgentChecks();
  const agent = agents.find((a) => a.id === opened);
  return (
    <>
      <div className="ins">
        {agents.map((a) => (
          <button key={a.id} className="it" onClick={() => setOpened(a.id)}>
            <span className="tx">
              {a.name}
              <small>
                {!a.available
                  ? (a.hint ?? "Pas trouvé sur cette machine")
                  : (a.check?.version ?? a.command ?? "")}
              </small>
            </span>
            <span className="rt">
              <AgentState agent={a} checking={checks.checking(a)} />
              <I n="right" s={15} />
            </span>
          </button>
        ))}
      </div>
      <div className="ins">
        <button className="it acc" onClick={() => setAdding(true)}>
          <I n="plus" s={18} />
          <span className="tx">Ajouter un agent</span>
        </button>
      </div>
      <AgentSheet
        agent={agent}
        checking={!!agent && checks.checking(agent)}
        onCheck={() => agent && checks.check(agent)}
        onClose={() => setOpened(undefined)}
      />
      <AgentAddSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

/** « Connexions et MCP »: the GitHub account, then the servers given to the agents. */
function McpPage(props: PageProps & GithubProps) {
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  const { status, checking } = props.github;
  return (
    <>
      <div className="gl2">Comptes</div>
      <div className="ins">
        <button className="it" onClick={props.onOpenGithub}>
          <span className="ic">
            <I n="gh" s={18} />
          </span>
          <span className="tx">GitHub</span>
          <span className="rt">
            {status?.login ?? (checking ? "" : "Non connecté")}
            <I n="right" s={15} />
          </span>
        </button>
      </div>
      <div className="gl2">Serveurs MCP</div>
      <div className="ins">
        {props.mcpSecretsError && (
          <div className="it ro">
            <span className="tx">
              <small className="erx">{props.mcpSecretsError}</small>
            </span>
          </div>
        )}
        {props.mcpServers.map((s) => (
          <button key={s.id} className="it" onClick={() => setOpened(s.id)}>
            <span className="tx">
              {s.name}
              <small>
                {mcpScopeLabel(scopeOf(s), props.projects)}
                {s.agentIds ? ` · ${mcpAgentsLabel(s.agentIds, props.agents)}` : ""}
              </small>
            </span>
            <span className="rt">
              {s.enabled ? (
                <span className="dvon">Actif</span>
              ) : (
                <span className="mof">Arrêté</span>
              )}
              <I n="right" s={15} />
            </span>
          </button>
        ))}
        <button className="it acc" onClick={() => setAdding(true)}>
          <I n="plus" s={18} />
          <span className="tx">Ajouter un serveur</span>
        </button>
      </div>
      <McpServerSheet
        server={props.mcpServers.find((s) => s.id === opened)}
        projects={props.projects}
        agents={props.agents}
        onClose={() => setOpened(undefined)}
      />
      <McpAddSheet
        open={adding}
        projects={props.projects}
        agents={props.agents}
        onClose={() => setAdding(false)}
      />
    </>
  );
}

/** One section of the settings; every value here is real and takes effect at once. */
function SectionBody(props: PageProps & GithubProps & { section: SettingsSection }) {
  // Kept by the server: the same on every device.
  const { permissionMode: mode, isolated } = useDefaults();
  const theme = useSyncExternalStore(subscribeTheme, readTheme);

  switch (props.section) {
    case "general": {
      const open = props.projects.filter((p) => !p.locked && !isDiscussionsProject(p));
      return (
        <>
          <div className="ins">
            {open.length > 0 ? (
              <ChoiceRow
                title="Projet par défaut"
                value={props.projectId ?? ""}
                shown={open.find((p) => p.id === props.projectId)?.name ?? "Hors projet"}
                choices={open.map((p) => ({ value: p.id, label: p.name }))}
                onPick={props.onPickProject}
              />
            ) : (
              <Row title="Projet par défaut">
                <span className="rt">Aucun projet</span>
              </Row>
            )}
            <div className="it ro col">
              <span className="tx">Autorisations par défaut</span>
              <div className="seg" role="radiogroup" aria-label="Autorisations par défaut">
                <button
                  role="radio"
                  aria-checked={mode !== "full"}
                  aria-pressed={mode !== "full"}
                  onClick={() => setDefault({ permissionMode: "supervised" })}
                >
                  <I n="hand" s={16} />
                  Supervisé
                </button>
                <button
                  className="f"
                  role="radio"
                  aria-checked={mode === "full"}
                  aria-pressed={mode === "full"}
                  onClick={() => setDefault({ permissionMode: "full" })}
                >
                  <I n="bolt" s={16} />
                  Accès complet
                </button>
              </div>
            </div>
            <Row title="Branche à part">
              <Toggle
                label="Branche à part"
                on={isolated}
                onChange={(on) => setDefault({ isolated: on })}
              />
            </Row>
          </div>
          <div className="gl2">Notifications</div>
          <div className="ins">
            <NotificationsRow />
          </div>
          <div className="gl2">Artefacts</div>
          <div className="ins">
            <LibrariesRow />
          </div>
          <AppUpdateSettings row={Row} toggle={Toggle} />
          <LockGroup projects={props.projects} lockPin={props.lockPin} />
          <DiagnosticsGroup />
        </>
      );
    }
    case "appearance":
      return (
        <div className="thg" role="radiogroup" aria-label="Thème">
          {(Object.keys(THEMES) as Theme[]).map((k) => (
            <button
              key={k}
              className="thp press"
              role="radio"
              aria-checked={theme === k}
              aria-pressed={theme === k}
              onClick={() => setTheme(k)}
            >
              <span className={`mini-ph ${k}`}>
                <i />
                <i />
                <i />
              </span>
              <span className="rad" />
              {THEMES[k]}
            </button>
          ))}
        </div>
      );
    case "agents":
      return <AgentsPage agents={props.agents} />;
    case "mascots":
      return (
        <>
          <MascotSettings agents={props.agents} />
          <RoleMascots />
        </>
      );
    case "models":
      return (
        <>
          <ModelFavorites agents={props.agents} favorites={props.favorites} />
          <div className="gl2">Par type de travail</div>
          <div className="ins">
            {ROUTE_KINDS.filter((kind) => kind !== "default").map((kind) => (
              <RouteRow
                key={kind}
                kind={kind}
                title={KIND_LABEL[kind]}
                agents={props.agents}
                favorites={props.favorites}
                route={props.coordinator.routes[kind]}
              />
            ))}
          </div>
          <div className="gl2">Limites</div>
          <div className="ins">
            <Row title="Fils en même temps" text="Par projet">
              <Stepper
                label="Fils en même temps"
                value={props.coordinator.parallel ?? DEFAULT_PARALLEL}
                max={MAX_PARALLEL}
                onChange={(parallel) =>
                  connection.send({ type: "coordinator.setParallel", parallel })
                }
              />
            </Row>
            <Row title="Tours en même temps" text="Sur tout le serveur">
              <Stepper
                label="Tours en même temps sur tout le serveur"
                value={props.coordinator.maxTurns ?? DEFAULT_MAX_TURNS}
                max={MAX_MAX_TURNS}
                onChange={(maxTurns) => connection.send({ type: "server.setMaxTurns", maxTurns })}
              />
            </Row>
          </div>
        </>
      );
    case "coordinator": {
      const named = (m: TeamMember) => {
        const agent = props.agents.find((a) => a.id === m.agentId);
        return modelNameOf(agent?.models, m.model) ?? agent?.name ?? m.agentId;
      };
      const team = props.coordinator.team;
      const roles: [string, string][] = team
        ? [
            ["Chef", named(team.lead)],
            [team.coders > 1 ? `${team.coders} codeurs` : "Codeur", named(team.coder)],
            ...(team.reviewer ? [["Relecture", named(team.reviewer)] as [string, string]] : []),
            ...(team.reviewer && team.reviewer2
              ? [["Relecture 2", named(team.reviewer2)] as [string, string]]
              : []),
            ...(team.reviewer && team.judge
              ? [["Arbitre", named(team.judge)] as [string, string]]
              : []),
            ...(team.tester ? [["Tests", named(team.tester)] as [string, string]] : []),
            ...(team.merger ? [["Fusion", named(team.merger)] as [string, string]] : []),
          ]
        : [];
      return (
        <>
          <div className="ins">
            <RouteRow
              kind="default"
              title="Modèle des fils ouverts"
              agents={props.agents}
              favorites={props.favorites}
              route={props.coordinator.routes.default}
            />
          </div>
          <div className="gl2">Équipe lancée par un coordinateur</div>
          <div className="ins">
            {team ? (
              roles.map(([role, who]) => (
                <Row key={role} title={role}>
                  <span className="rt">{who}</span>
                </Row>
              ))
            ) : (
              <Row title="Aucune">
                <span className="rt">
                  <span className="mono">/equipe</span>
                </span>
              </Row>
            )}
          </div>
        </>
      );
    }
    case "mcp":
      return <McpPage {...props} />;
    case "skills":
      return <SkillsSettings projects={props.projects} />;
    case "teams":
      return <TeamPresets agents={props.agents} projectId={props.projectId} />;
    case "remote":
      return <RemoteAccess hermes={props.hermes} />;
    case "hermes":
      return <HermesSettings hermes={props.hermes} />;
    case "subscriptions":
      return <Subscriptions agents={props.agents} />;
  }
}

/** The page's title folds into its header once the page is scrolled. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) =>
    setScrolled(e.currentTarget.scrollTop > 34);
  return { scrolled, onScroll, reset: () => setScrolled(false) };
}

/**
 * The settings, over the whole app. On a phone the list of sections, then the section pushed
 * over it; on a wider screen the list where the side bar was and the section in the rest.
 */
export function SettingsLayer(
  props: PageProps & {
    section: SettingsSection;
    /** A phone shows the list, not the section. */
    list: boolean;
    wide: boolean;
    onPick: (section: SettingsSection) => void;
    onList: () => void;
    onClose: () => void;
  },
) {
  const [query, setQuery] = useState("");
  const github = useGithubStatus();
  const [githubOpen, setGithubOpen] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const quotas = useQuotas();
  const { app } = useApp();
  const root = useScrolled();
  const sub = useScrolled();
  // The layer slides in once it is there.
  const [on, setOn] = useState(false);
  // Hermes's state, for its line saying whether it is connected.
  useHermesState();
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".sheet.on")) return;
      event.preventDefault();
      if (!props.wide && !props.list) props.onList();
      else props.onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });

  const worst = Math.max(0, ...quotas.map((q) => tightest(q)?.usedPercent ?? 0));
  const ready = props.agents.filter((a) => a.available).length;
  const favorites = Object.values(props.favorites).reduce((n, list) => n + list.length, 0);
  const servers = props.mcpServers.filter((s) => s.enabled).length;
  const main = props.coordinator.routes.default;
  const state: Partial<Record<SettingsSection, string>> = {
    appearance: THEMES[theme],
    agents: ready ? `${ready} ${ready > 1 ? "prêts" : "prêt"}` : "",
    models: favorites ? `${favorites} ${favorites > 1 ? "favoris" : "favori"}` : "",
    subscriptions: quotas.length ? formatPercent(worst) : "",
    coordinator: main
      ? (modelNameOf(props.agents.find((a) => a.id === main.agentId)?.models, main.model) ??
        props.agents.find((a) => a.id === main.agentId)?.name ??
        "")
      : "",
    mcp: servers ? `${servers} ${servers > 1 ? "actifs" : "actif"}` : "",
    hermes: props.hermes ? (props.hermes.connected ? "Connecté" : "Non connecté") : "",
  };
  const shown = new Set(matchSections(SECTIONS, query).map((s) => s.id));
  const title = SECTIONS.find((s) => s.id === props.section)?.label ?? "";
  const subIn = props.wide || !props.list;
  const pick = (section: SettingsSection) => {
    sub.reset();
    props.onPick(section);
  };

  const search = (
    <label className={`ssearch${props.wide ? " hs" : ""}`}>
      <I n="search" s={17} />
      <input
        type="search"
        placeholder="Rechercher un réglage"
        aria-label="Rechercher un réglage"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          const first = SECTIONS.find((s) => shown.has(s.id));
          if (e.key === "Enter" && first) pick(first.id);
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
      />
    </label>
  );

  return (
    <div className={`setl${on ? " on" : ""}`} id="setl">
      <div
        className={`spg root${subIn && !props.wide ? " back" : ""}${root.scrolled ? " sc" : ""}`}
        id="sroot"
        role="navigation"
        aria-label="Réglages"
        inert={subIn && !props.wide}
      >
        <div className="shdr">
          <button
            className="gb sback press"
            aria-label="Fermer les réglages"
            onClick={props.onClose}
          >
            <I n="back" s={19} />
          </button>
          {props.wide && search}
          <b className="stitle">Réglages</b>
          <span className="sph" />
        </div>
        <div className="sscroll" onScroll={root.onScroll}>
          <h1 className="lt">Réglages</h1>
          {!props.wide && search}
          {GROUPS.map((group) => {
            const rows = group.filter((s) => shown.has(s.id));
            if (!rows.length) return null;
            return (
              <div key={group[0]!.id} className="ins sg">
                {rows.map((s) => (
                  <button
                    key={s.id}
                    className="it"
                    aria-current={props.wide && s.id === props.section ? "true" : undefined}
                    onClick={() => pick(s.id)}
                  >
                    <span className="ic tile">
                      {s.icon === "half" ? (
                        <span className="half" />
                      ) : s.icon === "$" ? (
                        <span className="key">$</span>
                      ) : (
                        <I n={s.icon} s={17} />
                      )}
                    </span>
                    <span className="tx">{s.label}</span>
                    <span className="rt">
                      {state[s.id]}
                      <I n="right" s={15} />
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {!shown.size && <p className="snone">Aucun réglage ne correspond.</p>}
          {app && (
            <p className="sver">
              <b>MoonAgentic</b> {app.version}
              <VersionBadge app={app} />
            </p>
          )}
        </div>
      </div>
      <div
        className={`spg sub${subIn ? " in" : ""}${sub.scrolled ? " sc" : ""}`}
        id="ssub"
        role="region"
        aria-label={title}
        inert={!subIn}
      >
        <div className="shdr">
          <button
            className="bk glass press"
            aria-label="Retour aux réglages"
            onClick={props.onList}
          >
            <I n="back" s={20} />
            <span>Réglages</span>
          </button>
          <b className="stitle">{title}</b>
          <span className="sph" />
        </div>
        <div className="sscroll" key={props.section} onScroll={sub.onScroll}>
          <h1 className="lt">{title}</h1>
          <SectionBody {...props} github={github} onOpenGithub={() => setGithubOpen(true)} />
          <div style={{ height: 30 }} />
        </div>
      </div>
      <GithubSheet open={githubOpen} github={github} onClose={() => setGithubOpen(false)} />
    </div>
  );
}
