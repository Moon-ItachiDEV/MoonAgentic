import type { Schedule, Thread } from "@moonagentic/protocol";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Composer, useNarrow } from "./components/Composer.tsx";
import { Presence } from "./components/Presence.tsx";
import { type Confirmation, ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { ConnectionsDialog } from "./components/ConnectionsDialog.tsx";
import { Home } from "./components/Home.tsx";
import {
  IconBack,
  IconCode,
  IconClock,
  IconCheck,
  IconExpand,
  IconShield,
  IconArrowLeft,
  IconMenu,
  IconSidebar,
  IconCompose,
  IconFile,
  IconArchive,
  IconBoard,
  IconClose,
  IconFolder,
  IconInbox,
  IconPin,
  IconPlug,
} from "./components/icons.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { McpDialog } from "./components/McpDialog.tsx";
import { MoonMark } from "./components/MoonMark.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { type QuickAction, QuickSearch } from "./components/QuickSearch.tsx";
import { ProjectRequests, projectRequests } from "./components/ProjectRequests.tsx";
import { RequestsDialog } from "./components/RequestsDialog.tsx";
import { ReviewPanel } from "./components/ReviewPanel.tsx";
import { ProjectPage } from "./components/ProjectPage.tsx";
import { HomeCards } from "./components/HomeCards.tsx";
import { coordinatorOf, listedThreads } from "./project-threads.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { ThreadMenu } from "./components/ThreadMenu.tsx";
import { TeamDialog } from "./components/TeamDialog.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { connection, newId } from "./connection.ts";
import { downloadMarkdown, exportFileName, threadMarkdown } from "./export.ts";
import { focusItem } from "./focus.ts";
import { readPref, writePref } from "./prefs.ts";
import { navigate, useRoute } from "./router.ts";

export { ErrorBoundary };

// The planner and the settings are loaded on demand, so they stay out of the main chunk.
const Planner = lazy(() =>
  import("./components/Planner.tsx").then((m) => ({ default: m.Planner })),
);
const SettingsNav = lazy(() =>
  import("./components/Settings.tsx").then((m) => ({ default: m.SettingsNav })),
);
const SettingsPage = lazy(() =>
  import("./components/Settings.tsx").then((m) => ({ default: m.SettingsPage })),
);

/** Wide enough for a project's threads beside its coordinator's conversation. */
const WIDE = "(min-width: 1180px)";
const wideQuery = typeof matchMedia === "function" ? matchMedia(WIDE) : undefined;
const useWide = () =>
  useSyncExternalStore(
    (changed) => {
      wideQuery?.addEventListener("change", changed);
      return () => wideQuery?.removeEventListener("change", changed);
    },
    () => wideQuery?.matches ?? true,
  );

export function App() {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  // The phone's home page: live conversations above the composer, tabs below it.
  const narrow = useNarrow();
  // On a computer, the side bar can be folded away, as in the mockup.
  const [sideOff, setSideOff] = useState(() => readPref("sideOff") === "true");
  const foldSide = (off: boolean) => {
    setSideOff(off);
    writePref("sideOff", String(off));
  };
  /** Bumped to open the planner again on the view just chosen. */
  const [plannerShown, setPlannerShown] = useState(0);
  const [creatingProject, setCreatingProject] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pickedProjectId, setPickedProjectId] = useState(() => readPref("project"));
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [teamTask, setTeamTask] = useState<string | null>(null);
  // The planning of a task for later: a new one with its text, or one being changed.
  const [scheduling, setScheduling] = useState<{ text: string; schedule?: Schedule } | null>(null);

  // Ctrl K (⌘ K on a Mac) opens the quick search from anywhere, even while typing.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", open);
    return () => document.removeEventListener("keydown", open);
  }, []);

  const wide = useWide();
  /** On a narrow screen, what the project's page shows: the coordinator or the threads. */
  const [projectTab, setProjectTab] = useState<"chat" | "threads">("chat");
  // Lists show every thread but the coordinators.
  const listed = useMemo(() => ({ ...state, threads: listedThreads(state.threads) }), [state]);
  // A coordinator lives on its project's page: its own address, reached from a notification
  // or an old link, leads there, and « back » does not come here again.
  const strayProjectId =
    route.name === "thread"
      ? state.threads.find((t) => t.id === route.threadId && t.kind === "coordinator")?.projectId
      : undefined;
  useEffect(() => {
    if (!strayProjectId) return;
    setProjectTab("chat");
    navigate({ name: "project", projectId: strayProjectId }, { replace: true });
  }, [strayProjectId]);
  // Another project's page starts on its coordinator, not on the tab left open before.
  const pageProjectId = route.name === "project" ? route.projectId : undefined;
  // Coming back to the same project from one of its threads keeps the tab.
  const lastPage = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pageProjectId) return;
    if (lastPage.current && lastPage.current !== pageProjectId) setProjectTab("chat");
    lastPage.current = pageProjectId;
  }, [pageProjectId]);

  if (state.status === "unauthorized") return <Unauthorized />;

  const thread: Thread | undefined =
    route.name === "thread" ? state.threads.find((t) => t.id === route.threadId) : undefined;
  // A project's page shows that project; elsewhere, the open thread's or the one last picked.
  const routeProject =
    route.name === "project" ? state.projects.find((p) => p.id === route.projectId) : undefined;
  const project =
    routeProject ??
    state.projects.find((p) => p.id === (thread?.projectId ?? pickedProjectId)) ??
    state.projects[0];

  // On a project's page, the conversation is its coordinator's, once it has one.
  const coordinator = routeProject ? coordinatorOf(state.threads, routeProject.id) : undefined;
  /** The thread the composer writes to. */
  const spoken = thread ?? coordinator;
  // One of the project's threads, open beside its coordinator: both stay in sight.
  const beside =
    coordinator && route.name === "project" && route.threadId
      ? state.threads.find(
          (t) =>
            t.id === route.threadId &&
            t.projectId === coordinator.projectId &&
            t.id !== coordinator.id,
        )
      : undefined;
  const pickProject = (id: string) => {
    setPickedProjectId(id);
    writePref("project", id);
  };
  const go = (next: Parameters<typeof navigate>[0]) => {
    setDrawer(false);
    setReviewOpen(false);
    navigate(next);
  };
  /** Opens a thread where it lives: a coordinator on its project's page. */
  const openThread = (id: string) => {
    const target = state.threads.find((t) => t.id === id);
    if (target?.kind === "coordinator") {
      setProjectTab("chat");
      go({ name: "project", projectId: target.projectId });
    } else if (coordinator && target?.projectId === coordinator.projectId) {
      // From its project's page, a thread opens beside the coordinator.
      go({ name: "project", projectId: target.projectId, threadId: id });
    } else go({ name: "thread", threadId: id });
  };
  const togglePin = (id: string, pinned: boolean) =>
    connection.send({ type: "thread.setPinned", threadId: id, pinned });
  const exportThread = (t: Thread | undefined = spoken) => {
    const items = t && state.items[t.id];
    if (!t || !items) return;
    downloadMarkdown(exportFileName(t.title), threadMarkdown(t, items, state.agents));
  };
  const setArchived = (id: string, archived: boolean) =>
    connection.send({ type: "thread.setArchived", threadId: id, archived });
  const askDeleteThread = (t: Thread) => {
    // A team goes whole: its lead's thread takes the members' with it.
    const members = state.threads.filter((m) => m.parentId === t.id).length;
    setConfirm({
      title: members ? "Supprimer cette équipe ?" : "Supprimer cette discussion ?",
      text: members
        ? `« ${t.title} » et les ${members} fils de son équipe seront supprimés, avec leurs copies de travail. Leurs branches restent dans le dépôt, avec leurs commits.`
        : t.workspace
          ? `« ${t.title} » et sa copie de travail seront supprimées. Sa branche ${t.workspace.branch} reste dans le dépôt, avec ses commits.`
          : `« ${t.title} » sera supprimée, avec tous ses messages.`,
      action: "Supprimer",
      // The box stays open, and says why, until the server has really deleted it.
      run: async () => {
        await connection.request({ type: "thread.delete", requestId: newId(), threadId: t.id });
        if (thread?.id === t.id || thread?.parentId === t.id) go({ name: "home" });
      },
    });
  };
  const askRemoveProject = (id: string) => {
    const p = state.projects.find((x) => x.id === id);
    if (!p) return;
    const count = state.threads.filter((t) => t.projectId === id).length;
    setConfirm({
      title: "Retirer ce projet ?",
      text: `« ${p.name} » quitte MoonAgentic${count ? `, avec ses ${count} discussion${count > 1 ? "s" : ""} et leurs copies de travail` : ""}. Le dossier ${p.path} et ses branches restent intacts.`,
      action: "Retirer",
      run: async () => {
        await connection.request({ type: "project.remove", requestId: newId(), projectId: id });
        if (thread?.projectId === id || routeProject?.id === id) go({ name: "home" });
      },
    });
  };
  const threadActions = thread
    ? [
        {
          label: thread.pinned ? "Désépingler" : "Épingler",
          run: () => togglePin(thread.id, !thread.pinned),
        },
        { label: "Exporter en Markdown", run: () => exportThread() },
        {
          label: thread.archived ? "Rouvrir" : "Marquer résolu",
          run: () => setArchived(thread.id, !thread.archived),
        },
        { label: "Supprimer…", danger: true, run: () => askDeleteThread(thread) },
      ]
    : [];
  const quickActions: QuickAction[] = [
    {
      label: "Nouvelle discussion",
      icon: <IconCompose size={15} />,
      run: () => go({ name: "home" }),
    },
    {
      label: "Nouveau projet",
      icon: <IconFolder size={15} />,
      run: () => setCreatingProject(true),
    },
    {
      label: `À traiter${state.requests.length ? ` (${state.requests.length})` : ""}`,
      icon: <IconInbox size={15} />,
      run: () => setRequestsOpen(true),
    },
    { label: "Planner", icon: <IconBoard size={15} />, run: () => go({ name: "planner" }) },
    { label: "Connexions", icon: <IconPlug size={15} />, run: () => setConnectionsOpen(true) },
    { label: "Serveurs MCP", icon: <IconPlug size={15} />, run: () => setMcpOpen(true) },
    ...(thread
      ? [
          {
            label: thread.pinned ? "Désépingler cette discussion" : "Épingler cette discussion",
            icon: <IconPin />,
            run: () => togglePin(thread.id, !thread.pinned),
          },
          {
            label: "Exporter cette discussion en Markdown",
            icon: <IconFile />,
            run: () => exportThread(),
          },
          {
            label: thread.archived
              ? "Rouvrir cette discussion"
              : "Marquer cette discussion résolue",
            icon: <IconArchive />,
            run: () => setArchived(thread.id, !thread.archived),
          },
          {
            label: "Supprimer cette discussion",
            icon: <IconClose />,
            run: () => askDeleteThread(thread),
          },
        ]
      : []),
  ];

  /** What a conversation is written from: its composer, or the way to reopen it once resolved. */
  const composerFor = (t: Thread | undefined, placeholder?: string) =>
    t?.archived ? (
      <div className="archived-bar" role="status">
        <IconArchive />
        <span>Cette discussion est résolue.</span>
        <button className="btn sm" onClick={() => setArchived(t.id, false)}>
          Rouvrir
        </button>
      </div>
    ) : (
      <Composer
        key={t?.id ?? "new"}
        agents={state.agents}
        favorites={state.favorites}
        thread={t}
        project={project}
        {...(placeholder ? { placeholder } : {})}
        onNewProject={() => setCreatingProject(true)}
        onCreated={(id) => navigate({ name: "thread", threadId: id })}
        onExport={() => exportThread(t)}
        onSearch={() => setSearchOpen(true)}
        onRequests={() => setRequestsOpen(true)}
        onConnections={() => setConnectionsOpen(true)}
        onArchive={() => t && setArchived(t.id, true)}
        onDelete={() => t && askDeleteThread(t)}
        onTeam={(task) => setTeamTask(task)}
        onSchedule={(text) => setScheduling({ text })}
        onSettings={() => go({ name: "settings", section: "general" })}
      />
    );

  /** Under the coordinator's conversation: what its project's threads wait for, then its composer. */
  const coordinatorDock = coordinator && routeProject && (
    <>
      {!coordinator.archived && (
        <ProjectRequests
          requests={projectRequests(state.requests, state.threads, routeProject.id)}
          threads={state.threads}
          onOpenThread={(id, itemId) => {
            focusItem(id, itemId);
            openThread(id);
          }}
        />
      )}
      {composerFor(coordinator, "Pose une question ou demande une tâche…")}
    </>
  );

  const reviewing = reviewOpen && !!thread?.workspace && !thread.archived;
  const reviewCount = thread ? state.reviews[thread.id]?.files?.length : undefined;

  return (
    <div
      className={`app${drawer ? " drawer" : ""}${sideOff && route.name !== "settings" ? " side-off" : ""}${route.name === "home" ? " home-route" : ""}${route.name === "thread" ? " in-thread" : ""}${reviewing ? " reviewing" : ""}`}
    >
      {route.name === "settings" ? (
        <ErrorBoundary
          key="settings-nav"
          fallback={(_error, reload) => (
            <aside className="side set-side" aria-label="Réglages">
              <button className="set-back" onClick={() => go({ name: "home" })}>
                <IconBack />
                Retour
              </button>
              <div className="empty-note">
                <p>Impossible d'afficher le menu.</p>
                <button className="btn sm" type="button" onClick={reload}>
                  Recharger
                </button>
              </div>
            </aside>
          )}
        >
          {/* Until the settings arrive, an empty side bar keeps the layout in place. */}
          <Suspense fallback={<aside className="side set-side" aria-label="Réglages" />}>
            <SettingsNav
              section={route.section}
              onPick={(section) => go({ name: "settings", section })}
              onBack={() => go({ name: "home" })}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <Sidebar
          state={listed}
          activeThreadId={thread?.id}
          activeProjectId={project?.id}
          onPlanner={route.name === "planner"}
          onProject={route.name === "project"}
          onOpenPlanner={() => go({ name: "planner" })}
          onOpenSchedules={() => {
            writePref("plannerView", "planifiees");
            // A planner already open shows that view too.
            setPlannerShown((n) => n + 1);
            go({ name: "planner" });
          }}
          onNewThread={() => go({ name: "home" })}
          onNewProject={() => {
            setDrawer(false);
            setCreatingProject(true);
          }}
          onOpenConnections={() => {
            setDrawer(false);
            setConnectionsOpen(true);
          }}
          onOpenRequests={() => {
            setDrawer(false);
            setRequestsOpen(true);
          }}
          onPickProject={(id) => {
            pickProject(id);
            // On the planner, picking a project shows that project's planner; anywhere else,
            // its page, with its conversations grouped by state.
            if (route.name === "planner") go({ name: "planner" });
            else go({ name: "project", projectId: id });
          }}
          onNewInProject={(id) => {
            pickProject(id);
            go({ name: "home" });
          }}
          onOpenThread={(id) => go({ name: "thread", threadId: id })}
          onTogglePin={togglePin}
          onSetArchived={setArchived}
          onDeleteThread={(t) => {
            setDrawer(false);
            askDeleteThread(t);
          }}
          onRemoveProject={(id) => {
            setDrawer(false);
            askRemoveProject(id);
          }}
          onOpenSettings={() => go({ name: "settings", section: "general" })}
          onOpenSearch={() => {
            setDrawer(false);
            setSearchOpen(true);
          }}
          onCollapse={() => foldSide(true)}
        />
      )}
      <div className="side-scrim" onClick={() => setDrawer(false)} />
      <main className={`center${beside && wide ? " with-thread" : ""}`}>
        <header className="top">
          <button
            className="ib mobile-only menu-btn"
            aria-label="Menu"
            onClick={() => setDrawer(true)}
          >
            <IconMenu />
          </button>
          {route.name === "thread" && (
            <button
              className="ib back-home"
              aria-label="Retour"
              title="Retour"
              onClick={() => go({ name: "home" })}
            >
              <IconArrowLeft />
            </button>
          )}
          {sideOff && route.name !== "settings" && (
            <button
              className="ib open-side"
              aria-label="Afficher la barre latérale"
              title="Afficher la barre latérale"
              onClick={() => foldSide(false)}
            >
              <IconSidebar />
            </button>
          )}
          <div className="ttl">
            {route.name === "settings"
              ? "Réglages"
              : route.name === "project"
                ? (routeProject?.name ?? "")
                : (thread?.title ?? "")}
          </div>
          {state.requests.length > 0 && (
            <button
              className="inbbtn"
              aria-label={`${state.requests.length} ${
                state.requests.length > 1 ? "demandes" : "demande"
              } à traiter`}
              title="À traiter"
              onClick={() => setRequestsOpen(true)}
            >
              <IconShield size={14} />
              <span>{state.requests.length}</span>
            </button>
          )}
          {thread?.workspace && !thread.archived && (
            <button
              className={`review-btn codebtn${reviewing ? " on" : ""}`}
              aria-label={reviewCount ? `Code : ${reviewCount} à revoir` : "Code"}
              aria-pressed={reviewing}
              title="Code et modifications"
              onClick={() => setReviewOpen(!reviewing)}
            >
              <IconCode />
              <span className="lbl">Code</span>
              {!!reviewCount && <span className="cnt">{reviewCount}</span>}
            </button>
          )}
          {thread && <ThreadMenu actions={threadActions} />}
          {route.name === "thread" ? (
            <button
              className="ib"
              aria-label="Nouvelle discussion"
              title="Nouvelle discussion"
              onClick={() => go({ name: "home" })}
            >
              <IconCompose size={17} />
            </button>
          ) : (
            <span className="spacer mobile-only" />
          )}
        </header>
        {route.name === "settings" ? (
          <ErrorBoundary key="settings">
            <Suspense fallback={<div className="view" />}>
              <SettingsPage
                section={route.section}
                agents={state.agents}
                favorites={state.favorites}
                coordinator={state.coordinator}
                projects={state.projects}
                projectId={project?.id}
                mcpServers={state.mcpServers}
                onPickProject={pickProject}
                onOpenConnections={() => setConnectionsOpen(true)}
                onOpenMcp={() => setMcpOpen(true)}
              />
            </Suspense>
          </ErrorBoundary>
        ) : route.name === "thread" ? (
          thread ? (
            <ThreadView
              thread={thread}
              items={state.items[thread.id]}
              agents={state.agents}
              threads={state.threads}
              onOpenThread={(id) => navigate({ name: "thread", threadId: id })}
            />
          ) : (
            <div className="view">
              <div className="home">
                <p className="greet-sub">{state.ready ? "Ce fil n'existe plus." : "Chargement…"}</p>
              </div>
            </div>
          )
        ) : route.name === "project" ? (
          routeProject ? (
            (() => {
              const page = (panel: boolean) => (
                <ProjectPage
                  // Another project starts afresh: a name being typed never follows to the next.
                  key={routeProject.id}
                  panel={panel}
                  project={routeProject}
                  threads={state.threads}
                  agents={state.agents}
                  ready={state.ready}
                  onOpenThread={openThread}
                  onNewThread={() => {
                    pickProject(routeProject.id);
                    go({ name: "home" });
                  }}
                  onTogglePin={togglePin}
                  onSetResolved={setArchived}
                  onDeleteThread={askDeleteThread}
                  onOpenPlanner={() => {
                    pickProject(routeProject.id);
                    go({ name: "planner" });
                  }}
                  onRemoveProject={() => askRemoveProject(routeProject.id)}
                  coordinator={coordinator}
                  settings={state.coordinator}
                  onOpenSettings={() => go({ name: "settings", section: "coordinator" })}
                  onStartCoordinator={
                    coordinator
                      ? undefined
                      : async (agentId) => {
                          await connection.request({
                            type: "coordinator.open",
                            requestId: newId(),
                            projectId: routeProject.id,
                            agentId,
                          });
                        }
                  }
                />
              );
              if (!coordinator) return page(false);
              // The thread last at work in the project, to pick up where things were left.
              const recent = listed.threads
                .filter((t) => t.projectId === routeProject.id && !t.archived && !t.parentId)
                .sort((a, b) => b.updatedAt - a.updatedAt)[0];
              const chat = (
                <ThreadView
                  intro={
                    <div className="pp-hello">
                      <p>
                        Prêt à travailler sur le projet « {routeProject.name} ». Quelques façons de
                        démarrer :
                      </p>
                      <div className="pp-starts">
                        {recent && (
                          <button onClick={() => openThread(recent.id)}>
                            <IconClock size={13} />
                            Reprendre le travail récent
                          </button>
                        )}
                        <button
                          onClick={() => {
                            pickProject(routeProject.id);
                            go({ name: "planner" });
                          }}
                        >
                          <IconBoard size={13} />
                          Établir un plan
                        </button>
                        <button onClick={() => setScheduling({ text: "" })}>
                          <IconClock size={13} />
                          Planifier une tâche
                        </button>
                        <button onClick={() => setConnectionsOpen(true)}>
                          <IconPlug size={13} />
                          Utiliser mes outils
                        </button>
                      </div>
                    </div>
                  }
                  key={coordinator.id}
                  thread={coordinator}
                  items={state.items[coordinator.id]}
                  agents={state.agents}
                  threads={state.threads}
                  onOpenThread={openThread}
                />
              );
              // The thread picked in the list takes the list's place, a way back above it.
              const pane = beside && (
                <section className="pp-thread" aria-label={beside.title}>
                  <header className="pp-crumb">
                    <button
                      className="pp-crumb-back"
                      onClick={() => go({ name: "project", projectId: routeProject.id })}
                    >
                      Fils de discussion
                    </button>
                    <span className="pp-crumb-sep" aria-hidden="true">
                      ›
                    </span>
                    <span className="pp-crumb-t" title={beside.title}>
                      {beside.title}
                    </span>
                    <button
                      className="ib"
                      aria-label={beside.archived ? "Rouvrir" : "Marquer résolu"}
                      title={beside.archived ? "Rouvrir" : "Marquer résolu"}
                      aria-pressed={!!beside.archived}
                      onClick={() => setArchived(beside.id, !beside.archived)}
                    >
                      <IconCheck size={15} />
                    </button>
                    <button
                      className="ib"
                      aria-label="Ouvrir en grand"
                      title="Ouvrir en grand, avec le code"
                      onClick={() => go({ name: "thread", threadId: beside.id })}
                    >
                      <IconExpand />
                    </button>
                    <ThreadMenu
                      actions={[
                        {
                          label: beside.pinned ? "Désépingler" : "Épingler",
                          run: () => togglePin(beside.id, !beside.pinned),
                        },
                        { label: "Exporter en Markdown", run: () => exportThread(beside) },
                        { label: "Supprimer…", danger: true, run: () => askDeleteThread(beside) },
                      ]}
                    />
                  </header>
                  <ThreadView
                    key={beside.id}
                    thread={beside}
                    items={state.items[beside.id]}
                    agents={state.agents}
                    threads={state.threads}
                    onOpenThread={openThread}
                  />
                  <div className="dock pp-dock">
                    {composerFor(beside, "Oriente ce fil de discussion…")}
                  </div>
                </section>
              );
              // Wide enough: the conversation, the threads beside it. Else one at a time.
              if (wide) {
                return (
                  <div className="pp-split">
                    <div className="pp-main">
                      {chat}
                      <div className="dock">{coordinatorDock}</div>
                    </div>
                    {pane || page(true)}
                  </div>
                );
              }
              if (pane) return pane;
              return (
                <div className="pp-stack">
                  <div className="pp-tabs" role="tablist" aria-label="Page du projet">
                    <button
                      role="tab"
                      aria-selected={projectTab === "chat"}
                      onClick={() => setProjectTab("chat")}
                    >
                      Coordinateur
                    </button>
                    <button
                      role="tab"
                      aria-selected={projectTab === "threads"}
                      onClick={() => setProjectTab("threads")}
                    >
                      Fils
                    </button>
                  </div>
                  {projectTab === "chat" ? chat : page(false)}
                </div>
              );
            })()
          ) : (
            <div className="view">
              <div className="home">
                <p className="greet-sub">
                  {state.ready ? "Ce projet n'existe plus." : "Chargement…"}
                </p>
              </div>
            </div>
          )
        ) : route.name === "planner" ? (
          <ErrorBoundary key={`planner:${project?.id ?? ""}`}>
            <Suspense fallback={<div className="view" />}>
              <Planner
                key={`${project?.id}:${plannerShown}`}
                project={project}
                plan={state.plan}
                schedules={state.schedules}
                onSchedule={(schedule) =>
                  setScheduling(schedule ? { text: "", schedule } : { text: "" })
                }
                threads={state.threads}
                agents={state.agents}
                onOpenThread={(id) => go({ name: "thread", threadId: id })}
                onNewProject={() => setCreatingProject(true)}
              />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <Home state={state} project={project} onNewProject={() => setCreatingProject(true)} />
        )}
        {route.name !== "settings" &&
          route.name !== "planner" &&
          // Under the « Fils » tab the coordinator's conversation is out of sight: so is its composer.
          // A thread shown alone on a narrow screen brings its own.
          // Beside its threads, the coordinator's is under its own conversation.
          !(coordinator && (wide || projectTab === "threads" || beside)) && (
            <div className="dock">
              {route.name === "home" && (narrow || sideOff) && (
                <HomeCards
                  state={state}
                  agents={state.agents}
                  onOpen={(t) =>
                    // A coordinator lives on its project's page, not as a thread of its own.
                    go(
                      t.kind === "coordinator"
                        ? { name: "project", projectId: t.projectId }
                        : { name: "thread", threadId: t.id },
                    )
                  }
                />
              )}
              {coordinator ? coordinatorDock : composerFor(spoken)}
              {route.name === "home" && narrow && (
                <TabBar
                  state={state}
                  onNew={() => go({ name: "home" })}
                  onProjects={() => setDrawer(true)}
                  onCode={(id) => {
                    go({ name: "thread", threadId: id });
                    setReviewOpen(true);
                  }}
                />
              )}
            </div>
          )}
      </main>
      {reviewOpen && thread?.workspace && !thread.archived && (
        <ReviewPanel
          key={thread.id}
          thread={thread}
          review={state.reviews[thread.id]}
          onClose={() => setReviewOpen(false)}
        />
      )}
      <Presence show={teamTask !== null && !!project}>
        {teamTask !== null && project && (
          <TeamDialog
            project={project}
            agents={state.agents}
            task={teamTask}
            onClose={() => setTeamTask(null)}
            onStarted={(id) => {
              setTeamTask(null);
              navigate({ name: "thread", threadId: id });
            }}
          />
        )}
      </Presence>
      <Presence show={scheduling !== null && !!project}>
        {scheduling && project && (
          <ScheduleDialog
            project={project}
            agents={state.agents}
            text={scheduling.text}
            schedule={scheduling.schedule}
            onClose={() => setScheduling(null)}
            onSaved={() => {
              setScheduling(null);
              // The planned tasks are listed in the planner.
              writePref("plannerView", "planifiees");
              go({ name: "planner" });
            }}
          />
        )}
      </Presence>
      <Presence show={creatingProject}>
        <NewProjectDialog
          onClose={() => setCreatingProject(false)}
          onCreated={(id) => {
            setCreatingProject(false);
            pickProject(id);
            go({ name: "home" });
          }}
        />
      </Presence>
      <Presence show={connectionsOpen}>
        <ConnectionsDialog
          agents={state.agents}
          mcpServers={state.mcpServers}
          onOpenMcp={() => {
            setConnectionsOpen(false);
            setMcpOpen(true);
          }}
          onClose={() => setConnectionsOpen(false)}
        />
      </Presence>
      <Presence show={requestsOpen}>
        <RequestsDialog
          requests={state.requests}
          threads={state.threads}
          onOpenThread={(id, itemId) => {
            setRequestsOpen(false);
            focusItem(id, itemId);
            openThread(id);
          }}
          onClose={() => setRequestsOpen(false)}
        />
      </Presence>
      <Presence show={!!confirm}>
        {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
      </Presence>
      <Presence show={mcpOpen}>
        <McpDialog servers={state.mcpServers} onClose={() => setMcpOpen(false)} />
      </Presence>
      {searchOpen && (
        <QuickSearch
          state={listed}
          actions={quickActions}
          onClose={() => setSearchOpen(false)}
          onOpenThread={(id, itemId) => {
            if (itemId) focusItem(id, itemId);
            openThread(id);
          }}
          onPickProject={(id) => {
            pickProject(id);
            go({ name: "home" });
          }}
        />
      )}
      {state.notice && (
        <div className="toast" role="status">
          {state.notice}
          <button onClick={() => connection.dismissNotice()}>Fermer</button>
        </div>
      )}
    </div>
  );
}

function Unauthorized() {
  return (
    <div className="gate">
      <div>
        <MoonMark width={44} height={44} />
        <h1>Lien de connexion requis</h1>
        <p>
          Ouvre MoonAgentic avec le lien affiché par le serveur au démarrage, celui qui finit par{" "}
          <code>?token=…</code>.
        </p>
      </div>
    </div>
  );
}
