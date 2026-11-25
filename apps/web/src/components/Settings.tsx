import {
  type AgentInfo,
  type CoordinatorSettings,
  DEFAULT_MAX_TURNS,
  DEFAULT_PARALLEL,
  MAX_MAX_TURNS,
  MAX_PARALLEL,
  type Favorites,
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
import { lockSheet, toggleLock } from "../lock.ts";
import { setDefault, useDefaults } from "../defaults.ts";
import { copyDiagnosticText, downloadDiagnosticText } from "../diagnostics.ts";
import { disablePush, enablePush, pushOn, pushReached, pushSupport } from "../push.ts";
import type { PushSupport } from "../push-device.ts";
import type { SettingsSection } from "../router.ts";
import { mcpScopeLabel, scopeOf } from "../mcp-scope.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { matchSections } from "../settings-search.ts";
import { formatPercent, tightest } from "../quotas.ts";
import { useQuotas } from "../use-quotas.ts";
import { readTheme, setTheme, subscribeTheme, type Theme } from "../theme.ts";
import { I } from "../v2/I.tsx";
import type { IconName } from "../v2/sprite.ts";
import { Sheet } from "../v2/Sheet.tsx";
import { AppUpdateSettings, useApp } from "./AppUpdate.tsx";
import { MascotSettings } from "./MascotSettings.tsx";
import { ModelFavorites } from "./ModelFavorites.tsx";
import { RemoteAccess } from "./RemoteAccess.tsx";
import { Subscriptions } from "./Subscriptions.tsx";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { TeamPresets } from "./TeamPresets.tsx";

/** The sections, in the groups the list shows them in. */
const GROUPS: { id: SettingsSection; label: string; icon: IconName | "half" }[][] = [
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
  ],
  [{ id: "remote", label: "Accès distant", icon: "wifi" }],
];
const SECTIONS = GROUPS.flat();
const THEMES: Record<Theme, string> = { system: "Système", light: "Clair", dark: "Sombre" };

/** The GitHub account `gh` is signed in to, as the server reports it; nothing when none. */
function useGithubLogin(): string | undefined {
  const [login, setLogin] = useState<string>();
  useEffect(() => {
    let live = true;
    connection
      .ask({ type: "github.status", requestId: newId() })
      .then((reply) => live && setLogin(reply.status.login))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return login;
}

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
 * /lock: the code, kept on the computer, and the projects it hides. Locking or opening one
 * here does it for every device.
 */
function LockGroup(props: { projects: Project[]; lockPin: boolean }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const pairedDevice = useSyncExternalStore(connection.subscribe, connection.getState).pairedDevice;
  const [confirmReset, setConfirmReset] = useState(false);
  const projects = props.projects.filter((p) => !isDiscussionsProject(p));
  return (
    <>
      <div className="gl2">
        <I n="lock" s={14} />
        Verrouillage
      </div>
      <div className="ins">
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
        <button className="it acc" disabled={busy !== null} onClick={() => void run("copy")}>
          <span className="tx">
            {busy === "copy" ? "Préparation…" : done === "copy" ? "Copié" : "Copier le diagnostic"}
            {error && <small className="erx">{error}</small>}
          </span>
        </button>
        <button className="it acc" disabled={busy !== null} onClick={() => void run("download")}>
          <span className="tx">
            {busy === "download"
              ? "Préparation…"
              : done === "download"
                ? "Téléchargé"
                : "Télécharger"}
          </span>
        </button>
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
  onPickProject: (id: string) => void;
  onOpenConnections: () => void;
  onOpenMcp: () => void;
}

/** One section of the settings; every value here is real and takes effect at once. */
function SectionBody(props: PageProps & { section: SettingsSection }) {
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
      return (
        <>
          <div className="ins">
            {props.agents.map((a) => {
              const signIn = a.available && a.check?.signInNeeded;
              const broken = a.available && a.check?.ok === false;
              return (
                <div key={a.id} className="it ro">
                  <span className="tx">
                    {a.name}
                    <small>
                      {!a.available
                        ? (a.hint ?? "Pas trouvé sur cette machine")
                        : signIn
                          ? `Connexion requise${a.login ? ` : ${a.login}` : ""}`
                          : (a.check?.version ?? a.command ?? "")}
                    </small>
                  </span>
                  {!a.available ? (
                    <span className="mof">Absent</span>
                  ) : signIn || broken ? (
                    <span className="mer">À vérifier</span>
                  ) : (
                    <span className="dvon">Prêt</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="ins">
            <button className="it acc" onClick={props.onOpenConnections}>
              <I n="plus" s={18} />
              <span className="tx">Vérifier ou ajouter un agent</span>
            </button>
          </div>
        </>
      );
    case "mascots":
      return <MascotSettings agents={props.agents} />;
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
      return (
        <>
          <div className="gl2">Comptes</div>
          <div className="ins">
            <button className="it" onClick={props.onOpenConnections}>
              <span className="ic">
                <I n="gh" s={18} />
              </span>
              <span className="tx">GitHub et agents</span>
              <I n="right" s={15} />
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
              <button key={s.id} className="it" onClick={props.onOpenMcp}>
                <span className="tx">
                  {s.name}
                  <small>{mcpScopeLabel(scopeOf(s), props.projects)}</small>
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
            <button className="it acc" onClick={props.onOpenMcp}>
              <I n="plus" s={18} />
              <span className="tx">
                {props.mcpServers.length ? "Gérer les serveurs" : "Ajouter un serveur"}
              </span>
            </button>
          </div>
        </>
      );
    case "teams":
      return <TeamPresets agents={props.agents} projectId={props.projectId} />;
    case "remote":
      return <RemoteAccess />;
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
  const login = useGithubLogin();
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const quotas = useQuotas();
  const { app } = useApp();
  const root = useScrolled();
  const sub = useScrolled();
  // The layer slides in once it is there.
  const [on, setOn] = useState(false);
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
  };
  const shown = new Set(matchSections(SECTIONS, query).map((s) => s.id));
  const title = SECTIONS.find((s) => s.id === props.section)?.label ?? "";
  const subIn = props.wide || !props.list;
  const pick = (section: SettingsSection) => {
    sub.reset();
    props.onPick(section);
  };

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
            className="gb glass press"
            aria-label="Fermer les réglages"
            onClick={props.onClose}
          >
            <I n="x" s={19} />
          </button>
          <b className="stitle">Réglages</b>
          <span className="sph" />
        </div>
        <div className="sscroll" onScroll={root.onScroll}>
          <h1 className="lt">Réglages</h1>
          <label className="ssearch">
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
          {!query && (
            <button className="prof press" onClick={props.onOpenConnections}>
              <span className="me sm">{(login ?? "M").slice(0, 1).toUpperCase()}</span>
              <span className="tx">
                <b>{login ?? "MoonAgentic"}</b>
                <small>
                  <I n="gh" s={13} />
                  {login ? "GitHub" : "GitHub non connecté"}
                </small>
              </span>
              <I n="right" s={15} />
            </button>
          )}
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
                      {s.icon === "half" ? <span className="half" /> : <I n={s.icon} s={17} />}
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
          <SectionBody {...props} />
          <div style={{ height: 30 }} />
        </div>
      </div>
    </div>
  );
}
