import type { AgentInfo, Thread } from "@moonagentic/protocol";
import { formatPercent, formatReset, quotaLevel, tightest } from "../quotas.ts";
import { useQuotas } from "../use-quotas.ts";
import { connection, type State } from "../connection.ts";
import { useEffect, useRef, useState } from "react";
import { pinnedFirst, waitingCount } from "../project-threads.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { ProjectIcon } from "./ProjectIcon.tsx";
import { readPref, writePref } from "../prefs.ts";
import { RECENT, recentAlwaysShown } from "../recent.ts";
import {
  childrenOf as membersOf,
  conversationsByProject,
  lineStatus,
  projectOpen,
  teamOpen,
  type LineStatus,
} from "../sidebar-tree.ts";
import {
  IconArchive,
  IconChevron,
  IconClock,
  IconCopies,
  IconClose,
  IconCompose,
  IconFolder,
  IconList,
  IconGear,
  IconMore,
  IconInbox,
  IconLock,
  IconPin,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconShield,
} from "./icons.tsx";
import { Wordmark } from "./MoonMark.tsx";
import { Presence } from "./Presence.tsx";
import { SidePullRequests } from "./SidePullRequests.tsx";
import { StateGlyph } from "./StateGlyph.tsx";
import { type PlannerSignal, plannerSignal, plannerSignalText } from "../planner.ts";

/** A menu this tall always fits: it opens upwards when the row is that close to the bottom. */
const MENU_ROOM = 150;

const EMPTY_KEYS: ReadonlySet<string> = new Set();

function ThreadStatus({ status }: { status: LineStatus }) {
  if (status === "running") return <StateGlyph kind="travaille" size={14} label="En cours" />;
  if (status === "queued") return <StateGlyph kind="file" size={14} label="En file" />;
  if (status === "waiting") return <StateGlyph kind="attend" size={14} label="Attend ta réponse" />;
  if (status === "error") return <span className="dot err" title="Erreur" aria-label="Erreur" />;
  return null;
}

