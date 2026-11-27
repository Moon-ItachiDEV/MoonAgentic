import type { Project, SearchHit, Thread } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { connection, newId, type State } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { plannerSignal, plannerSignalText } from "../planner.ts";
import { prBoard } from "../pr-board.ts";
import { readPref, writePref } from "../prefs.ts";
import { pinnedFirst, waitingCount } from "../project-threads.ts";
import { RECENT } from "../recent.ts";
import {
  childrenOf as membersOf,
  conversationsByProject,
  lineStatus,
  type LineStatus,
} from "../sidebar-tree.ts";
import { Glyph, I } from "../v2/I.tsx";
import { usePullToSearch } from "../v2/pull-search.ts";
import { useThreadRowMenu } from "../v2/ThreadRowMenu.tsx";
import { Wordmark } from "./MoonMark.tsx";
import { ProjectIcon } from "./ProjectIcon.tsx";
import { fuzzyMatch, type QuickAction } from "../quick-actions.ts";

/** What a line of the menu shows before its title: at work, waiting for the user, failed. */
function Mark({ status }: { status: LineStatus }) {
  if (status === "running" || status === "queued")
    return (
      <span className="wi2" role="img" aria-label={status === "queued" ? "En file" : "En cours"}>
        <Glyph />
      </span>
    );
  if (status === "waiting")
    return (
      <span className="wi2" role="img" aria-label="Attend ta réponse">
        <i className="ud" />
      </span>
    );
  if (status === "error")
    return (
      <span className="wi2 err" role="img" aria-label="Erreur">
        <i className="ud" />
      </span>
    );
  return <span className="wi2" />;
}

const SEARCH_DELAY_MS = 150;
const MAX_FOUND = 12;

