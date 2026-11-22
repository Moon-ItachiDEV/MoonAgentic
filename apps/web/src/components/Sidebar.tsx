import type { Thread } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { useEffect, useRef, useState } from "react";
import { readPref, writePref } from "../prefs.ts";
import { RECENT, recentAlwaysShown } from "../recent.ts";
import {
  childrenOf as membersOf,
  conversationsByProject,
  lineStatus,
  projectOpen,
  type LineStatus,
} from "../sidebar-tree.ts";
import {
  IconArchive,
  IconBoard,
  IconChevron,
  IconClose,
  IconCompose,
  IconFolder,
  IconGear,
  IconMore,
  IconPin,
  IconPlug,
  IconPlus,
  IconSearch,
  IconShield,
} from "./icons.tsx";
import { Wordmark } from "./MoonMark.tsx";
import { Presence } from "./Presence.tsx";

/** A menu this tall always fits: it opens upwards when the row is that close to the bottom. */
const MENU_ROOM = 150;

function ThreadStatus({ status }: { status: LineStatus }) {
  if (status === "running") return <span className="spin" aria-label="En cours" />;
  if (status === "waiting")
    return <span className="dot" title="Attend ta réponse" aria-label="Attend ta réponse" />;
  if (status === "error") return <span className="dot err" title="Erreur" aria-label="Erreur" />;
  return null;
}