export function Sidebar(props: {
  /** All but the messages: the side bar shows none, and is not drawn again for them. */
  state: Omit<State, "items" | "held" | "reviews">;
  activeThreadId: string | undefined;
  activeProjectId: string | undefined;
  /** True on the planner's page. */
  onPlanner: boolean;
  /** The planned tasks are shown: they have their own address in the planner. */
  onSchedules: boolean;
  /** True on a project's page. */
  onProject: boolean;
  onOpenPlanner: () => void;
  /** True on the « Artefacts » page. */
  onArtifacts: boolean;
  onOpenArtifacts: () => void;
  /** The planner's « Planifiées » view: the tasks MoonAgentic starts by itself. */
  onOpenSchedules: () => void;
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
  /** Locks the project with the code, or asks for the code when it is locked. */
  onToggleLock: (id: string) => void;
  onOpenSettings: () => void;
  /** Réglages > Abonnements, where every quota is shown in full. */
  onOpenSubscriptions: () => void;
  onOpenSearch: () => void;
  /** Folds the side bar away, on a computer. */
  onCollapse: () => void;
}) {
  const { state } = props;
  const available = state.agents.filter((a) => a.available).length;
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

  // The row whose « … » menu is open (a thread can be listed twice: by its line's key), and where its button is on screen.
  const [menu, setMenu] = useState<{
    id: string;
    key: string;
    x: number;
    y: number;
    up: boolean;
  } | null>(null);
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

  const scheduled = state.schedules.filter((s) => s.enabled).length;
  const planSignal = plannerSignal(state.plan, state.threads, state.agents);
  const planText = plannerSignalText(planSignal);
  const live = state.threads.filter((t) => !t.archived);
  // A resolved team counts once, as its lead: its members are put away with it.
  const resolvedLeads = new Set(state.threads.filter((t) => t.archived).map((t) => t.id));
  const archived = state.threads.filter(
    (t) => t.archived && !(t.parentId && resolvedLeads.has(t.parentId)),
  );
  const members = membersOf(live);
  const byProject = conversationsByProject(live);
  const active = live.find((t) => t.id === props.activeThreadId);
  const activeLead =
    active?.parentId && members.has(active.parentId) ? active.parentId : active?.id;
  // Keys of the currently open team that the user folded during this visit; reset when
  // moving to another team, so visited teams fold back automatically on leave.
  const [foldedActive, setFoldedActive] = useState<{
    lead: string | undefined;
    keys: ReadonlySet<string>;
  }>({ lead: undefined, keys: new Set() });
  const foldedForLead = foldedActive.lead === activeLead ? foldedActive.keys : EMPTY_KEYS;
  const toggleTeam = (key: string, isActive: boolean) => {
    if (!isActive) return toggle(key);
    const next = new Set(foldedForLead);
    if (next.delete(key)) {
      setFoldedActive({ lead: activeLead, keys: next });
      return;
    }
    next.add(key);
    setFoldedActive({ lead: activeLead, keys: next });
    if (unfolded.has(key)) toggle(key);
  };
  const codeProjects = state.projects.filter((p) => !isDiscussionsProject(p));
  const discussionsProject = state.projects.find(isDiscussionsProject);
  // Opening a thread unfolds its project once, even when multi-project defaults it folded.
  const activeProject = active?.projectId;
  useEffect(() => {
    setFoldedActive((prev) =>
      prev.keys.size === 0 ? prev : { lead: activeLead, keys: new Set() },
    );
    if (
      activeProject &&
      activeProject !== discussionsProject?.id &&
      !projectOpen(folds[activeProject], codeProjects.length === 1)
    ) {
      setFold(activeProject, true);
    }
    // Only when the open thread changes, not on every fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject, activeLead]);
  const known = new Set(state.projects.map((p) => p.id));
  const pinned = [...byProject.values()].flat().filter((t) => t.pinned);
  // Across projects, only when there are several; a thread whose project is gone too.
  const recent = [...byProject.values()]
    .flat()
    .filter((t) => !t.pinned && (codeProjects.length > 1 || !known.has(t.projectId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT);

  // A team on one line, its members folded under it unless asked or one of them is open.
  const tree = (t: Thread, prefix: string) => {
    const team = members.get(t.id) ?? [];
    const key = `${prefix}${t.id}`;
    const isActive = activeLead === t.id;
    const open = team.length > 0 && teamOpen(key, isActive, unfolded, foldedForLead);
    return [
      row(t, {
        status: lineStatus(t, open ? [] : team),
        team: team.length ? { open, toggle: () => toggleTeam(key, isActive) } : undefined,
        key,
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
      className={`thr-row has-more${t.pinned ? " pinned" : ""}${opts.child ? " child" : ""}${opts.team ? " lead" : ""}${t.unread ? " unread" : ""}${menu?.key === opts.key ? " menu-open" : ""}`}
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
        {t.unread && <span className="unread-mark" title="Non lu" aria-label="Non lu" />}
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
        aria-expanded={menu?.key === opts.key}
        onClick={(e) => {
          if (menu?.key === opts.key) return setMenu(null);
          const box = e.currentTarget.getBoundingClientRect();
          const up = box.bottom + MENU_ROOM > window.innerHeight;
          setMenu({
            id: t.id,
            key: opts.key,
            x: box.right,
            y: up ? box.top - 4 : box.bottom + 4,
            up,
          });
        }}
      >
        <IconMore size={15} />
      </button>
    </div>
  );

  const project = (p: State["projects"][number]) => {
    // Pinned ones too: « Épinglés » is a shortcut, the project still holds them.
    const all = byProject.get(p.id) ?? [];
    const open = projectOpen(folds[p.id], codeProjects.length === 1);
    const { always, foldable } = recentAlwaysShown(all, members, props.activeThreadId);
    const more = unfolded.has(`more:${p.id}`);
    const count = byProject.get(p.id)?.length ?? 0;
    const waiting = waitingCount(live, p.id);
    // Put away inside their project, as a folder of its own: never beside the projects.
    const resolved = archived.filter((t) => t.projectId === p.id);
    const resolvedOpen = unfolded.has(`resolved:${p.id}`);
    return [
      <div key={p.id} className={`thr-row proj${open ? " open" : ""}${p.locked ? " locked" : ""}`}>
        <button
          className="fold-proj"
          aria-expanded={open}
          aria-label={`${open ? "Replier" : "Déplier"} le projet ${p.name}`}
          onClick={() => setFold(p.id, !open)}
        >
          <ProjectIcon project={p} />
          <IconChevron size={11} />
        </button>
        <button
          className={`thr${props.onProject && p.id === props.activeProjectId ? " on" : ""}`}
          title={p.path}
          onClick={() => {
            if (!open) setFold(p.id, true);
            props.onPickProject(p.id);
          }}
        >
          <span className="t">{p.name}</span>
          {p.pinned && (
            <span className="proj-pin" title="Projet épinglé" aria-label="Épinglé">
              <IconPin size={11} filled />
            </span>
          )}
          {waiting > 0 && (
            <span
              className="dot"
              title={`${waiting} en attente`}
              aria-label={`${waiting} en attente`}
            />
          )}
          <span className="aux" title={`${count} discussion${count > 1 ? "s" : ""}`}>
            {count || ""}
          </span>
        </button>
        <button
          className="pin lock"
          aria-label={`${p.locked ? "Déverrouiller" : "Verrouiller"} le projet ${p.name}`}
          aria-pressed={!!p.locked}
          title={p.locked ? "Déverrouiller" : "Verrouiller (Ctrl Maj L)"}
          onClick={() => props.onToggleLock(p.id)}
        >
          <IconLock />
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
      open && p.locked && (
        <div key={`${p.id}:items`} className="proj-items">
          <div className="empty-note lk-note">
            <IconLock size={12} />
            Discussions verrouillées
          </div>
        </div>
      ),
      open && !p.locked && (
        <div key={`${p.id}:items`} className="proj-items">
          {[
            ...(all.length === 0 && resolved.length === 0
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
            ...(resolved.length > 0
              ? [
                  <button
                    key={`${p.id}:resolved`}
                    className={`more resolved${resolvedOpen ? " open" : ""}`}
                    aria-expanded={resolvedOpen}
                    onClick={() => toggle(`resolved:${p.id}`)}
                  >
                    <IconArchive size={13} />
                    Résolus ({resolved.length})
                    <IconChevron size={11} />
                  </button>,
                  ...(resolvedOpen
                    ? resolved.map((t) => row(t, { key: `resolved:${t.id}`, child: true }))
                    : []),
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
              {!menuThread.archived && (
                <button
                  role="menuitem"
                  onClick={act(() =>
                    connection.send({
                      type: "thread.setUnread",
                      threadId: menuThread.id,
                      unread: !menuThread.unread,
                    }),
                  )}
                >
                  <IconInbox />
                  {menuThread.unread ? "Marquer comme lu" : "Marquer comme non lu"}
                </button>
              )}
              <button
                role="menuitem"
                onClick={act(() => props.onSetArchived(menuThread.id, !menuThread.archived))}
              >
                <IconArchive />
                {menuThread.archived ? "Rouvrir" : "Marquer résolu"}
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
          <IconPlug size={16} />
        </button>
        <button
          className="ib side-fold"
          aria-label="Masquer la barre latérale"
          title="Masquer la barre latérale"
          onClick={props.onCollapse}
        >
          <IconSidebar />
        </button>
      </div>
      <nav className="nav">
        {state.requests.length > 0 && (
          <button className="inbrow" onClick={props.onOpenRequests}>
            <IconShield />À traiter
            <span className="aux badge">{state.requests.length}</span>
          </button>
        )}
        <button onClick={props.onNewThread}>
          <IconCompose />
          Nouvelle discussion
        </button>
        <button onClick={props.onNewProject}>
          <IconFolder />
          Nouveau projet
        </button>
        <button
          className={props.onSchedules ? "on" : ""}
          aria-current={props.onSchedules ? "page" : undefined}
          onClick={props.onOpenSchedules}
        >
          <IconClock />
          Tâches planifiées
          {scheduled > 0 && <span className="aux">{scheduled}</span>}
        </button>
        <button
          className={props.onPlanner ? "on" : ""}
          aria-current={props.onPlanner ? "page" : undefined}
          onClick={props.onOpenPlanner}
          title={planText || undefined}
        >
          <IconList />
          Planner
          <PlannerSign signal={planSignal} />
        </button>
        <button
          className={props.onArtifacts ? "on" : ""}
          aria-current={props.onArtifacts ? "page" : undefined}
          onClick={props.onOpenArtifacts}
        >
          <IconCopies size={16} />
          Artefacts
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
        {projectsOpen && state.ready && codeProjects.length === 0 && (
          <div className="empty-note">Aucun projet pour l'instant.</div>
        )}
        {(projectsOpen ? pinnedFirst(codeProjects) : []).flatMap(project)}
        {discussionsProject &&
          (() => {
            const all = byProject.get(discussionsProject.id) ?? [];
            const resolved = archived.filter((t) => t.projectId === discussionsProject.id);
            if (!discussionsProject.locked && all.length === 0 && resolved.length === 0)
              return null;
            const { always, foldable } = recentAlwaysShown(all, members, props.activeThreadId);
            const more = unfolded.has(`more:${discussionsProject.id}`);
            const resolvedOpen = unfolded.has(`resolved:${discussionsProject.id}`);
            return (
              <>
                <div className="sec-h">Discussions</div>
                {discussionsProject.locked ? (
                  <button
                    className="more"
                    onClick={() => props.onToggleLock(discussionsProject.id)}
                  >
                    <IconLock size={12} />
                    Discussions verrouillées
                  </button>
                ) : (
                  <>
                    {(more ? all : always).flatMap((t) => tree(t, "disc:"))}
                    {foldable > 0 && (
                      <button
                        className="more"
                        aria-expanded={more}
                        onClick={() => toggle(`more:${discussionsProject.id}`)}
                      >
                        {more ? "Voir moins" : `Voir plus (${foldable})`}
                      </button>
                    )}
                    {resolved.length > 0 && (
                      <>
                        <button
                          className={`more resolved${resolvedOpen ? " open" : ""}`}
                          aria-expanded={resolvedOpen}
                          onClick={() => toggle(`resolved:${discussionsProject.id}`)}
                        >
                          <IconArchive size={13} />
                          Résolus ({resolved.length})
                          <IconChevron size={11} />
                        </button>
                        {resolvedOpen &&
                          resolved.map((t) => row(t, { key: `resolved:${t.id}`, child: true }))}
                      </>
                    )}
                  </>
                )}
              </>
            );
          })()}
        {pinned.length > 0 && <div className="sec-h">Épinglés</div>}
        {pinned.flatMap((t) => tree(t, "pin:"))}
        {recent.length > 0 && <div className="sec-h">Récents</div>}
        {recent.flatMap((t) => tree(t, "recent:"))}
        <SidePullRequests threads={state.threads} onOpenThread={props.onOpenThread} />
      </div>
      {state.status !== "open" && <div className="side-warn st warn">Reconnexion au serveur…</div>}
      <SideQuotas agents={state.agents} onOpen={props.onOpenSubscriptions} />
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

/**
 * Beside « Planner »: a live glyph while an agent works on a card, the cards that wait for
 * the user in amber, else those in progress in grey; nothing while nothing moves.
 */
function PlannerSign({ signal: s }: { signal: PlannerSignal }) {
  if (!s.live && !s.waiting && !s.active) return null;
  return (
    // Hidden from screen readers: the line keeps « Planner » as its name, its title says the rest.
    <span className="pind" aria-hidden>
      {s.live && <StateGlyph kind="travaille" size={14} />}
      {s.waiting > 0 ? (
        <span className="pind-a">{s.waiting}</span>
      ) : s.active > 0 ? (
        <span className="pind-n">{s.active}</span>
      ) : null}
    </span>
  );
}

/**
 * Each installed agent's tightest subscription window, as three quiet lines at the foot of
 * the side bar: always in sight, even inside a conversation. Agents that pay as they go are
 * left out; one whose figures cannot be read says so.
 */
function SideQuotas({ agents, onOpen }: { agents: AgentInfo[]; onOpen: () => void }) {
  const quotas = useQuotas();
  const rows = quotas
    .filter((q) => q.state !== "none" && agents.some((a) => a.id === q.agentId && a.available))
    .slice(0, 4);
  if (!rows.length) return null;
  return (
    <button className="side-quotas" onClick={onOpen} aria-label="Abonnements : voir le détail">
      <span className="sq-h">Abonnements</span>
      {rows.map((q) => {
        const name = agents.find((a) => a.id === q.agentId)?.name ?? q.agentId;
        const worst = tightest(q);
        if (!worst)
          return (
            <span key={q.agentId} className="sq-r na">
              <span className="sq-n">{name}</span>
              <span className="sq-p">{q.state === "loading" ? "…" : "non lisible"}</span>
            </span>
          );
        const level = quotaLevel(worst.usedPercent);
        return (
          <span
            key={q.agentId}
            className={`sq-r ${level}`}
            title={
              worst.resetsAt
                ? `${worst.label} · se libère ${formatReset(worst.resetsAt)}`
                : worst.label
            }
          >
            <span className="sq-n">
              {name}
              <small>{worst.short}</small>
            </span>
            <span className="sq-p">{formatPercent(worst.usedPercent)}</span>
            <span className="sq-b">
              <i style={{ width: `${Math.min(100, worst.usedPercent)}%` }} />
            </span>
          </span>
        );
      })}
    </button>
  );
}
