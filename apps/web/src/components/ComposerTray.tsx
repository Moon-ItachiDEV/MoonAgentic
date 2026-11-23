// The parts of composer « Plateau » around the text box: the access chip and its menu, the tray
// under the box (project, branch, MCP servers, quota warning) and the messages waiting in line.
// Each menu opens 6 px above the button that opened it, edge-aligned with it.
import type { McpServerInfo, PermissionMode, Project } from "@moonagentic/protocol";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  IconBolt,
  IconBranch,
  IconCaret,
  IconCheck,
  IconClose,
  IconFolderFine,
  IconHand,
  IconPlus,
  IconSwap,
} from "./icons.tsx";
import { Presence } from "./Presence.tsx";
import { mcpInProject } from "../mcp-scope.ts";

/** Closes a menu on a press outside `root`, or on Escape, which gives the focus back to `back`. */
export function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onClose: () => void,
  back?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close.current();
      back?.current?.focus();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
}

/** Up and down arrows move between a menu's items, as in the mockup. */
export function arrowKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(at + step + items.length) % items.length]?.focus();
}

/** A small menu anchored to its button. `side` says which edge it lines up with. */
function Anchored(props: {
  open: boolean;
  side: "left" | "right";
  width: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <Presence show={props.open}>
      <div
        className={`menu anchored ${props.side}`}
        role="menu"
        aria-label={props.label}
        style={{ "--w": `${props.width}px` } as React.CSSProperties}
        onKeyDown={arrowKeys}
      >
        {props.children}
      </div>
    </Presence>
  );
}