export function Sidebar(props: {
  /** All but the messages: the menu shows none, and is not drawn again for them. */
  state: Omit<State, "items" | "held" | "reviews">;
  activeThreadId: string | undefined;
  /** The project whose page is shown. */
  activeProjectId: string | undefined;
  /** The page of the menu that is shown. */
  page: "inbox" | "planner" | "schedules" | "artifacts" | "prs" | undefined;
  /** The search replaces the menu while it is open (Ctrl K opens it too). */
  searching: boolean;
  onSearching: (on: boolean) => void;
  /** What the search offers besides the conversations. */
  onListActions: () => QuickAction[];
  onOpenInbox: () => void;
  onOpenPlanner: () => void;
  onOpenSchedules: () => void;
  onOpenArtifacts: () => void;
  onOpenPrs: () => void;
  onNewThread: () => void;
  onNewProject: () => void;
  onPickProject: (id: string) => void;
  onOpenThread: (id: string, itemId?: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onSetArchived: (id: string, archived: boolean) => void;
  /** Asks before deleting the thread. */
  onDeleteThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread) => void;
  onOpenSettings: () => void;
}) {
  const { state } = props;
  const [projectsOpen, setProjectsOpen] = useState(() => readPref("projectsOpen") !== "false");
  // Lists cut to their latest lines until asked, and the resolved ones folded away.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const drawerTop = useRef<HTMLDivElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const onSearching = props.onSearching;
  const openSearch = useCallback(() => onSearching(true), [onSearching]);
  const toggle = (key: string) => {
    const next = new Set(unfolded);
    if (!next.delete(key)) next.add(key);
    setUnfolded(next);
  };

  // The menu of a line: a right click, or a finger held on it.
  const { bind, menu: rowMenu } = useThreadRowMenu(state.threads, props);

  const planSignal = plannerSignal(state.plan, state.threads, state.agents);
  const planCount = planSignal.waiting || planSignal.active;
  const prs = prBoard(state.threads);
  const live = state.threads.filter((t) => !t.archived);
  const members = membersOf(live);
  // A team counts once, as its lead.
  const lines = [...conversationsByProject(live).values()]
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const discussions = state.projects.find(isDiscussionsProject);
  const allCode = state.projects.filter((p) => p.id !== discussions?.id);
  // An archived project is folded away under « Archivés », its threads out of the lists.
  const codeProjects = allCode.filter((p) => !p.archived);
  const archived = allCode.filter((p) => p.archived);
  const locked = new Set(state.projects.filter((p) => p.locked || p.archived).map((p) => p.id));
  const shown = lines.filter((t) => !locked.has(t.projectId));
  const pinned = shown.filter((t) => t.pinned);
  // « Code » : the conversations with a branch of their own. « Récents » : the others.
  const code = shown.filter((t) => !t.pinned && t.workspace);
  const recent = shown.filter((t) => !t.pinned && !t.workspace);
  // A resolved team counts once too; those of a project are listed on its page.
  const resolvedLeads = new Set(state.threads.filter((t) => t.archived).map((t) => t.id));
  const resolved = state.threads
    .filter(
      (t) =>
        t.archived &&
        !(t.parentId && resolvedLeads.has(t.parentId)) &&
        (!codeProjects.some((p) => p.id === t.projectId) || !t.workspace) &&
        !locked.has(t.projectId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const cut = (key: string, list: Thread[]) => {
    const all = unfolded.has(key);
    // The open conversation stays in sight, even far down the list.
    const head = list.filter((t, i) => i < RECENT || t.id === props.activeThreadId);
    return { rows: all ? list : head, more: list.length - head.length, all };
  };
  const row = (t: Thread, mark: boolean) => (
    <button
      key={t.id}
      className={`rc${mark ? " wo" : ""}${t.id === props.activeThreadId ? " on" : ""}${t.unread ? " unread" : ""}`}
      aria-current={t.id === props.activeThreadId ? "page" : undefined}
      onClick={() => props.onOpenThread(t.id)}
      {...bind(t)}
    >
      {mark && <Mark status={lineStatus(t, members.get(t.id))} />}
      <span className="nm">{t.title}</span>
      {!mark && lineStatus(t, members.get(t.id)) === "waiting" && (
        <i className="ud" role="img" aria-label="Attend ta réponse" />
      )}
      {t.unread && <i className="nr" role="img" aria-label="Non lu" />}
    </button>
  );
  const more = (key: string, n: number, all: boolean, wide = false) =>
    (n > 0 || all) && (
      <button
        className={`rc more${wide ? " wo" : ""}`}
        aria-expanded={all}
        onClick={() => toggle(key)}
      >
        {wide && <span className="wi2" />}
        <span className="nm">{all ? "Voir moins" : `Voir plus (${n})`}</span>
      </button>
    );
  const section = (key: string, title: string, list: Thread[], mark: boolean) => {
    if (!list.length) return null;
    const { rows, more: n, all } = cut(key, list);
    return (
      <>
        <div className={`dsec${mark ? " wo" : ""}`}>{title}</div>
        {rows.map((t) => row(t, mark))}
        {more(key, n, all, mark)}
      </>
    );
  };

  usePullToSearch(drawerTop, searchButton, openSearch, !props.searching);

  if (props.searching)
    return (
      <DrawerSearch
        state={state}
        actions={props.onListActions()}
        onClose={() => props.onSearching(false)}
        onOpenThread={props.onOpenThread}
        onPickProject={props.onPickProject}
      />
    );

  const resolvedOpen = unfolded.has("resolved");
  return (
    <>
      {rowMenu}
      <div className="dtop" ref={drawerTop}>
        <Wordmark />
        <button
          ref={searchButton}
          className="gb glass srch"
          aria-label="Rechercher"
          title="Rechercher (Ctrl K)"
          onClick={() => props.onSearching(true)}
        >
          <svg className="pr" viewBox="0 0 44 44" aria-hidden="true">
            <circle
              cx="22"
              cy="22"
              r="20.5"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset="1"
            />
          </svg>
          <I n="search" s={20} />
          <span className="lb">Rechercher</span>
        </button>
      </div>
      <div className="dscroll">
        <nav className="nav" aria-label="Pages">
          <button
            className={`ni press${props.page === "inbox" ? " on" : ""}`}
            aria-current={props.page === "inbox" ? "page" : undefined}
            onClick={props.onOpenInbox}
          >
            <I n="hand" />
            <span>À traiter</span>
            <span className="sp" />
            {state.requests.length > 0 && (
              <span className="cnt w" aria-label={`${state.requests.length} à traiter`}>
                {state.requests.length}
              </span>
            )}
          </button>
          <button
            className={`ni press${props.page === "planner" ? " on" : ""}`}
            aria-current={props.page === "planner" ? "page" : undefined}
            title={plannerSignalText(planSignal) || undefined}
            onClick={props.onOpenPlanner}
          >
            <I n="grid" />
            <span>Planner</span>
            <span className="sp" />
            {planCount > 0 && (
              <span className={`cnt${planSignal.waiting ? " w" : ""}`} aria-hidden>
                {planCount}
              </span>
            )}
          </button>
          <button
            className={`ni press${props.page === "schedules" ? " on" : ""}`}
            aria-current={props.page === "schedules" ? "page" : undefined}
            onClick={props.onOpenSchedules}
          >
            <I n="clock" />
            <span>Tâches planifiées</span>
          </button>
          <button
            className={`ni press${props.page === "artifacts" ? " on" : ""}`}
            aria-current={props.page === "artifacts" ? "page" : undefined}
            onClick={props.onOpenArtifacts}
          >
            <I n="image" />
            <span>Artefacts</span>
          </button>
          <button
            className={`ni press${props.page === "prs" ? " on" : ""}`}
            aria-current={props.page === "prs" ? "page" : undefined}
            onClick={props.onOpenPrs}
          >
            <I n="merge" />
            <span>Pull requests</span>
            <span className="sp" />
            {(prs.red > 0 || prs.green > 0) && (
              <span
                className="prc"
                role="img"
                aria-label={`${prs.red} en échec, ${prs.green} à fusionner`}
              >
                {prs.red > 0 && <i className="r">{prs.red}</i>}
                {prs.green > 0 && <i className="g">{prs.green}</i>}
              </span>
            )}
          </button>
        </nav>
        <button
          className="dsec"
          aria-expanded={projectsOpen}
          onClick={() => {
            setProjectsOpen(!projectsOpen);
            writePref("projectsOpen", String(!projectsOpen));
          }}
        >
          Projets
          <I n="down" s={14} />
        </button>
        <div className={`coll${projectsOpen ? "" : " shut"}`}>
          <div>
            {pinnedFirst(codeProjects).map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                on={p.id === props.activeProjectId}
                waiting={p.locked ? 0 : waitingCount(live, p.id)}
                shut={!projectsOpen}
                onPick={() => props.onPickProject(p.id)}
              />
            ))}
            {archived.length > 0 && (
              <button
                className="pj press add parc"
                aria-expanded={unfolded.has("archived")}
                tabIndex={projectsOpen ? undefined : -1}
                onClick={() => toggle("archived")}
              >
                <I n="folder" />
                <span className="nm">Archivés</span>
                <span className="cnt">{archived.length}</span>
                <I n={unfolded.has("archived") ? "down" : "right"} s={14} />
              </button>
            )}
            {unfolded.has("archived") &&
              archived.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  on={p.id === props.activeProjectId}
                  waiting={0}
                  shut={!projectsOpen}
                  onPick={() => props.onPickProject(p.id)}
                />
              ))}
            <button
              className={`pj press add${codeProjects.length ? " wo" : ""}`}
              tabIndex={projectsOpen ? undefined : -1}
              onClick={props.onNewProject}
            >
              <I n="plus" />
              <span className="nm">Nouveau projet</span>
            </button>
          </div>
        </div>
        {section("pinned", "Épinglés", pinned, false)}
        {section("code", "Code", code, true)}
        {(recent.length > 0 || resolved.length > 0) && <div className="dsec">Récents</div>}
        {(() => {
          const { rows, more: n, all } = cut("recent", recent);
          return (
            <>
              {rows.map((t) => row(t, false))}
              {more("recent", n, all)}
            </>
          );
        })()}
        {resolved.length > 0 && (
          <button
            className="rc more"
            aria-expanded={resolvedOpen}
            onClick={() => toggle("resolved")}
          >
            <span className="nm">Résolus ({resolved.length})</span>
          </button>
        )}
        {resolvedOpen && resolved.map((t) => row(t, false))}
      </div>
      <div className="dfoot">
        <button className="me press" aria-label="Réglages" onClick={props.onOpenSettings}>
          <I n="gear" />
        </button>
        <span className="sp" />
        <button className="newd press" onClick={props.onNewThread}>
          <I n="plus" s={20} />
          Nouvelle discussion
        </button>
      </div>
    </>
  );
}