export function Sidebar(props: {
  state: State;
  activeThreadId: string | undefined;
  activeProjectId: string | undefined;
  /** True on the planner's page. */
  onPlanner: boolean;
  onOpenPlanner: () => void;
  onNewThread: () => void;
  onNewProject: () => void;
  onOpenConnections: () => void;
  onOpenRequests: () => void;
  /** Shows the project: its planner on the planner's page, else its new conversation. */
  onPickProject: (id: string) => void;
  /** Starts a new conversation in the project. */
  onNewInProject: (id: string) => void;
  onOpenThread: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onSetArchived: (id: string, archived: boolean) => void;
  /** Asks before deleting the thread. */
  onDeleteThread: (thread: Thread) => void;
  onRemoveProject: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}) {
  const { state } = props;
  const available = state.agents.filter((a) => a.available).length;
  const [showArchived, setShowArchived] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(() => readPref("projectsOpen") !== "false");
  // Each project folded or not, as the user left it.
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(readPref("projectFolds") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const setFold = (id: string, open: boolean) => {
    const next = { ...folds, [id]: open };
    setFolds(next);
    writePref("projectFolds", JSON.stringify(next));
  };
  // Projects and teams whose every line is shown, past « Voir plus », or whose members are.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(unfolded);
    if (!next.delete(key)) next.add(key);
    setUnfolded(next);
  };

  // The row whose « … » menu is open, and where its button is on screen.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; up: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuThread = state.threads.find((t) => t.id === menu?.id);
  const menuOpen = !!menu && !!menuThread;
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Element;
      // Its own button closes it by itself.
      if (!menuRef.current?.contains(target) && !target.closest(".thr-row .acts")) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setMenu(null);
    const moved = () => setMenu(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", moved);
    };
  }, [menuOpen]);
  const act = (run: () => void) => () => {
    setMenu(null);
    run();
  };

  const live = state.threads.filter((t) => !t.archived);
  const archived = state.threads.filter((t) => t.archived);
  const members = membersOf(live);
  const byProject = conversationsByProject(live);
  const active = live.find((t) => t.id === props.activeThreadId);
  const activeLead =
    active?.parentId && members.has(active.parentId) ? active.parentId : active?.id;
  // Opening a thread unfolds its project and its team, once: a chevron folds them again.
  const activeProject = active?.projectId;
  useEffect(() => {
    if (activeProject && folds[activeProject] === false) setFold(activeProject, true);
    // Its members may come later, as a team starts: the lead is unfolded beforehand.
    if (activeLead) {
      setUnfolded(
        (now) => new Set([...now, ...["", "pin:", "recent:"].map((k) => k + activeLead)]),
      );
    }
    // Only when the open thread changes, not on every fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject, activeLead]);
  const known = new Set(state.projects.map((p) => p.id));
  const pinned = [...byProject.values()].flat().filter((t) => t.pinned);
  // Across projects, only when there are several; a thread whose project is gone too.
  const recent = [...byProject.values()]
    .flat()
    .filter((t) => !t.pinned && (state.projects.length > 1 || !known.has(t.projectId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT);

  // A team on one line, its members folded under it unless asked or one of them is open.
  const tree = (t: Thread, prefix: string) => {
    const team = members.get(t.id) ?? [];
    const open = team.length > 0 && unfolded.has(`${prefix}${t.id}`);
    return [
      row(t, {
        status: lineStatus(t, open ? [] : team),
        team: team.length ? { open, toggle: () => toggle(`${prefix}${t.id}`) } : undefined,
        key: `${prefix}${t.id}`,
      }),
      ...(open ? team.map((c) => row(c, { child: true, key: `${prefix}${c.id}` })) : []),
    ];
  };
  const row = (
    t: Thread,
    opts: {
      key: string;
      child?: boolean;
      status?: LineStatus;
      team?: { open: boolean; toggle: () => void } | undefined;
    },
  ) => (
    <div
      key={opts.key}
      className={`thr-row has-more${t.pinned ? " pinned" : ""}${opts.child ? " child" : ""}${opts.team ? " lead" : ""}${menu?.id === t.id ? " menu-open" : ""}`}
    >
      {opts.team && (
        <button
          className={`fold-team${opts.team.open ? " open" : ""}`}
          aria-expanded={opts.team.open}
          aria-label={`${opts.team.open ? "Replier" : "Déplier"} l'équipe ${t.title}`}
          onClick={opts.team.toggle}
        >
          <IconChevron size={11} />
        </button>
      )}
      <button
        className={`thr${t.id === props.activeThreadId ? " on" : ""}`}
        onClick={() => props.onOpenThread(t.id)}
      >
        <span className="t">{t.title}</span>
        <ThreadStatus status={opts.status ?? lineStatus(t)} />
      </button>
      {/* A pinned thread keeps its pin in sight; the rest is behind « … ». */}
      {!t.archived && t.pinned && (
        <button
          className="pin"
          aria-pressed
          aria-label={`Désépingler ${t.title}`}
          title="Désépingler"
          onClick={() => props.onTogglePin(t.id, false)}
        >
          <IconPin filled />
        </button>
      )}
      <button
        className="pin acts"
        aria-label={`Actions de ${t.title}`}
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={menu?.id === t.id}
        onClick={(e) => {
          if (menu?.id === t.id) return setMenu(null);
          const box = e.currentTarget.getBoundingClientRect();
          const up = box.bottom + MENU_ROOM > window.innerHeight;
          setMenu({ id: t.id, x: box.right, y: up ? box.top - 4 : box.bottom + 4, up });
        }}
      >
        <IconMore size={15} />
      </button>
    </div>
  );

  const project = (p: State["projects"][number]) => {
    // Pinned ones too: « Épinglés » is a shortcut, the project still holds them.
    const all = byProject.get(p.id) ?? [];
    const open = projectOpen(folds[p.id], state.projects.length === 1);
    const { always, foldable } = recentAlwaysShown(all, members, props.activeThreadId);
    const more = unfolded.has(`more:${p.id}`);
    const count = byProject.get(p.id)?.length ?? 0;
    return [
      <div key={p.id} className={`thr-row proj${open ? " open" : ""}`}>
        <button
          className="fold-proj"
          aria-expanded={open}
          aria-label={`${open ? "Replier" : "Déplier"} le projet ${p.name}`}
          onClick={() => setFold(p.id, !open)}
        >
          <IconFolder />
          <IconChevron size={11} />
        </button>
        <button
          className={`thr${!props.activeThreadId && p.id === props.activeProjectId ? " on" : ""}`}
          title={p.path}
          onClick={() => {
            if (!open) setFold(p.id, true);
            props.onPickProject(p.id);
          }}
        >
          <span className="t">{p.name}</span>
          <span className="aux" title={`${count} discussion${count > 1 ? "s" : ""}`}>
            {count || ""}
          </span>
        </button>
        <button
          className="pin new"
          aria-label={`Nouvelle discussion dans ${p.name}`}
          title="Nouvelle discussion"
          onClick={() => props.onNewInProject(p.id)}
        >
          <IconPlus size={14} />
        </button>
        <button
          className="pin"
          aria-label={`Retirer le projet ${p.name}`}
          title="Retirer de MoonAgentic"
          onClick={() => props.onRemoveProject(p.id)}
        >
          <IconClose />
        </button>
      </div>,
      open && (
        <div key={`${p.id}:items`} className="proj-items">
          {[
            ...(all.length === 0
              ? [
                  <div key={`${p.id}:empty`} className="empty-note">
                    Aucune discussion.
                  </div>,
                ]
              : []),
            ...(more ? all : always).flatMap((t) => tree(t, "")),
            ...(foldable > 0
              ? [
                  <button
                    key={`${p.id}:more`}
                    className="more"
                    aria-expanded={more}
                    onClick={() => toggle(`more:${p.id}`)}
                  >
                    {more ? "Voir moins" : `Voir plus (${foldable})`}
                  </button>,
                ]
              : []),
          ]}
        </div>
      ),
    ];
  };

  return (
    <aside className="side" onScrollCapture={() => menu && setMenu(null)}>
      <Presence show={menuOpen}>
        {menu && menuThread && (
          <>
            <div className="menu-scrim" onClick={() => setMenu(null)} />
            <div
              ref={menuRef}
              className={`menu row-menu${menu.up ? " up" : ""}`}
              role="menu"
              aria-label={`Actions de ${menuThread.title}`}
              style={{ "--x": `${menu.x}px`, "--y": `${menu.y}px` } as React.CSSProperties}
            >
              {!menuThread.archived && (
                <button
                  role="menuitem"
                  onClick={act(() => props.onTogglePin(menuThread.id, !menuThread.pinned))}
                >
                  <IconPin filled={!!menuThread.pinned} />
                  {menuThread.pinned ? "Désépingler" : "Épingler"}
                </button>
              )}
              <button
                role="menuitem"
                onClick={act(() => props.onSetArchived(menuThread.id, !menuThread.archived))}
              >
                <IconArchive />
                {menuThread.archived ? "Désarchiver" : "Archiver"}
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={act(() => props.onDeleteThread(menuThread))}
              >
                <IconClose />
                Supprimer…
              </button>
            </div>
          </>
        )}
      </Presence>
      <div className="side-top">
        <Wordmark />
        <button
          className={`ib side-plug${state.ready && state.status === "open" && !available ? " warn" : ""}`}
          aria-label="Connexions"
          title={`Connexions : ${available} ${available > 1 ? "agents prêts" : "agent prêt"} · ${
            state.mcpServers.filter((m) => m.enabled).length
          } MCP`}
          onClick={props.onOpenConnections}
        >
          <IconPlug size={17} />
        </button>
      </div>
      <nav className="nav">
        {state.requests.length > 0 && (
          <button className="inbrow" onClick={props.onOpenRequests}>
            <IconShield />À traiter
            <span className="aux badge">{state.requests.length}</span>
          </button>
        )}
        <button
          className={!props.activeThreadId && !props.onPlanner ? "on" : ""}
          onClick={props.onNewThread}
        >
          <IconCompose />
          Nouvelle discussion
        </button>
        <button onClick={props.onNewProject}>
          <IconFolder />
          Nouveau projet
        </button>
        <button
          className={props.onPlanner ? "on" : ""}
          aria-current={props.onPlanner ? "page" : undefined}
          onClick={props.onOpenPlanner}
        >
          <IconBoard />
          Planner
        </button>
      </nav>
      <div className="side-scroll">
        <button
          className={`sec-h fold${projectsOpen ? "" : " shut"}`}
          aria-expanded={projectsOpen}
          onClick={() => {
            setProjectsOpen(!projectsOpen);
            writePref("projectsOpen", String(!projectsOpen));
          }}
        >
          <span>Projets</span>
          <IconChevron size={13} />
        </button>
        {projectsOpen && state.ready && state.projects.length === 0 && (
          <div className="empty-note">Aucun projet pour l'instant.</div>
        )}
        {(projectsOpen ? state.projects : []).flatMap(project)}
        {pinned.length > 0 && <div className="sec-h">Épinglés</div>}
        {pinned.flatMap((t) => tree(t, "pin:"))}
        {recent.length > 0 && <div className="sec-h">Récents</div>}
        {recent.flatMap((t) => tree(t, "recent:"))}
        {archived.length > 0 && (
          <button
            className="sec-h arch-toggle"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            <IconArchive size={13} />
            Archivés ({archived.length})
          </button>
        )}
        {showArchived && archived.map((t) => row(t, { key: t.id }))}
      </div>
      {state.status !== "open" && <div className="side-warn st warn">Reconnexion au serveur…</div>}
      <div className="side-foot">
        <button
          className="ib set-gear"
          aria-label="Réglages"
          title="Réglages"
          onClick={props.onOpenSettings}
        >
          <IconGear size={17} />
        </button>
        <button className="side-search" onClick={props.onOpenSearch}>
          <IconSearch size={15} />
          <span>Rechercher</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
    </aside>
  );
}
