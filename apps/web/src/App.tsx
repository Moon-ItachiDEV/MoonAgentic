import { onThreadLink } from "./components/Markdown.tsx";
import type { AgentInfo, Item, Project, Schedule, Thread } from "@moonagentic/protocol";
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Composer as PlainComposer } from "./components/Composer.tsx";
import { Presence } from "./components/Presence.tsx";
import { type Confirmation, ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { AppUpdateHostOnDemand, UpdateBar } from "./components/UpdateBar.tsx";
import { Artifacts } from "./components/Artifacts.tsx";
import { Home } from "./components/Home.tsx";
import { LockSheet } from "./components/LockSheet.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import type { QuickAction } from "./quick-actions.ts";
import { ProjectRequests, projectRequests } from "./components/ProjectRequests.tsx";
import { RequestsDialog } from "./components/RequestsDialog.tsx";
import { ReviewPanel } from "./components/ReviewPanel.tsx";
import { PairGate } from "./components/PairGate.tsx";
import { CoordinatorStart, ProjectOverview } from "./components/ProjectPage.tsx";
import { ProjectIcon } from "./components/ProjectIcon.tsx";
import { PullRequests } from "./components/PullRequests.tsx";
import { steady, useSame } from "./steady.tsx";
import { modelNameOf } from "./model-label.ts";
import { coordinatorOf, listedThreads, waitingCount } from "./project-threads.ts";
import { Sidebar as PlainSidebar } from "./components/Sidebar.tsx";
import { TabBar, type TabPop, TabPopover } from "./components/TabBar.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { teamActive } from "./team-rows.ts";
import { TeamDialog } from "./components/TeamDialog.tsx";
import { ReviewDialog } from "./components/ReviewDialog.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { DecisionCard } from "./components/DecisionCard.tsx";
import { connection, newId } from "./connection.ts";
import { downloadMarkdown, exportFileName, threadMarkdown } from "./export.ts";
import { isDiscussionsProject, isLooseHome, looseDefault } from "./default-models.ts";
import { waits } from "./decision.ts";
import { focusItem } from "./focus.ts";
import { askUnlock, lockProject } from "./lock.ts";
import { AppLock, lockApp } from "./components/AppLock.tsx";
import { readPref, writePref } from "./prefs.ts";
import { tightest } from "./quotas.ts";
import { navigate, useRoute } from "./router.ts";
import { useQuotas } from "./use-quotas.ts";
import { I, Sprite } from "./v2/I.tsx";
import type { IconName } from "./v2/sprite.ts";
import { Ring } from "./v2/Ring.tsx";
import { Sheet } from "./v2/Sheet.tsx";
import { QuotaList } from "./components/Subscriptions.tsx";
import { useScrFlags } from "./v2/scr.ts";
import { screenClasses, useScreen } from "./v2/use-screen.ts";

export { ErrorBoundary };

// The planner and the settings are loaded on demand, so they stay out of the main chunk.
const Planner = lazy(() =>
  import("./components/Planner.tsx").then((m) => ({ default: m.Planner })),
);
// Opened now and then: its editors stay out of the first load.
const ProjectSettings = lazy(() =>
  import("./components/ProjectSettings.tsx").then((m) => ({ default: m.ProjectSettings })),
);
const SettingsLayer = lazy(() =>
  import("./components/Settings.tsx").then((m) => ({ default: m.SettingsLayer })),
);

// While an agent writes, the page is told sixty times a second: the side bar and the
// composer show none of that text, and stay as they are.
const Sidebar = steady(PlainSidebar);
const Composer = steady(PlainComposer);

export function App() {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  /** The list open above one of the phone's tabs, on the home page. */
  const [tabPop, setTabPop] = useState<TabPop>(null);
  /** The open thread's « … » menu. */
  const [threadMenu, setThreadMenu] = useState(false);
  // Escape closes the menu open above the page, as a click beside it does.
  useEffect(() => {
    if (!threadMenu && !tabPop) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setThreadMenu(false);
      setTabPop(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [threadMenu, tabPop]);
  // The layout follows the window's width: phone, iPad, computer.
  const screen = useScreen();
  const flags = useScrFlags();
  const [creatingProject, setCreatingProject] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [pickedProjectId, setPickedProjectId] = useState(() => readPref("project"));
  /** « Nouvelle discussion » outside any project: a question or a search, in « Discussions ». */
  const [loose, setLoose] = useState(false);
  /** The search, in place of the menu. */
  const [searching, setSearching] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [teamTask, setTeamTask] = useState<string | null>(null);
  // « /revue » : the pull request typed after it, while its dialog is open.
  const [reviewPr, setReviewPr] = useState<string | null>(null);
  // The planning of a task for later: a new one with its text, or one being changed.
  const [scheduling, setScheduling] = useState<{ text: string; schedule?: Schedule } | null>(null);

  // Ctrl K (⌘ K on a Mac) opens the quick search from anywhere, even while typing.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((o) => !o);
      }
    };
    document.addEventListener("keydown", open);
    return () => document.removeEventListener("keydown", open);
  }, []);
  // Ctrl Maj L (⌘ ⇧ L) locks the whole app on this device, until the code is typed.
  const lockShortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    const lock = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        lockShortcut.current();
      }
    };
    document.addEventListener("keydown", lock);
    return () => document.removeEventListener("keydown", lock);
  }, []);

  /** On a narrow screen, what the project's page shows: the coordinator or the threads. */
  const [projectTab, setProjectTab] = useState<"chat" | "overview">("chat");
  /**
   * On a computer's wide screen the project's page is split: the coordinator on the left,
   * the « Vue d'ensemble » on the right, where a thread opens too.
   */
  const [pane, setPane] = useState<{ open: boolean; threadId?: string }>({ open: true });
  const [projectSetup, setProjectSetup] = useState(false);
  // Loaded the first time it is opened, then kept: it slides away when closed.
  const [projectSetupSeen, setProjectSetupSeen] = useState(false);
  if (projectSetup && !projectSetupSeen) setProjectSetupSeen(true);
  // Lists show every thread but the coordinators.
  const listedThreadsNow = useMemo(() => listedThreads(state.threads), [state.threads]);
  const listed = useMemo(
    () => ({ ...state, threads: listedThreadsNow }),
    [state, listedThreadsNow],
  );
  // The side bar shows no message: text being written does not change what it is given.
  const { items: _items, held: _held, reviews: _reviews, ...lists } = state;
  const sideState = useSame({ ...lists, threads: listedThreadsNow });
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
    if (lastPage.current && lastPage.current !== pageProjectId) {
      setProjectTab("chat");
      setPane((was) => ({ open: was.open }));
    }
    lastPage.current = pageProjectId;
  }, [pageProjectId]);

  /** On a phone, the settings show their list rather than a section. */
  const [settingsList, setSettingsList] = useState(false);

  // Every hook is above: an early return before one of them breaks the page when the state changes.
  if (state.status === "unauthorized") return <PairGate />;

  const thread: Thread | undefined =
    route.name === "thread" ? state.threads.find((t) => t.id === route.threadId) : undefined;
  // A project's page shows that project; elsewhere, the open thread's or the one last picked.
  const routeProject =
    route.name === "project" ? state.projects.find((p) => p.id === route.projectId) : undefined;
  /** The computer's split project page: coordinator, then the overview or a thread. */
  const split = !!routeProject && !routeProject.locked && screen.sp;
  const paneThread =
    split && pane.threadId
      ? state.threads.find((t) => t.id === pane.threadId && t.projectId === routeProject?.id)
      : undefined;
  // A locked project is never the one new conversations start in.
  const openProjects = state.projects.filter((p) => !p.locked);
  const looseHome = loose && route.name === "home";
  const discussions = openProjects.find(isDiscussionsProject);
  const codeProjects = openProjects.filter((p) => !isDiscussionsProject(p));
  // Outside a project, the conversation goes to « Discussions », made on the first message.
  const project =
    routeProject ??
    (looseHome
      ? discussions
      : (openProjects.find((p) => p.id === (thread?.projectId ?? pickedProjectId)) ??
        codeProjects[0] ??
        discussions));
  // On the home screen, starting without a code project (or in « Discussions ») starts on Hydrogen.
  const looseConversation = isLooseHome({ routeName: route.name, loose, project });

  // On a project's page, the conversation is its coordinator's, once it has one.
  const coordinator = routeProject ? coordinatorOf(state.threads, routeProject.id) : undefined;
  /** The thread the composer writes to. */
  const spoken = thread ?? coordinator;
  /** Locks it; a thread of it open here goes, as nothing of it is shown any more. */
  const lockOne = (p: Project) =>
    lockProject(p, state.lockPin, () => {
      if (route.name === "thread" && thread?.projectId === p.id) go({ name: "home" });
    });
  lockShortcut.current = () => lockApp(state.lockPin);
  const pickProject = (id: string) => {
    setLoose(false);
    setPickedProjectId(id);
    writePref("project", id);
  };
  /** With no project yet, the home page's conversation goes to « Discussions ». */
  // A project known or added meanwhile (the dialog, another window) is the one used:
  // « Discussions » is neither made nor picked over it.
  const needDiscussions = async () => {
    const known = connection.getState();
    // Before the server has said which projects exist, none is assumed missing.
    if (!known.ready) throw new Error("MoonAgentic se connecte encore : réessaie dans un instant.");
    const already = known.projects[0]?.id;
    if (already) return already;
    const id = await connection.request({ type: "project.discussions", requestId: newId() });
    const now = connection.getState().projects;
    if (now.some((p) => p.id !== id)) return id;
    pickProject(id);
    return id;
  };
  /** « Discussions », made if need be, for a conversation started outside any project. */
  const needLoose = () => connection.request({ type: "project.discussions", requestId: newId() });
  /** « Nouvelle discussion » from the top: outside any project. */
  const newLoose = () => {
    go({ name: "home" });
    setLoose(true);
  };
  // Any other way home (back, a deleted thread…) is the usual home, in the project last picked.
  const go = (next: Parameters<typeof navigate>[0]) => {
    setDrawer(false);
    setSearching(false);
    setTabPop(null);
    setThreadMenu(false);
    setReviewOpen(false);
    setLoose(false);
    setSettingsList(false);
    navigate(next);
  };
  /** Opens the settings: on a phone their list first, on a wider screen a section beside it. */
  const openSettings = () => {
    go({ name: "settings", section: "general" });
    setSettingsList(true);
  };
  /** Leaves the settings for where they were opened from. */
  const closeSettings = () => go({ name: "home" });
  const openAgents = () => go({ name: "settings", section: "agents" });
  const openMcp = () => go({ name: "settings", section: "mcp" });
  /** Opens the planner on its board or its timeline, the one last looked at on this device. */
  const openPlanner = () =>
    go(
      readPref("plannerView") === "timeline"
        ? { name: "planner", view: "timeline" }
        : { name: "planner" },
    );
  /** Opens a thread where it lives: a coordinator on its project's page. */
  const openThread = (id: string) => {
    const target = state.threads.find((t) => t.id === id);
    // Split page: a thread of this project opens beside its coordinator.
    if (split && target && target.kind !== "coordinator" && target.projectId === routeProject?.id) {
      setPane({ open: true, threadId: id });
      return;
    }
    if (target?.kind === "coordinator") {
      setProjectTab("chat");
      go({ name: "project", projectId: target.projectId });
    } else go({ name: "thread", threadId: id });
  };
  // A coordinator's link to a thread opens it as its line would, when the app knows it.
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  useEffect(
    () =>
      onThreadLink((id) => {
        if (connection.getState().threads.some((t) => t.id === id)) openThreadRef.current(id);
      }),
    [],
  );
  const togglePin = (id: string, pinned: boolean) =>
    connection.send({ type: "thread.setPinned", threadId: id, pinned });
  const exportThread = (t: Thread | undefined = spoken) => {
    const items = t && state.items[t.id];
    if (!t || !items) return;
    const save = (all: Item[]) =>
      downloadMarkdown(exportFileName(t.title), threadMarkdown(t, all, state.agents));
    if (!state.held[t.id]?.earlier) return save(items);
    // Only the end of a long thread is here: the whole of it is asked for.
    connection
      .ask({ type: "thread.read", requestId: newId(), threadId: t.id })
      .then((reply) => save(reply.items))
      .catch((error: unknown) =>
        connection.notify(error instanceof Error ? error.message : String(error)),
      );
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
  const threadActions: {
    label: string;
    icon: IconName;
    run: () => void;
    danger?: boolean;
    /** A line above it: what follows ends or removes the thread. */
    sep?: boolean;
  }[] = thread
    ? [
        {
          label: thread.pinned ? "Désépingler" : "Épingler",
          icon: "star",
          run: () => togglePin(thread.id, !thread.pinned),
        },
        ...(thread.archived
          ? []
          : [
              {
                label: thread.unread ? "Marquer comme lu" : "Marquer comme non lu",
                icon: "dot" as const,
                run: () =>
                  connection.send({
                    type: "thread.setUnread",
                    threadId: thread.id,
                    unread: !thread.unread,
                  }),
              },
            ]),
        { label: "Exporter en Markdown", icon: "file", run: () => exportThread() },
        // A team at work is stopped from here only, never by a button in its way.
        ...(thread.team && teamActive(thread.team)
          ? [
              {
                label: "Arrêter l'équipe",
                icon: "stop" as const,
                danger: true,
                sep: true,
                run: () => {
                  connection.send({ type: "team.stop", threadId: thread.id });
                },
              },
            ]
          : []),
        {
          label: thread.archived ? "Rouvrir" : "Marquer résolu",
          icon: "check",
          sep: true,
          run: () => setArchived(thread.id, !thread.archived),
        },
        { label: "Supprimer…", icon: "x", danger: true, run: () => askDeleteThread(thread) },
      ]
    : [];
  const quickActions: QuickAction[] = [
    {
      label: "Nouvelle discussion",
      icon: <I n="edit" s={17} />,
      run: newLoose,
    },
    {
      label: "Nouveau projet",
      icon: <I n="folder" s={17} />,
      run: () => setCreatingProject(true),
    },
    {
      label: `À traiter${state.requests.length ? ` (${state.requests.length})` : ""}`,
      icon: <I n="hand" s={17} />,
      run: () => go({ name: "inbox" }),
    },
    { label: "Planner", icon: <I n="grid" s={17} />, run: openPlanner },
    ...(project && !project.locked
      ? [
          {
            label: `Verrouiller le projet ${project.name}`,
            icon: <I n="lock" s={17} />,
            run: () => lockOne(project),
          },
        ]
      : []),
    {
      label: "Tâches planifiées",
      icon: <I n="clock" s={17} />,
      run: () => go({ name: "planner", view: "planifiees" }),
    },
    { label: "Connexions", icon: <I n="plug" s={17} />, run: openAgents },
    { label: "Serveurs MCP", icon: <I n="plug" s={17} />, run: openMcp },
    ...(thread
      ? [
          {
            label: thread.pinned ? "Désépingler cette discussion" : "Épingler cette discussion",
            icon: <I n="star" s={17} />,
            run: () => togglePin(thread.id, !thread.pinned),
          },
          {
            label: "Exporter cette discussion en Markdown",
            icon: <I n="file" s={17} />,
            run: () => exportThread(),
          },
          {
            label: thread.archived
              ? "Rouvrir cette discussion"
              : "Marquer cette discussion résolue",
            icon: <I n="check" s={17} />,
            run: () => setArchived(thread.id, !thread.archived),
          },
          {
            label: "Supprimer cette discussion",
            icon: <I n="x" s={17} />,
            run: () => askDeleteThread(thread),
          },
        ]
      : []),
  ];

  /** What a conversation is written from: its composer, or the way to reopen it once resolved. */
  const composerFor = (t: Thread | undefined, placeholder?: string, label?: string) => (
    <>
      {t?.archived && (
        <div className="res" role="status">
          <span className="ok">
            <I n="check" s={13} />
          </span>
          <span className="tx">
            <b>Ce fil est résolu</b>
            <small>Envoie un message pour le rouvrir.</small>
          </span>
          <button className="reopen press" onClick={() => setArchived(t.id, false)}>
            Rouvrir
          </button>
        </div>
      )}
      {t && !t.archived && (
        <DecisionCard
          waits={waits({
            thread: t,
            items: state.items[t.id],
            requests: state.requests,
            questions: state.questions,
            // A coordinator's page already lists what its project's threads wait for.
            own: t.kind === "coordinator",
          })}
          threadId={t.id}
          threads={state.threads}
          agents={state.agents}
          onOpenThread={(id, itemId) => {
            focusItem(id, itemId);
            openThread(id);
          }}
        />
      )}
      <Composer
        key={t?.id ?? "new"}
        agents={state.agents}
        favorites={state.favorites}
        thread={t}
        project={project}
        {...(placeholder ? { placeholder } : {})}
        {...(label ? { label } : {})}
        onNewProject={() => setCreatingProject(true)}
        {...(state.ready && !t && looseHome && !discussions
          ? { onNeedProject: needLoose }
          : state.ready && !state.projects.length
            ? { onNeedProject: needDiscussions }
            : {})}
        loose={!t && looseConversation}
        projects={codeProjects}
        onPickProject={pickProject}
        onPickLoose={newLoose}
        mcpServers={state.mcpServers}
        onMcp={openMcp}
        onCreated={(id) => navigate({ name: "thread", threadId: id })}
        onExport={() => exportThread(t)}
        onSearch={() => setSearching(true)}
        onRequests={() => go({ name: "inbox" })}
        onConnections={openAgents}
        onArchive={() => t && setArchived(t.id, true)}
        onDelete={() => t && askDeleteThread(t)}
        onTeam={(task) => setTeamTask(task)}
        onReview={(pr) => setReviewPr(pr)}
        onLock={lockOne}
        onSchedule={(text) => setScheduling({ text })}
        onSettings={() => go({ name: "settings", section: "general" })}
        onSubscriptions={() => go({ name: "settings", section: "subscriptions" })}
      />
    </>
  );

  /** What a project's lists of conversations can do with one. */
  const projectThreadActions = (p: Project) => ({
    onOpenThread: openThread,
    onNewThread: () => {
      pickProject(p.id);
      go({ name: "home" });
    },
    onTogglePin: togglePin,
    onSetArchived: setArchived,
    onDeleteThread: askDeleteThread,
  });

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
      {composerFor(coordinator, "Écrire au coordinateur")}
    </>
  );

  // On a phone the search takes the menu's place: the menu opens with it.
  const drawerOpen = drawer || searching;
  /** The agent the home page's composer starts on, whose subscription the ring shows. */
  const homeAgentId = looseConversation
    ? looseDefault(state.agents)?.agentId
    : (
        state.agents.find((a) => a.id === readPref("agent") && a.available) ??
        state.agents.find((a) => a.available)
      )?.id;
  const reviewing = reviewOpen && !!thread?.workspace && !thread.archived;
  const reviewCount = thread ? state.reviews[thread.id]?.files?.length : undefined;

  /** The name the page goes by in the mockup's layout rules. */
  const screenName =
    route.name === "home"
      ? "home"
      : route.name === "project"
        ? projectTab === "overview" && routeProject && !routeProject.locked && !split
          ? "overview"
          : "project"
        : route.name === "planner"
          ? route.view === "planifiees"
            ? "sched"
            : "planner"
          : route.name === "artifacts"
            ? "arts"
            : route.name;
  const menuPage =
    route.name === "inbox"
      ? "inbox"
      : route.name === "planner"
        ? route.view === "planifiees"
          ? "schedules"
          : "planner"
        : route.name === "artifacts"
          ? "artifacts"
          : route.name === "prs"
            ? "prs"
            : undefined;
  const pageTitle =
    route.name === "inbox"
      ? "À traiter"
      : route.name === "planner"
        ? route.view === "planifiees"
          ? "Tâches planifiées"
          : "Planner"
        : route.name === "artifacts"
          ? "Artefacts"
          : route.name === "prs"
            ? "Pull requests"
            : route.name === "settings"
              ? "Réglages"
              : undefined;
  const menuButton = (dot = false) => (
    <button
      className="gb glass press"
      data-a="drawer"
      aria-label="Menu"
      onClick={() => setDrawer(true)}
    >
      <I n="menu2" />
      {dot && <span className="dot" />}
    </button>
  );
  const threadAgent = thread && state.agents.find((a) => a.id === thread.agentId);
  const topBar =
    route.name === "home" ? (
      <>
        {menuButton(state.requests.length > 0)}
        <span />
        <HomeCapsule
          agents={state.agents}
          agentId={homeAgentId}
          onUsage={() => setUsageOpen(true)}
          onLock={() => lockApp(state.lockPin)}
        />
      </>
    ) : route.name === "project" && projectTab === "overview" && routeProject && !split ? (
      <>
        <button
          className="gb glass press"
          aria-label="Retour"
          onClick={() => setProjectTab("chat")}
        >
          <I n="back" />
        </button>
        <div className="ctr">
          <div className="ttl glass">
            <b>Vue d'ensemble</b>
            <span>{routeProject.name}</span>
          </div>
        </div>
        <span />
      </>
    ) : route.name === "project" ? (
      <>
        {menuButton()}
        <div className="ctr">
          {routeProject && !routeProject.locked && (
            <>
              <button
                className={`pava glass press${routeProject.color ? ` pc-${routeProject.color}` : ""}`}
                aria-label="Réglages du projet"
                onClick={() => setProjectSetup(true)}
              >
                <ProjectIcon project={routeProject} size={22} />
              </button>
              <button className="plabel glass" onClick={() => setProjectSetup(true)}>
                {routeProject.name}
              </button>
            </>
          )}
        </div>
        {routeProject && !routeProject.locked ? (
          <button
            className="gb glass press"
            aria-label="Vue d'ensemble"
            aria-expanded={split ? pane.open : undefined}
            onClick={() =>
              split ? setPane((was) => ({ open: !was.open })) : setProjectTab("overview")
            }
          >
            <I n="list" s={21} />
            {waitingCount(state.threads, routeProject.id) > 0 && <span className="dot" />}
          </button>
        ) : (
          <span />
        )}
      </>
    ) : route.name === "thread" ? (
      <>
        <button
          className="gb glass press"
          aria-label="Retour"
          onClick={() =>
            thread && codeProjects.some((p) => p.id === thread.projectId)
              ? go({ name: "project", projectId: thread.projectId })
              : go({ name: "home" })
          }
        >
          <I n="back" />
        </button>
        <div className="ctr">
          {thread && (
            <div className="ttl glass">
              <b>
                {thread.pinned && (
                  <i className="tpn" role="img" aria-label="Épinglé">
                    <I n="star" s={12} />
                  </i>
                )}
                {thread.title}
              </b>
              <span>{thread.team ? "Équipe" : (threadAgent?.name ?? "Agent retiré")}</span>
            </div>
          )}
        </div>
        {thread ? (
          <div className="gcap glass">
            {thread.workspace && !thread.archived && (
              <button
                aria-label={
                  reviewCount ? `Modifications : ${reviewCount} à revoir` : "Modifications"
                }
                aria-pressed={reviewing}
                onClick={() => setReviewOpen(!reviewing)}
              >
                <I n="code" s={20} />
              </button>
            )}
            <button
              className={threadMenu ? "act" : undefined}
              aria-label="Actions du fil"
              aria-haspopup="menu"
              aria-expanded={threadMenu}
              onClick={() => setThreadMenu(!threadMenu)}
            >
              <I n="dots" s={20} />
            </button>
          </div>
        ) : (
          <span />
        )}
      </>
    ) : (
      <>
        {menuButton()}
        <div className="ctr">
          <div className="ttl glass">
            <b>{pageTitle}</b>
          </div>
        </div>
        <span />
      </>
    );

  /** What is written from, floating at the bottom of the page: none where there is nothing to write to. */
  const bottom =
    route.name === "home" ? (
      <>
        <UpdateBar />
        {composerFor(undefined)}
      </>
    ) : route.name === "thread" ? (
      thread && composerFor(thread)
    ) : route.name === "project" &&
      // A locked project's page has nothing to write to until the code is given; under
      // « Fils » the coordinator's conversation is out of sight, and so is its composer.
      !routeProject?.locked &&
      (projectTab === "chat" || split) ? (
      coordinatorDock
    ) : null;

  return (
    <div
      id="scr"
      className={`scr${screenClasses(screen)}${drawerOpen ? " open" : ""}${route.name === "home" ? " tabs" : ""}${tabPop && route.name === "home" ? " tp" : ""}${threadMenu ? " tm" : ""}${split && !pane.open ? " pclosed" : ""}${flags ? ` ${flags}` : ""}`}
      data-s={screenName}
    >
      <Sprite />
      <aside className="drawer" id="drawer" aria-label="Menu" inert={!screen.wide && !drawerOpen}>
        <Sidebar
          state={sideState}
          activeThreadId={thread?.id}
          activeProjectId={route.name === "project" ? route.projectId : undefined}
          page={menuPage}
          searching={searching}
          onSearching={setSearching}
          onListActions={() => quickActions}
          onOpenInbox={() => go({ name: "inbox" })}
          onOpenPlanner={openPlanner}
          onOpenSchedules={() => go({ name: "planner", view: "planifiees" })}
          onOpenArtifacts={() => go({ name: "artifacts" })}
          onOpenPrs={() => go({ name: "prs" })}
          onNewThread={newLoose}
          onNewProject={() => {
            setDrawer(false);
            setCreatingProject(true);
          }}
          onPickProject={(id) => {
            pickProject(id);
            go({ name: "project", projectId: id });
          }}
          onOpenThread={(id, itemId) => {
            if (itemId) focusItem(id, itemId);
            go({ name: "thread", threadId: id });
          }}
          onTogglePin={togglePin}
          onSetArchived={setArchived}
          onDeleteThread={(t) => {
            setDrawer(false);
            askDeleteThread(t);
          }}
          onOpenSettings={openSettings}
        />
      </aside>
      <section className="main" id="main">
        {route.name === "home" || route.name === "settings" ? (
          <Home loading={!state.ready} />
        ) : route.name === "thread" ? (
          thread ? (
            <ThreadView
              thread={thread}
              items={state.items[thread.id]}
              held={state.held[thread.id]}
              agents={state.agents}
              threads={state.threads}
              onOpenThread={(id) => navigate({ name: "thread", threadId: id })}
            />
          ) : (
            <div className="view" id="view">
              <div className="empty">
                {state.ready && (
                  <>
                    <span className="ei">
                      <I n="bubble" s={24} />
                    </span>
                    <b>
                      {state.projects.some((p) => p.locked)
                        ? "Ce fil n'existe plus, ou son projet est verrouillé"
                        : "Ce fil n'existe plus"}
                    </b>
                  </>
                )}
              </div>
            </div>
          )
        ) : route.name === "project" ? (
          routeProject?.locked ? (
            <div className="view" id="view">
              <div className="empty">
                <span className="ei">
                  <I n="lock" s={24} />
                </span>
                <b>{routeProject.name} est verrouillé</b>
                <button className="newth press" onClick={() => askUnlock(routeProject)}>
                  Déverrouiller
                </button>
              </div>
            </div>
          ) : !routeProject ? (
            <div className="view" id="view">
              <div className="empty">
                {state.ready && (
                  <>
                    <span className="ei">
                      <I n="folder" s={24} />
                    </span>
                    <b>Ce projet n'existe plus</b>
                  </>
                )}
              </div>
            </div>
          ) : projectTab === "overview" && !split ? (
            <ProjectOverview
              key={routeProject.id}
              project={routeProject}
              threads={state.threads}
              agents={state.agents}
              schedules={state.schedules}
              coordinator={coordinator}
              online={state.status === "open"}
              settings={state.coordinator}
              onOpenSettings={() => go({ name: "settings", section: "coordinator" })}
              onOpenArtifacts={() => go({ name: "artifacts" })}
              onSchedule={(schedule) =>
                setScheduling(schedule ? { text: "", schedule } : { text: "" })
              }
              {...projectThreadActions(routeProject)}
            />
          ) : coordinator ? (
            <ThreadView
              intro={(() => {
                // The thread last at work in the project, to pick up where things were left.
                const recent = listed.threads
                  .filter((t) => t.projectId === routeProject.id && !t.archived && !t.parentId)
                  .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                return (
                  <div className="chips wrap pstarts">
                    {recent && (
                      <button className="ppill" onClick={() => openThread(recent.id)}>
                        <I n="clock" s={14} />
                        Reprendre le travail récent
                      </button>
                    )}
                    <button
                      className="ppill"
                      onClick={() => {
                        pickProject(routeProject.id);
                        go({ name: "planner" });
                      }}
                    >
                      <I n="grid" s={14} />
                      Établir un plan
                    </button>
                    <button className="ppill" onClick={() => setScheduling({ text: "" })}>
                      <I n="clock" s={14} />
                      Planifier une tâche
                    </button>
                    <button className="ppill" onClick={openMcp}>
                      <I n="plug" s={14} />
                      Utiliser mes outils
                    </button>
                  </div>
                );
              })()}
              key={coordinator.id}
              thread={coordinator}
              items={state.items[coordinator.id]}
              held={state.held[coordinator.id]}
              agents={state.agents}
              threads={state.threads}
              onOpenThread={openThread}
            />
          ) : (
            <CoordinatorStart
              key={routeProject.id}
              project={routeProject}
              agents={state.agents}
              favorites={state.favorites}
              ready={state.ready}
              onOpenConnections={openAgents}
              onStart={async (pick) => {
                await connection.request({
                  type: "coordinator.open",
                  requestId: newId(),
                  projectId: routeProject.id,
                  agentId: pick.agentId,
                  ...(pick.model ? { model: pick.model } : {}),
                });
              }}
            />
          )
        ) : route.name === "artifacts" ? (
          <ErrorBoundary key="artifacts">
            <Artifacts
              threads={state.threads}
              projects={state.projects}
              online={state.status === "open"}
              onOpenThread={(id) => go({ name: "thread", threadId: id })}
            />
          </ErrorBoundary>
        ) : route.name === "planner" ? (
          <ErrorBoundary key={`planner:${project?.id ?? ""}`}>
            <Suspense fallback={<div className="view" />}>
              <Planner
                key={project?.id}
                project={project}
                view={route.view}
                onView={(view) => go(view ? { name: "planner", view } : { name: "planner" })}
                plan={state.plan}
                schedules={state.schedules}
                projects={openProjects}
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
        ) : route.name === "inbox" ? (
          <RequestsDialog
            requests={state.requests}
            threads={state.threads}
            projects={state.projects}
            onOpenThread={(id, itemId) => {
              focusItem(id, itemId);
              openThread(id);
            }}
          />
        ) : (
          <PullRequests threads={state.threads} onOpenThread={openThread} />
        )}
        <div className="tfade" />
        {bottom && <div className="bfade" />}
        <div className="mtop" id="top">
          {topBar}
        </div>
        {bottom && <Bottom>{bottom}</Bottom>}
        <div
          className="tpscrim"
          onClick={() => {
            setTabPop(null);
            setThreadMenu(false);
          }}
        />
        {route.name === "home" && tabPop && !screen.wide && (
          <TabPopover
            state={listed}
            pop={tabPop}
            onPickProject={(id) => {
              pickProject(id);
              go({ name: "project", projectId: id });
            }}
            onNewProject={() => {
              setTabPop(null);
              setCreatingProject(true);
            }}
            onOpenThread={(id) => go({ name: "thread", threadId: id })}
            onNewThread={() => {
              setTabPop(null);
              const first = codeProjects[0];
              if (first) pickProject(first.id);
              else setCreatingProject(true);
            }}
            onOpenArtifacts={() => go({ name: "artifacts" })}
          />
        )}
        {threadMenu && thread && (
          <div className="pmenu tmn" role="menu" aria-label="Actions du fil">
            {threadActions.map((a, i) => (
              <Fragment key={a.label}>
                {a.sep && <div className="psep" style={{ "--i": i } as React.CSSProperties} />}
                <button
                  className={`pi2${a.danger ? " dng" : ""}`}
                  role="menuitem"
                  style={{ "--i": i } as React.CSSProperties}
                  onClick={() => {
                    setThreadMenu(false);
                    a.run();
                  }}
                >
                  <I n={a.icon} s={20} />
                  <span className="nm">{a.label}</span>
                </button>
              </Fragment>
            ))}
          </div>
        )}
        {route.name === "home" && !screen.wide && (
          <TabBar state={listed} pop={tabPop} onPop={setTabPop} />
        )}
        {split && routeProject && (
          <aside
            className="rpan"
            id="rpan"
            aria-label="Fils du projet"
            aria-hidden={!pane.open}
            inert={!pane.open}
          >
            {paneThread ? (
              <div className="pin" key={paneThread.id}>
                <div className="phd crumb">
                  <button className="cr press" onClick={() => setPane({ open: true })}>
                    Fils de discussion
                  </button>
                  <span className="csep" aria-hidden>
                    ›
                  </span>
                  <span className="cur">{paneThread.title}</span>
                  <span className="sp" />
                  <button
                    className="ib press"
                    aria-label="Ouvrir le fil en pleine page"
                    onClick={() => go({ name: "thread", threadId: paneThread.id })}
                  >
                    <I n="ext" s={17} />
                  </button>
                  <button
                    className="ib press"
                    aria-label="Fermer le panneau"
                    onClick={() => setPane({ open: false })}
                  >
                    <I n="x" s={18} />
                  </button>
                </div>
                <ThreadView
                  thread={paneThread}
                  items={state.items[paneThread.id]}
                  held={state.held[paneThread.id]}
                  agents={state.agents}
                  threads={state.threads}
                  onOpenThread={openThread}
                />
                <div className="pbt">
                  {composerFor(paneThread, "Orienter ce fil", "Orienter ce fil")}
                </div>
              </div>
            ) : (
              <ProjectOverview
                key={routeProject.id}
                pane={{ onClose: () => setPane({ open: false }) }}
                project={routeProject}
                threads={state.threads}
                agents={state.agents}
                schedules={state.schedules}
                coordinator={coordinator}
                online={state.status === "open"}
                settings={state.coordinator}
                onOpenSettings={() => go({ name: "settings", section: "coordinator" })}
                onOpenArtifacts={() => go({ name: "artifacts" })}
                onSchedule={(schedule) =>
                  setScheduling(schedule ? { text: "", schedule } : { text: "" })
                }
                {...projectThreadActions(routeProject)}
              />
            )}
          </aside>
        )}
        <div className="veil" id="veil" onClick={() => setDrawer(false)} />
      </section>
      {thread?.workspace && !thread.archived && (
        <ReviewPanel
          key={thread.id}
          open={reviewing}
          thread={thread}
          review={state.reviews[thread.id]}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {route.name === "project" && routeProject && !routeProject.locked && projectSetupSeen && (
        <Suspense fallback={null}>
          <ProjectSettings
            key={routeProject.id}
            project={routeProject}
            open={projectSetup}
            unread={state.threads.some((t) => t.projectId === routeProject.id && t.unread)}
            coordinator={
              coordinator
                ? (modelNameOf(
                    state.agents.find((a) => a.id === coordinator.agentId)?.models,
                    coordinator.model,
                  ) ?? state.agents.find((a) => a.id === coordinator.agentId)?.name)
                : undefined
            }
            onClose={() => setProjectSetup(false)}
            onOpenCoordinator={() => go({ name: "settings", section: "coordinator" })}
            onOpenUsage={() => go({ name: "settings", section: "subscriptions" })}
            onOpenPlanner={() => {
              pickProject(routeProject.id);
              openPlanner();
            }}
            onLock={() => lockOne(routeProject)}
            onRemove={() => askRemoveProject(routeProject.id)}
          />
        </Suspense>
      )}
      {route.name === "settings" && (
        <ErrorBoundary key="settings" resetKey={route.section}>
          <Suspense fallback={null}>
            <SettingsLayer
              section={route.section}
              list={settingsList}
              wide={screen.wide}
              onPick={(section) => {
                setSettingsList(false);
                navigate({ name: "settings", section }, { replace: true });
              }}
              onList={() => setSettingsList(true)}
              onClose={closeSettings}
              agents={state.agents}
              favorites={state.favorites}
              coordinator={state.coordinator}
              projects={state.projects}
              lockPin={state.lockPin}
              projectId={project?.id}
              mcpServers={state.mcpServers}
              mcpSecretsError={state.mcpSecretsError}
              onPickProject={pickProject}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <TeamDialog
        open={teamTask !== null && !!project}
        project={project}
        agents={state.agents}
        favorites={state.favorites}
        task={teamTask ?? ""}
        onClose={() => setTeamTask(null)}
        onStarted={(id) => {
          setTeamTask(null);
          navigate({ name: "thread", threadId: id });
        }}
      />
      <ReviewDialog
        open={reviewPr !== null && !!project}
        project={project}
        agents={state.agents}
        favorites={state.favorites}
        threads={state.threads}
        saved={state.coordinator.review}
        savedJudge={state.coordinator.reviewJudge}
        pr={reviewPr ?? ""}
        onClose={() => setReviewPr(null)}
        onStarted={(id) => {
          setReviewPr(null);
          navigate({ name: "thread", threadId: id });
        }}
      />
      <ScheduleDialog
        open={scheduling !== null}
        projects={openProjects}
        projectId={project?.id}
        agents={state.agents}
        favorites={state.favorites}
        text={scheduling?.text ?? ""}
        schedule={scheduling?.schedule}
        onClose={() => setScheduling(null)}
        onSaved={() => {
          setScheduling(null);
          // The planned tasks are listed at their own address.
          go({ name: "planner", view: "planifiees" });
        }}
      />
      <NewProjectDialog
        open={creatingProject}
        onClose={() => setCreatingProject(false)}
        onCreated={(id) => {
          setCreatingProject(false);
          pickProject(id);
          go({ name: "project", projectId: id });
        }}
      />
      <LockSheet />
      <AppUpdateHostOnDemand />
      <Presence show={!!confirm}>
        {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
      </Presence>
      {/* Shown on every page, the phone's included. */}
      {state.status === "closed" && (
        <div className="offp glass" role="status">
          <span className="t2-spin" />
          Reconnexion
        </div>
      )}
      <Sheet open={usageOpen} onClose={() => setUsageOpen(false)} title="Utilisation" tall>
        <div className="sbody">
          {usageOpen && <QuotaList agents={state.agents} first={homeAgentId} />}
        </div>
      </Sheet>
      <AppLock threads={state.threads} hasPin={state.lockPin} ready={state.ready} />
      {/* The server saves nothing meanwhile: said on every page too, under no other notice. */}
      {state.status !== "closed" && state.storageError && (
        <div className="offp glass unsaved" role="alert">
          {state.storageError}
        </div>
      )}
      {state.notice && (
        <div className="toast on" role="status">
          <span>{state.notice}</span>
          <button onClick={() => connection.dismissNotice()}>Fermer</button>
        </div>
      )}
    </div>
  );
}

/**
 * What floats at the bottom of the page: its height is told to the page, which keeps that
 * much room under its last line.
 */
function Bottom({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const main = el?.parentElement;
    if (!el || !main) return;
    const tell = () => main.style.setProperty("--cbh", `${el.offsetHeight + 12}px`);
    tell();
    const watch = new ResizeObserver(tell);
    watch.observe(el);
    return () => {
      watch.disconnect();
      main.style.removeProperty("--cbh");
    };
  }, []);
  return (
    <div
      className="bottom"
      id="bottom"
      ref={box}
      // A press on a button above the composer keeps the composer's focus: losing it folds
      // the composer, and the button would move away before the press ends.
      onMouseDown={(e) => {
        const on = e.target as Element;
        if (on.closest("button") && !on.closest(".cmp")) e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}

/** On the home page's top right: what the composer's agent has used of its subscription, and the lock. */
function HomeCapsule(props: {
  agents: AgentInfo[];
  agentId: string | undefined;
  onUsage: () => void;
  onLock?: () => void;
}) {
  const quotas = useQuotas();
  const worst = tightest(quotas.find((q) => q.agentId === props.agentId));
  const name = props.agents.find((a) => a.id === props.agentId)?.name;
  if (!worst && !props.onLock) return <span />;
  return (
    <div className="gcap glass">
      {worst && (
        <button
          aria-label={`Utilisation de ${name ?? "l'agent"} : ${Math.round(worst.usedPercent)} %`}
          onClick={props.onUsage}
        >
          <Ring percent={worst.usedPercent} />
        </button>
      )}
      {props.onLock && (
        <button
          aria-label="Verrouiller l'app"
          title="Verrouiller l'app (Ctrl Maj L)"
          onClick={props.onLock}
        >
          <I n="lock" s={20} />
        </button>
      )}
    </div>
  );
}