function ProjectRow(props: {
  project: Project;
  on: boolean;
  waiting: number;
  shut: boolean;
  onPick: () => void;
}) {
  const p = props.project;
  return (
    <button
      className={`pj press${props.on ? " on" : ""}`}
      aria-current={props.on ? "page" : undefined}
      title={p.path}
      tabIndex={props.shut ? -1 : undefined}
      onClick={props.onPick}
    >
      <ProjectIcon project={p} size={22} />
      <span className="nm">{p.name}</span>
      {p.locked && (
        <span className="lk" role="img" aria-label="Verrouillé">
          <I n="lock" s={16} />
        </span>
      )}
      {props.waiting > 0 && (
        <span className="cnt w" aria-label={`${props.waiting} en attente`}>
          {props.waiting}
        </span>
      )}
    </button>
  );
}

/** The search, in place of the menu: conversations, projects, actions, and every message. */
function DrawerSearch(props: {
  state: Omit<State, "items" | "held" | "reviews">;
  actions: QuickAction[];
  onClose: () => void;
  onOpenThread: (id: string, itemId?: string) => void;
  onPickProject: (id: string) => void;
}) {
  const { state } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const online = state.status === "open";

  // Messages are searched on the server, which holds every thread's timeline. A search typed
  // before the connection opens is sent once it does: an ask before then fails at once.
  useEffect(() => {
    // From three letters: the server's index looks for groups of three.
    if ([...q].length < 3 || !online) return;
    let current = true;
    const timer = setTimeout(() => {
      connection
        .ask({ type: "search", requestId: newId(), query: q })
        .then((reply) => current && setHits({ query: q, hits: reply.hits }))
        .catch(() => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, online]);

  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? "";
  const threadTitle = (id: string) => state.threads.find((t) => t.id === id)?.title ?? "";
  const threads = state.threads
    // Resolved conversations stay out of the recent ones, but typing still finds them.
    .filter((t) => (q ? fuzzyMatch(q, t.title) : !t.archived && !t.parentId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, q ? MAX_FOUND : 8);
  const entries: {
    key: string;
    group: string;
    label: string;
    detail?: string;
    icon: React.ReactNode;
    run: () => void;
  }[] = [
    ...threads.map((t) => ({
      key: `thread:${t.id}`,
      group: q ? "Discussions" : "Récents",
      label: t.title,
      detail: t.archived ? `${projectName(t.projectId)} · Résolu` : projectName(t.projectId),
      icon: <I n={t.pinned ? "star" : "bubble"} s={18} className="ic2" />,
      run: () => props.onOpenThread(t.id),
    })),
    ...state.projects
      .filter((p) => q && !isDiscussionsProject(p) && fuzzyMatch(q, p.name))
      .map((p) => ({
        key: `project:${p.id}`,
        group: "Projets",
        label: p.name,
        detail: p.path,
        icon: <I n="folder" s={18} className="ic2" />,
        run: () => props.onPickProject(p.id),
      })),
    ...props.actions
      .filter((a) => q && fuzzyMatch(q, a.label))
      .map((a, i) => ({
        key: `action:${i}`,
        group: "Actions",
        label: a.label,
        icon: <I n="right" s={18} className="ic2" />,
        run: a.run,
      })),
    ...([...q].length >= 3 && hits?.query === q ? hits.hits : []).map((h) => ({
      key: `hit:${h.threadId}:${h.itemId}`,
      group: "Messages",
      label: h.snippet,
      detail: `${h.kind === "user" ? "Toi" : "Agent"} · ${threadTitle(h.threadId)}`,
      icon: <I n="bubble" s={18} className="ic2" />,
      run: () => props.onOpenThread(h.threadId, h.itemId),
    })),
  ];
  const highlighted = Math.min(active, Math.max(0, entries.length - 1));
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const choose = (entry: (typeof entries)[number] | undefined) => {
    if (!entry) return;
    props.onClose();
    entry.run();
  };

  let group = "";
  return (
    <div className="dsearch rise" role="dialog" aria-label="Recherche">
      <div className="sfield">
        <label className="in glass">
          <I n="search" s={18} />
          <input
            autoFocus
            value={query}
            placeholder="Rechercher des discussions…"
            aria-label="Rechercher"
            role="combobox"
            aria-expanded
            aria-controls="ds-list"
            aria-activedescendant={entries.length ? `ds-${highlighted}` : undefined}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(entries.length ? (highlighted + 1) % entries.length : 0);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(entries.length ? (highlighted - 1 + entries.length) % entries.length : 0);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(entries[highlighted]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                props.onClose();
              }
            }}
          />
        </label>
        <button className="gb glass press" aria-label="Fermer la recherche" onClick={props.onClose}>
          <I n="x" s={18} />
        </button>
      </div>
      <div className="dscroll" id="ds-list" role="listbox" ref={list}>
        {entries.length === 0 && (
          <div className="nores">
            {[...q].length >= 3 && online && hits?.query !== q
              ? "Je cherche…"
              : q
                ? `Aucune discussion ne contient « ${q} ».`
                : "Aucune discussion."}
          </div>
        )}
        {entries.map((entry, i) => {
          const heading = entry.group !== group ? (group = entry.group) : null;
          return (
            <div key={entry.key} role="presentation">
              {heading && <div className="dsec">{heading}</div>}
              <button
                id={`ds-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === highlighted}
                className={`rc${i === highlighted && q ? " on" : ""}`}
                onMouseMove={() => i !== highlighted && setActive(i)}
                onClick={() => choose(entry)}
              >
                {entry.icon}
                <span className="nm">
                  {entry.label}
                  {entry.detail && <small>{entry.detail}</small>}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
