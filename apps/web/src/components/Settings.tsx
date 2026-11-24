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
import { desktopShell } from "../desktop.ts";
import type { SettingsSection } from "../router.ts";
import { mcpScopeLabel, scopeOf } from "../mcp-scope.ts";
import { matchSections } from "../settings-search.ts";
import { isDark, readTheme, setTheme, subscribeTheme, type Theme } from "../theme.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { AppUpdateSettings } from "./AppUpdate.tsx";
import {
  IconArrowLeft,
  IconBranch,
  IconFolder,
  IconGauge,
  IconGear,
  IconLock,
  IconMoon,
  IconSearch,
  IconSun,
  IconPlug,
  IconShield,
  IconStar,
  IconUsers,
  IconWifi,
} from "./icons.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MascotSettings } from "./MascotSettings.tsx";
import { ModelFavorites } from "./ModelFavorites.tsx";
import { RemoteAccess } from "./RemoteAccess.tsx";
import { Subscriptions } from "./Subscriptions.tsx";
import { TeamPresets } from "./TeamPresets.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "Général", icon: <IconGear size={15} /> },
  { id: "appearance", label: "Apparence", icon: <span className="set-half" aria-hidden /> },
  { id: "agents", label: "Agents", icon: <IconShield size={15} /> },
  { id: "mascots", label: "Mascottes", icon: <IconMoon size={15} /> },
  { id: "models", label: "Modèles", icon: <IconStar size={15} /> },
  { id: "subscriptions", label: "Abonnements", icon: <IconGauge size={15} /> },
  { id: "coordinator", label: "Coordinateur", icon: <IconBranch size={15} /> },
  { id: "teams", label: "Équipes", icon: <IconUsers size={15} /> },
  { id: "mcp", label: "Serveurs MCP", icon: <IconPlug size={15} /> },
  { id: "remote", label: "Accès distant", icon: <IconWifi size={15} /> },
];

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

