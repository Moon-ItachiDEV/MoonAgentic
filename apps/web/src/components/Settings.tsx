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
} from "@moonagentic/protocol";
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
import { readPref, writePref } from "../prefs.ts";
import type { SettingsSection } from "../router.ts";
import { matchSections } from "../settings-search.ts";
import { isDark, readTheme, setTheme, subscribeTheme, type Theme } from "../theme.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import {
  IconArrowLeft,
  IconBranch,
  IconFolder,
  IconGauge,
  IconGear,
  IconMoon,
  IconSearch,
  IconSun,
  IconPlug,
  IconShield,
  IconStar,
  IconWifi,
  IconX,
} from "./icons.tsx";
import { RemoteAccess } from "./RemoteAccess.tsx";
import { Subscriptions } from "./Subscriptions.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "Général", icon: <IconGear size={15} /> },
  { id: "appearance", label: "Apparence", icon: <span className="set-half" aria-hidden /> },
  { id: "agents", label: "Agents", icon: <IconShield size={15} /> },
  { id: "models", label: "Modèles", icon: <IconStar size={15} /> },
  { id: "subscriptions", label: "Abonnements", icon: <IconGauge size={15} /> },
  { id: "coordinator", label: "Coordinateur", icon: <IconBranch size={15} /> },
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
          : "Sur cet appareil, quand un fil attend ta réponse ou qu'une équipe termine ou échoue, sauf si tu as déjà MoonAgentic sous les yeux. Il faut qu'il reste ouvert dans un onglet, même en arrière-plan.";
  return (
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
  );
}

/** One section of the settings; every value here is real and takes effect at once. */
export function SettingsPage(props: {
  section: SettingsSection;
  agents: AgentInfo[];
  favorites: Favorites;
  coordinator: CoordinatorSettings;
  projects: Project[];
  projectId: string | undefined;
  mcpServers: McpServerInfo[];
  mcpSecretsError?: string | null;
  onPickProject: (id: string) => void;
  onOpenConnections: () => void;
  onOpenMcp: () => void;
}) {
  const [mode, setMode] = useState(() =>
    readPref("permissionMode") === "full" ? "full" : "supervised",
  );
  const [isolated, setIsolated] = useState(() => readPref("isolated") !== "false");
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const title = SECTIONS.find((s) => s.id === props.section)?.label ?? "";

  let body: ReactNode;
  switch (props.section) {
    case "general":
      body = (
        <div className="set-card">
          <Row title="Projet par défaut" text="Les nouvelles discussions démarrent dans ce projet.">
            {props.projects.length ? (
              <label className="set-select">
                <IconFolder size={14} />
                <select
                  aria-label="Projet par défaut"
                  value={props.projectId ?? ""}
                  onChange={(e) => props.onPickProject(e.target.value)}
                >
                  {props.projects.map((p) => (
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
              onPick={(value) => {
                setMode(value);
                writePref("permissionMode", value);
              }}
            />
          </Row>
          <Row
            title="Branche à part"
            text="Dans un projet git, chaque nouvelle discussion travaille sur sa propre branche, dans une copie à part."
          >
            <Toggle
              label="Branche à part"
              on={isolated}
              onChange={(on) => {
                setIsolated(on);
                writePref("isolated", String(on));
              }}
            />
          </Row>
          <NotificationsRow />
        </div>
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
    case "models": {
      const withFavorites = props.agents.filter((a) => props.favorites[a.id]?.length);
      body = withFavorites.length ? (
        <div className="set-card">
          {withFavorites.map((a) => (
            <div key={a.id} className="set-row top">
              <AgentBadge agent={a} />
              <div className="set-tx">
                <b>{a.name}</b>
                <div className="set-chips">
                  {(props.favorites[a.id] ?? []).map((m) => (
                    <span key={m} className="set-chip">
                      {a.models?.find((x) => x.id === m)?.name ?? m}
                      <button
                        aria-label={`Retirer ${m} des favoris`}
                        onClick={() =>
                          connection.send({
                            type: "favorites.toggle",
                            agentId: a.id,
                            model: m,
                            starred: false,
                          })
                        }
                      >
                        <IconX size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="set-empty">
          Aucun favori pour l'instant. Ouvre le menu modèle du composer, puis « Tous », et touche
          l'étoile d'un modèle : il rejoint la roue des favoris.
        </p>
      );
      break;
    }
    case "coordinator": {
      const ready = props.agents.filter((a) => a.available);
      const named = (m: TeamMember) => {
        const agent = props.agents.find((a) => a.id === m.agentId);
        const model = m.model && (agent?.models?.find((x) => x.id === m.model)?.name ?? m.model);
        return `${agent?.name ?? m.agentId}${model ? ` · ${model}` : ""}`;
      };
      const team = props.coordinator.team;
      body = (
        <>
          <p className="set-empty">
            Quand un coordinateur ouvre un fil, il l'envoie à l'agent choisi ici pour ce type de
            travail, sinon à celui de « Par défaut ». Sans aucun choix, le fil garde l'agent et le
            modèle du coordinateur.
          </p>
          <div className="set-card">
            {ROUTE_KINDS.map((kind) => {
              const route = props.coordinator.routes[kind];
              const agent = props.agents.find((a) => a.id === route?.agentId);
              const set = (agentId: string, model?: string) =>
                connection.send({
                  type: "coordinator.setRoute",
                  kind,
                  ...(agentId ? { agentId } : {}),
                  ...(agentId && model ? { model } : {}),
                });
              return (
                <Row key={kind} title={KIND_LABEL[kind]}>
                  <label className="set-select">
                    <select
                      aria-label={`Agent pour ${KIND_LABEL[kind]}`}
                      value={route?.agentId ?? ""}
                      onChange={(e) => set(e.target.value)}
                    >
                      <option value="">
                        {kind === "default" ? "Agent du coordinateur" : "Par défaut"}
                      </option>
                      {/* A route to an agent that is gone stays shown, so it can be changed. */}
                      {route && !ready.some((a) => a.id === route.agentId) && (
                        <option value={route.agentId}>
                          {agent?.name ?? route.agentId} (indisponible)
                        </option>
                      )}
                      {ready.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {route && !!agent?.models?.length && (
                    <label className="set-select">
                      <select
                        aria-label={`Modèle pour ${KIND_LABEL[kind]}`}
                        value={route.model ?? ""}
                        onChange={(e) => set(route.agentId, e.target.value)}
                      >
                        <option value="">Modèle par défaut</option>
                        {agent.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </Row>
              );
            })}
          </div>
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
                  text={`${s.transport === "http" ? "HTTP" : "Commande"} · ${s.target}`}
                >
                  <span className={`set-tag${s.enabled ? " on" : ""}`}>
                    {s.enabled ? "Actif" : "Désactivé"}
                  </span>
                </Row>
              ))}
            </div>
          ) : (
            <p className="set-empty">
              Aucun serveur MCP. Ceux que tu ajoutes ici sont donnés à chaque agent.
            </p>
          )}
          <button className="btn" onClick={props.onOpenMcp}>
            <IconPlug size={14} />
            Gérer les serveurs MCP
          </button>
        </>
      );
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