/** The access mode: two choices that say what they mean, instead of a silent toggle. */
export function AccessChip(props: {
  mode: PermissionMode;
  open: boolean;
  narrow: boolean;
  disabled: boolean;
  onToggle: (open: boolean) => void;
  onPick: (mode: PermissionMode) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(props.open, root, () => props.onToggle(false), button);
  const full = props.mode === "full";
  const row = (mode: PermissionMode, icon: ReactNode, title: string, text: string) => (
    <button
      role="menuitemradio"
      aria-checked={props.mode === mode}
      onClick={() => props.onPick(mode)}
    >
      <span className={`ca-ic${mode === "full" ? " warn" : ""}`}>{icon}</span>
      <span className="tx">
        {title}
        <small>{text}</small>
      </span>
      <span className="on-mark">{props.mode === mode && <IconCheck />}</span>
    </button>
  );
  return (
    <div className="ca-wrap" ref={root}>
      <button
        ref={button}
        className={`chip access${full ? " full" : ""}`}
        aria-label={`Mode d'accès : ${full ? "accès complet" : "demande d'abord"}`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        disabled={props.disabled}
        onClick={() => props.onToggle(!props.open)}
      >
        {full ? <IconBolt /> : <IconHand />}
        {!props.narrow && <span>{full ? "Accès complet" : "Demande d'abord"}</span>}
        <IconCaret />
      </button>
      <Anchored open={props.open} side="left" width={300} label="Mode d'accès">
        <div className="menu-h">Avant d'agir, l'agent…</div>
        {row(
          "supervised",
          <IconHand />,
          "Demande d'abord",
          "L'agent te demande avant de modifier un fichier ou de lancer une commande.",
        )}
        {row(
          "full",
          <IconBolt />,
          "Accès complet",
          "L'agent agit sans demander. À garder pour les tâches que tu surveilles.",
        )}
        {!props.narrow && (
          <div className="menu-foot">
            <kbd>Maj</kbd> <kbd>Tab</kbd> dans le texte pour basculer
          </div>
        )}
      </Anchored>
    </div>
  );
}

export interface TrayQuota {
  level: "warn" | "full";
  /** Percent of the tightest window used, for the meter. */
  usedPercent: number;
  text: string;
  when?: string;
  /** The agent with the most room left, to hand over to. */
  roomier?: { id: string; name: string };
  onSwitch?: () => void;
  onLimits?: () => void;
  onDismiss: () => void;
}

type TrayMenu = "project" | "branch" | "mcp";

/** The sunken tray under the box: where the agent works, and with which MCP servers. */
export function Tray(props: {
  menu: TrayMenu | null;
  onMenu: (menu: TrayMenu | null) => void;
  narrow: boolean;
  project: Project | undefined;
  /** The projects a new conversation can start in; absent in a thread, whose project is set. */
  projects?: Project[];
  onPickProject?: (id: string) => void;
  onNewProject: () => void;
  /** A new conversation in a git project: whether the agent gets its own branch. */
  isolated?: { on: boolean; onPick: (on: boolean) => void };
  /** A thread's own branch, once it has one. */
  branch?: string;
  mcpServers: McpServerInfo[];
  onMcp: () => void;
  quota?: TrayQuota;
  /** Dictation under way: the tray says how to end it, and cancels it on a touch. */
  voice?: { onStop: () => void; onCancel: () => void };
}) {
  const root = useRef<HTMLDivElement>(null);
  useDismiss(!!props.menu, root, () => props.onMenu(null));
  const toggle = (menu: TrayMenu) => props.onMenu(props.menu === menu ? null : menu);
  // Those this conversation's agent is given: for every project, or for this one.
  const servers = props.mcpServers.filter((s) => s.enabled && mcpInProject(s, props.project?.id));
  const { quota } = props;

  if (props.voice)
    return (
      <div className="tray">
        <button className="tb hint" onClick={props.voice.onStop}>
          <kbd>Entrée</kbd> terminer
        </button>
        <button className="tb hint" onClick={props.voice.onCancel}>
          <kbd>Échap</kbd> annuler
        </button>
      </div>
    );

  const context = (
    <>
      {props.project && (
        <div className="tray-at">
          <button
            className="tb"
            aria-haspopup={props.projects ? "menu" : undefined}
            aria-expanded={props.projects ? props.menu === "project" : undefined}
            title={props.project.path}
            onClick={() => (props.projects ? toggle("project") : undefined)}
            disabled={!props.projects}
          >
            <IconFolderFine />
            <span>{props.project.name}</span>
          </button>
          {props.projects && (
            <Anchored open={props.menu === "project"} side="left" width={300} label="Projet">
              <div className="menu-h">Projet</div>
              {props.projects.map((p) => (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={p.id === props.project?.id}
                  onClick={() => {
                    props.onPickProject?.(p.id);
                    props.onMenu(null);
                  }}
                >
                  <span className="ca-ic">
                    <IconFolderFine />
                  </span>
                  <span className="tx">
                    {p.name}
                    <small className="one">{p.path}</small>
                  </span>
                  <span className="on-mark">{p.id === props.project?.id && <IconCheck />}</span>
                </button>
              ))}
              <div className="menu-sep" role="separator" />
              <button
                role="menuitem"
                onClick={() => {
                  props.onMenu(null);
                  props.onNewProject();
                }}
              >
                <span className="ca-ic plain">
                  <IconPlus size={14} />
                </span>
                <span className="tx">Nouveau projet</span>
              </button>
            </Anchored>
          )}
        </div>
      )}
      {(props.isolated || props.branch) && <span className="dv" aria-hidden />}
      {props.isolated && (
        <div className="tray-at">
          <button
            className={`tb${props.isolated.on ? " on" : ""}`}
            aria-haspopup="menu"
            aria-expanded={props.menu === "branch"}
            onClick={() => toggle("branch")}
          >
            <IconBranch size={14} />
            <span>{props.isolated.on ? "branche à part" : "dans ton dossier"}</span>
          </button>
          <Anchored open={props.menu === "branch"} side="left" width={290} label="Branche">
            <div className="menu-h">L'agent travaille…</div>
            {[false, true].map((on) => (
              <button
                key={String(on)}
                role="menuitemradio"
                aria-checked={props.isolated!.on === on}
                onClick={() => {
                  props.isolated!.onPick(on);
                  props.onMenu(null);
                }}
              >
                <span className="ca-ic">{on ? <IconBranch size={14} /> : <IconFolderFine />}</span>
                <span className="tx">
                  {on ? "Sur une branche à part" : "Dans ton dossier"}
                  <small>
                    {on
                      ? "Dans une copie du projet. Tu fusionnes quand c'est prêt."
                      : "Directement sur la branche où tu es."}
                  </small>
                </span>
                <span className="on-mark">{props.isolated!.on === on && <IconCheck />}</span>
              </button>
            ))}
          </Anchored>
        </div>
      )}
      {!props.isolated && props.branch && (
        <span className="tb static on" title="La branche de cette discussion">
          <IconBranch size={14} />
          <span className="br">{props.branch}</span>
        </span>
      )}
      <span className="grow" />
      {servers.length > 0 && (
        <div className="tray-at">
          <button
            className="tb"
            aria-haspopup="menu"
            aria-expanded={props.menu === "mcp"}
            aria-label={`Serveurs MCP : ${servers.length}`}
            onClick={() => toggle("mcp")}
          >
            <span>{props.narrow ? "MCP" : "Serveurs MCP"}</span>
            <span className="mcp" aria-hidden>
              {servers.slice(0, 4).map((s) => (
                <span key={s.id} style={{ background: mcpColor(s.name) }}>
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </span>
          </button>
          <Anchored open={props.menu === "mcp"} side="right" width={280} label="Serveurs MCP">
            <div className="menu-h">Serveurs MCP</div>
            {servers.map((s) => (
              <div key={s.id} className="mcp-row">
                <span className="mcp-b" style={{ background: mcpColor(s.name) }} aria-hidden>
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="tx">
                  {s.name}
                  <small className="one">{s.transport === "http" ? s.target : "local"}</small>
                </span>
              </div>
            ))}
            <div className="menu-foot">
              <span className="grow">
                {props.project ? "Donnés aux fils de ce projet" : "Donnés à cette discussion"}
              </span>
              <button
                className="lnk"
                onClick={() => {
                  props.onMenu(null);
                  props.onMcp();
                }}
              >
                Gérer
              </button>
            </div>
          </Anchored>
        </div>
      )}
    </>
  );

  if (!quota)
    return (
      <div className="tray" ref={root}>
        {context}
      </div>
    );
  const full = quota.level === "full";
  return (
    <div className={`tray q2 ${full ? "e" : "w"}`} ref={root}>
      <div className="qrow" role="status">
        <span className="meter" aria-hidden>
          <i style={{ width: `${Math.min(100, quota.usedPercent)}%` }} />
        </span>
        <span className="qt">
          {quota.text}
          {!props.narrow && quota.when && <span className="qw"> {quota.when}</span>}
        </span>
        {quota.roomier && quota.onSwitch ? (
          <button className="qa" onClick={quota.onSwitch}>
            <IconSwap />
            {props.narrow ? quota.roomier.name : `Passer à ${quota.roomier.name}`}
          </button>
        ) : (
          quota.onLimits && (
            <button className="qa" onClick={quota.onLimits}>
              Voir les limites
            </button>
          )
        )}
        <button className="qx" aria-label="Masquer cet avertissement" onClick={quota.onDismiss}>
          <IconClose />
        </button>
      </div>
      <div className="crow">{context}</div>
    </div>
  );
}

/** A server's badge colour, steady for its name: the servers carry no colour of their own. */
function mcpColor(name: string): string {
  const colors = ["#24292f", "#7b3fe4", "#336791", "#0d9488", "#c2563a", "#2b7fd1"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length]!;
}