/** The sidebar while in the settings: back to the app, a search, one entry per section. */
export function SettingsNav(props: {
  section: SettingsSection;
  onPick: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = matchSections(SECTIONS, query);
  const login = useGithubLogin();
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const dark = isDark(theme);
  return (
    <aside className="side set-side" aria-label="Réglages">
      <button className="set-back" onClick={props.onBack}>
        <IconArrowLeft size={16} />
        Retour
      </button>
      <label className="set-search">
        <IconSearch size={15} />
        <input
          type="search"
          placeholder="Rechercher un réglage"
          aria-label="Rechercher un réglage"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) props.onPick(shown[0].id);
            if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      <nav className="set-nav">
        {shown.map((s) => (
          <button
            key={s.id}
            className={s.id === props.section ? "on" : undefined}
            aria-current={s.id === props.section ? "page" : undefined}
            onClick={() => props.onPick(s.id)}
          >
            <span className="set-ic">{s.icon}</span>
            {s.label}
          </button>
        ))}
        {!shown.length && <p className="set-none">Aucun réglage ne correspond.</p>}
      </nav>
      <div className="side-foot set-foot">
        <button
          className="ib set-gear on"
          aria-label="Fermer les réglages"
          title="Fermer les réglages"
          aria-pressed
          onClick={props.onBack}
        >
          <IconGear size={17} />
        </button>
        {login && (
          <span className="set-me" title="Compte GitHub de gh">
            <span className="set-avatar" aria-hidden>
              {login.slice(0, 2).toUpperCase()}
            </span>
            <span className="set-who">
              <span className="set-login">{login}</span>
              <small>GitHub</small>
            </span>
          </span>
        )}
        <button
          className="ib set-theme"
          aria-label={dark ? "Passer en clair" : "Passer en sombre"}
          title={dark ? "Passer en clair" : "Passer en sombre"}
          onClick={() => setTheme(dark ? "light" : "dark")}
        >
          {dark ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </aside>
  );
}

function Row(props: { title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-tx">
        <b>{props.title}</b>
        {props.text && <p>{props.text}</p>}
      </div>
      {props.children && <div className="set-ctl">{props.children}</div>}
    </div>
  );
}

function Seg<T extends string>(props: {
  label: string;
  value: T;
  choices: { id: T; name: string }[];
  onPick: (value: T) => void;
}) {
  return (
    <div className="set-seg" role="radiogroup" aria-label={props.label}>
      {props.choices.map((c) => (
        <button
          key={c.id}
          role="radio"
          aria-checked={c.id === props.value}
          onClick={() => props.onPick(c.id)}
        >
          {c.name}
        </button>
      ))}
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
      className={`set-sw${props.on ? " on" : ""}`}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Web Push for this device: the same notices, even with MoonAgentic closed. Shown as the
 * server sees it: on only when it really reaches this browser.
 */
function PushRow() {
  const support = pushSupport();
  if (support === "desktop") {
    return (
      <Row
        title="Même quand l'app est fermée"
        text="Déjà le cas dans l'app de bureau : fermer la fenêtre la cache seulement, MoonAgentic continue près de l'horloge et t'avertit par les notifications du système. Seul « Quitter MoonAgentic » les arrête, avec tes agents. Pour ton téléphone, active-les dans ses propres réglages."
      />
    );
  }
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
        if (!reached) setError("Ce navigateur n'est plus abonné : réactive-les.");
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
    support === "unsupported"
      ? "Ce navigateur ne les reçoit pas. Sur iPhone, ouvre MoonAgentic depuis l'écran d'accueil."
      : (error ??
        "Les mêmes alertes, même quand MoonAgentic est fermé. Elles passent par le service de notifications du navigateur (Google, Apple, Mozilla ou Microsoft), chiffrées pour cet appareil : ce service ne peut pas les lire. Il faut que l'ordinateur de MoonAgentic ait accès à Internet.");
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
      ? "Indisponibles à cette adresse : le navigateur ne les autorise qu'en HTTPS (par exemple avec tailscale serve) ou sur la machine elle-même."
      : support === "unsupported"
        ? "Ce navigateur n'en propose pas. Sur iPhone, ajoute d'abord MoonAgentic à l'écran d'accueil."
        : permission === "denied"
          ? "Bloquées par le navigateur pour ce site : autorise-les dans ses réglages, puis réessaie."
          : desktopShell()
            ? "Sur cet ordinateur, par les notifications du système, quand un fil attend ta réponse ou qu'une équipe termine ou échoue, sauf si tu as déjà MoonAgentic sous les yeux."
            : "Sur cet appareil, quand un fil attend ta réponse ou qu'une équipe termine ou échoue, sauf si tu as déjà MoonAgentic sous les yeux. Il faut qu'il reste ouvert dans un onglet, même en arrière-plan.";
  return (
    <>
      <Row title="Notifications" text={text}>
        <div className="set-notif">
          {on && (
            <button
              className="btn quiet sm"
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
        </div>
      </Row>
      {on && support === "ok" && <PushRow />}
    </>
  );
}

/**
 * /lock: the code, kept on the computer, and the projects it hides. Locking or opening one
 * here does it for every device.
 */
function LockCard(props: { projects: Project[]; lockPin: boolean }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const pairedDevice = useSyncExternalStore(connection.subscribe, connection.getState).pairedDevice;
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <>
      <h3 className="lk-h">Verrouillage des projets</h3>
      <div className="set-card">
        <Row
          title="Code de verrouillage"
          text={
            pairedDevice
              ? props.lockPin
                ? "Un code à 6 chiffres est défini. Pour le changer ou le réinitialiser, va sur l'ordinateur où tourne MoonAgentic."
                : "Aucun code pour l'instant. Il se définit depuis l'ordinateur où tourne MoonAgentic."
              : props.lockPin
                ? "Un code à 6 chiffres est défini. Il est demandé pour rouvrir un projet verrouillé. Réservé à cet ordinateur."
                : "Aucun code pour l'instant. Il te sera demandé au premier verrouillage (sur cet ordinateur)."
          }
        >
          {!pairedDevice && (
            <button
              className="btn sm"
              onClick={() => lockSheet.open(props.lockPin ? { kind: "change" } : { kind: "set" })}
            >
              {props.lockPin ? "Changer le code" : "Définir le code"}
            </button>
          )}
        </Row>
        {props.lockPin && !pairedDevice && (
          <Row
            title="Code oublié"
            text="Efface le code et rouvre tous les projets verrouillés. Réservé à cet ordinateur."
          >
            <button className="btn sm" onClick={() => setConfirmReset(true)}>
              Réinitialiser le code
            </button>
          </Row>
        )}
        {props.projects.length > 0 && (
          <Row
            title="Projets verrouillés"
            text="Leurs discussions sont masquées sur tous tes appareils. Les agents continuent de travailler."
          >
            <span className="lk-chips">
              {props.projects.map((p) => (
                <button
                  key={p.id}
                  className="lk-chip"
                  aria-pressed={!!p.locked}
                  title={p.locked ? `Déverrouiller ${p.name}` : `Verrouiller ${p.name}`}
                  onClick={() => toggleLock(p, props.lockPin)}
                >
                  <IconLock size={12} />
                  {p.name}
                </button>
              ))}
            </span>
          </Row>
        )}
        <Row
          title="Raccourci"
          text="Verrouille le projet ouvert. La commande /lock fait la même chose."
        >
          <kbd>{mac ? "⌘ ⇧ L" : "Ctrl Maj L"}</kbd>
        </Row>
      </div>
      {confirmReset && (
        <ConfirmDialog
          confirm={{
            title: "Réinitialiser le code de verrouillage ?",
            text: "Le code sera effacé et tous les projets verrouillés redeviendront visibles sur tes appareils.",
            action: "Réinitialiser",
            run: async () => {
              await connection.request({ type: "lock.reset", requestId: newId() });
            },
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </>
  );
}

/** One-click redacted crash & multi-agent performance report export in Réglages › Général. */
function DiagnosticsCard() {
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
      <h3 className="lk-h">Diagnostic</h3>
      <div className="set-card">
        <Row
          title="Journaux et performances"
          text={
            error ??
            "Mémoire globale et par agent (pics multi-agents), lenteurs et erreurs récentes, sans jetons ni secrets."
          }
        >
          <div className="set-notif">
            <button className="btn sm" disabled={busy !== null} onClick={() => void run("copy")}>
              {busy === "copy"
                ? "Préparation…"
                : done === "copy"
                  ? "Copié"
                  : "Copier le diagnostic"}
            </button>
            <button
              className="btn quiet sm"
              disabled={busy !== null}
              onClick={() => void run("download")}
            >
              {busy === "download"
                ? "Préparation…"
                : done === "download"
                  ? "Téléchargé"
                  : "Télécharger"}
            </button>
          </div>
        </Row>
      </div>
    </>
  );
}

/**
 * The single agent + model menu of one coordinator route: the favorites (or every model when
 * there are none), grouped by agent, with the chosen agent's badge beside it.
 */
function RouteSelect(props: {
  kind: RouteKind;
  agents: AgentInfo[];
  favorites: Favorites;
  route: { agentId: string; model?: string } | undefined;
  showAll: boolean;
}) {
  const { kind, route } = props;
  const { groups } = routeChoices(props.agents, props.favorites, route, props.showAll);
  const agent = route && props.agents.find((a) => a.id === route.agentId);
  return (
    <label className="set-select set-route">
      {route && <AgentBadge agent={agent ?? { id: route.agentId, short: "?" }} small />}
      <select
        aria-label={`Modèle pour ${KIND_LABEL[kind]}`}
        value={route ? routeValue(route.agentId, route.model) : ""}
        onChange={(e) => {
          const picked = parseRouteValue(e.target.value);
          connection.send({
            type: "coordinator.setRoute",
            kind,
            ...(picked ? { agentId: picked.agentId } : {}),
            ...(picked?.model ? { model: picked.model } : {}),
          });
        }}
      >
        <option value="">{kind === "default" ? "Agent du coordinateur" : "Par défaut"}</option>
        {groups.map((g) => (
          <optgroup key={g.agent.id} label={g.agent.name}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** One section of the settings; every value here is real and takes effect at once. */
export function SettingsPage(props: {
  section: SettingsSection;
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
}) {
  // Kept by the server: the same on every device.
  const { permissionMode: mode, isolated } = useDefaults();
  // The coordinator's menus: favorites only, until « Afficher tous les modèles ».
  const [allModels, setAllModels] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const title = SECTIONS.find((s) => s.id === props.section)?.label ?? "";

  let body: ReactNode;
  switch (props.section) {
    case "general":
      body = (
        <>
          <div className="set-card">
            <Row
              title="Projet par défaut"
              text="Les nouvelles discussions démarrent dans ce projet."
            >
              {props.projects.some((p) => !p.locked) ? (
                <label className="set-select">
                  <IconFolder size={14} />
                  <select
                    aria-label="Projet par défaut"
                    value={props.projectId ?? ""}
                    onChange={(e) => props.onPickProject(e.target.value)}
                  >
                    {props.projects
                      .filter((p) => !p.locked)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <span className="set-note">Aucun projet</span>
              )}
            </Row>
            <Row
              title="Autorisations par défaut"
              text={
                mode === "full"
                  ? "Accès complet : l'agent agit sans demander."
                  : "Supervisé : l'agent demande avant de modifier ou de lancer quoi que ce soit."
              }
            >
              <Seg
                label="Autorisations par défaut"
                value={mode}
                choices={[
                  { id: "supervised", name: "Supervisé" },
                  { id: "full", name: "Accès complet" },
                ]}
                onPick={(value) => setDefault({ permissionMode: value })}
              />
            </Row>
            <Row
              title="Branche à part"
              text="Dans un projet git, chaque nouvelle discussion travaille sur sa propre branche, dans une copie à part."
            >
              <Toggle
                label="Branche à part"
                on={isolated}
                onChange={(on) => setDefault({ isolated: on })}
              />
            </Row>
            <NotificationsRow />
          </div>
          <LockCard projects={props.projects} lockPin={props.lockPin} />
          <AppUpdateSettings row={Row} toggle={Toggle} />
          <DiagnosticsCard />
        </>
      );
      break;
    case "appearance":
      body = (
        <div className="set-card">
          <Row title="Thème" text="Sur cet appareil seulement.">
            <Seg
              label="Thème"
              value={theme}
              choices={[
                { id: "system", name: "Système" },
                { id: "light", name: "Clair" },
                { id: "dark", name: "Sombre" },
              ]}
              onPick={(value: Theme) => setTheme(value)}
            />
          </Row>
        </div>
      );
      break;
    case "agents":
      body = (
        <>
          <div className="set-card">
            {props.agents.map((a) => (
              <div key={a.id} className="set-row">
                <AgentBadge agent={a} />
                <div className="set-tx">
                  <b>{a.name}</b>
                  <p>
                    {!a.available
                      ? (a.hint ?? "Pas trouvé sur cette machine.")
                      : a.check?.signInNeeded
                        ? `Connexion requise${a.login ? ` : ${a.login}` : ""}`
                        : (a.check?.version ?? a.command ?? "Prêt")}
                  </p>
                </div>
                <span
                  className={`set-dot ${
                    !a.available
                      ? "off"
                      : a.check?.signInNeeded || a.check?.ok === false
                        ? "warn"
                        : "ok"
                  }`}
                  aria-hidden
                />
              </div>
            ))}
          </div>
          <button className="btn" onClick={props.onOpenConnections}>
            <IconPlug size={14} />
            Vérifier ou ajouter un agent
          </button>
        </>
      );
      break;
    case "mascots":
      body = <MascotSettings agents={props.agents} />;
      break;
    case "models":
      body = <ModelFavorites agents={props.agents} favorites={props.favorites} />;
      break;
    case "coordinator": {
      const named = (m: TeamMember) => {
        const agent = props.agents.find((a) => a.id === m.agentId);
        const model = modelNameOf(agent?.models, m.model);
        return `${agent?.name ?? m.agentId}${model ? ` · ${model}` : ""}`;
      };
      const team = props.coordinator.team;
      const hasFavorites = routeChoices(
        props.agents,
        props.favorites,
        undefined,
        false,
      ).favoritesOnly;
      body = (
        <>
          <p className="set-empty">
            Quand un coordinateur ouvre un fil, il l'envoie au modèle choisi ici pour ce type de
            travail, sinon à celui de « Par défaut ». Sans aucun choix, le fil garde l'agent et le
            modèle du coordinateur. La liste montre tes modèles favoris ; sans favori, tous les
            modèles.
          </p>
          <div className="set-card">
            {ROUTE_KINDS.map((kind) => {
              const route = props.coordinator.routes[kind];
              return (
                <Row key={kind} title={KIND_LABEL[kind]}>
                  <RouteSelect
                    kind={kind}
                    agents={props.agents}
                    favorites={props.favorites}
                    route={route}
                    showAll={allModels}
                  />
                </Row>
              );
            })}
          </div>
          {hasFavorites && (
            <button
              className="btn quiet sm set-more"
              aria-pressed={allModels}
              onClick={() => setAllModels((on) => !on)}
            >
              {allModels ? "Seulement mes favoris" : "Afficher tous les modèles"}
            </button>
          )}
          <div className="set-card">
            <Row
              title="Fils en même temps"
              text="Au-delà, les fils qu'un coordinateur ouvre attendent en file et démarrent dès qu'une place se libère."
            >
              <label className="set-select">
                <select
                  aria-label="Fils en même temps"
                  value={props.coordinator.parallel ?? DEFAULT_PARALLEL}
                  onChange={(e) =>
                    connection.send({
                      type: "coordinator.setParallel",
                      parallel: Number(e.target.value),
                    })
                  }
                >
                  {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </Row>
            <Row
              title="Tours en même temps sur tout le serveur"
              text="Au-delà, ce que lancent un coordinateur, une équipe ou une tâche planifiée attend en file. Ce que tu envoies toi-même part toujours."
            >
              <label className="set-select">
                <select
                  aria-label="Tours en même temps sur tout le serveur"
                  value={props.coordinator.maxTurns ?? DEFAULT_MAX_TURNS}
                  onChange={(e) =>
                    connection.send({
                      type: "server.setMaxTurns",
                      maxTurns: Number(e.target.value),
                    })
                  }
                >
                  {Array.from({ length: MAX_MAX_TURNS }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </Row>
            <Row
              title="Équipe lancée par un coordinateur"
              text={
                team
                  ? `Chef : ${named(team.lead)}. ${team.coders} codeur${team.coders > 1 ? "s" : ""} : ${named(team.coder)}.${
                      team.reviewer ? ` Relecture : ${named(team.reviewer)}.` : ""
                    }${team.tester ? ` Tests : ${named(team.tester)}.` : ""}${
                      team.merger ? ` Fusion : ${named(team.merger)}.` : ""
                    } C'est la dernière équipe que tu as lancée avec /equipe.`
                  : "Aucune pour l'instant. Lance une équipe toi-même une fois avec /equipe : un coordinateur reprendra la même."
              }
            />
          </div>
        </>
      );
      break;
    }
    case "mcp":
      body = (
        <>
          {props.mcpSecretsError && <p className="error">{props.mcpSecretsError}</p>}
          {props.mcpServers.length ? (
            <div className="set-card">
              {props.mcpServers.map((s) => (
                <Row
                  key={s.id}
                  title={s.name}
                  text={`${s.transport === "http" ? "HTTP" : "Commande"} · ${s.target} · ${mcpScopeLabel(scopeOf(s), props.projects)}`}
                >
                  <span className={`set-tag${s.enabled ? " on" : ""}`}>
                    {s.enabled ? "Actif" : "Désactivé"}
                  </span>
                </Row>
              ))}
            </div>
          ) : (
            <p className="set-empty">
              Aucun serveur MCP. Ceux que tu ajoutes ici sont donnés aux agents, pour tous les
              projets ou ceux que tu choisis.
            </p>
          )}
          <button className="btn" onClick={props.onOpenMcp}>
            <IconPlug size={14} />
            Gérer les serveurs MCP
          </button>
        </>
      );
      break;
    case "teams":
      body = <TeamPresets agents={props.agents} projectId={props.projectId} />;
      break;
    case "remote":
      body = <RemoteAccess />;
      break;
    case "subscriptions":
      body = <Subscriptions agents={props.agents} />;
      break;
  }

  return (
    <div className="view set-view">
      <div className="set-page">
        <h1>{title}</h1>
        {body}
      </div>
    </div>
  );
}
