import type { AgentInfo, Favorites, McpServerInfo, Project } from "@moonagentic/protocol";
import { type ReactNode, useState } from "react";
import { connection } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import type { SettingsSection } from "../router.ts";
import { readTheme, setTheme, type Theme } from "../theme.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconBack, IconFolder, IconGear, IconPlug, IconShield, IconStar, IconX } from "./icons.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "Général", icon: <IconGear size={15} /> },
  { id: "appearance", label: "Apparence", icon: <span className="set-half" aria-hidden /> },
  { id: "agents", label: "Agents", icon: <IconShield size={15} /> },
  { id: "models", label: "Modèles", icon: <IconStar size={15} /> },
  { id: "mcp", label: "Serveurs MCP", icon: <IconPlug size={15} /> },
];

/** The sidebar while in the settings: back to the app, then one entry per section. */
export function SettingsNav(props: {
  section: SettingsSection;
  onPick: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <aside className="side set-side" aria-label="Réglages">
      <button className="set-back" onClick={props.onBack}>
        <IconBack />
        Retour
      </button>
      <nav className="set-nav">
        {SECTIONS.map((s) => (
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
      </nav>
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

function Toggle(props: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      className={`set-sw${props.on ? " on" : ""}`}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/** One section of the settings; every value here is real and takes effect at once. */
export function SettingsPage(props: {
  section: SettingsSection;
  agents: AgentInfo[];
  favorites: Favorites;
  projects: Project[];
  projectId: string | undefined;
  mcpServers: McpServerInfo[];
  onPickProject: (id: string) => void;
  onOpenConnections: () => void;
  onOpenMcp: () => void;
}) {
  const [mode, setMode] = useState(() =>
    readPref("permissionMode") === "full" ? "full" : "supervised",
  );
  const [isolated, setIsolated] = useState(() => readPref("isolated") !== "false");
  const [theme, setThemeState] = useState<Theme>(readTheme);
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
              onPick={(value) => {
                setThemeState(value);
                setTheme(value);
              }}
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
    case "mcp":
      body = (
        <>
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
