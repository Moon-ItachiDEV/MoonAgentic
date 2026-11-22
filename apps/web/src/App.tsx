import type { Schedule, Thread } from "@moonagentic/protocol";
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { Composer } from "./components/Composer.tsx";
import { Presence } from "./components/Presence.tsx";
import { type Confirmation, ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { ConnectionsDialog } from "./components/ConnectionsDialog.tsx";
import { Home } from "./components/Home.tsx";
import {
  IconCode,
  IconShield,
  IconMenu,
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
import { McpDialog } from "./components/McpDialog.tsx";
import { MoonMark } from "./components/MoonMark.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { type QuickAction, QuickSearch } from "./components/QuickSearch.tsx";
import { RequestsDialog } from "./components/RequestsDialog.tsx";
import { ReviewPanel } from "./components/ReviewPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { ThreadMenu } from "./components/ThreadMenu.tsx";
import { TeamDialog } from "./components/TeamDialog.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { connection, newId } from "./connection.ts";
import { downloadMarkdown, exportFileName, threadMarkdown } from "./export.ts";
import { focusItem } from "./focus.ts";
import { readPref, writePref } from "./prefs.ts";
import { navigate, useRoute } from "./router.ts";

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

export function App() {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
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

  if (state.status === "unauthorized") return <Unauthorized />;

  const thread: Thread | undefined =
    route.name === "thread" ? state.threads.find((t) => t.id === route.threadId) : undefined;
  const project =
    state.projects.find((p) => p.id === (thread?.projectId ?? pickedProjectId)) ??
    state.projects[0];

  const pickProject = (id: string) => {
    setPickedProjectId(id);
    writePref("project", id);
  };
  const go = (next: Parameters<typeof navigate>[0]) => {
    setDrawer(false);
    setReviewOpen(false);
    navigate(next);
  };
  const togglePin = (id: string, pinned: boolean) =>
    connection.send({ type: "thread.setPinned", threadId: id, pinned });
  const exportThread = () => {
    const items = thread && state.items[thread.id];
    if (!thread || !items) return;
    downloadMarkdown(exportFileName(thread.title), threadMarkdown(thread, items, state.agents));
  };
  const setArchived = (id: string, archived: boolean) =>
    connection.send({ type: "thread.setArchived", threadId: id, archived });
  const askDeleteThread = (t: Thread) =>
    setConfirm({
      title: "Supprimer cette discussion ?",
      text: t.workspace
        ? `« ${t.title} » et sa copie de travail seront supprimées. Sa branche ${t.workspace.branch} reste dans le dépôt, avec ses commits.`
        : `« ${t.title} » sera supprimée, avec tous ses messages.`,
      action: "Supprimer",
      // The box stays open, and says why, until the server has really deleted it.
      run: async () => {
        await connection.request({ type: "thread.delete", requestId: newId(), threadId: t.id });
        if (thread?.id === t.id) go({ name: "home" });
      },
    });
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
        if (thread?.projectId === id) go({ name: "home" });
      },
    });
  };
  const threadActions = thread
    ? [
        {
          label: thread.pinned ? "Désépingler" : "Épingler",
          run: () => togglePin(thread.id, !thread.pinned),
        },
        { label: "Exporter en Markdown", run: exportThread },
        {
          label: thread.archived ? "Désarchiver" : "Archiver",
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
          { label: "Exporter cette discussion en Markdown", icon: <IconFile />, run: exportThread },
          {
            label: thread.archived ? "Désarchiver cette discussion" : "Archiver cette discussion",
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

  const reviewing = reviewOpen && !!thread?.workspace && !thread.archived;
  const reviewCount = thread ? state.reviews[thread.id]?.files?.length : undefined;

  return (
    <div
      className={`app${drawer ? " drawer" : ""}${route.name === "home" ? " home-route" : ""}${reviewing ? " reviewing" : ""}`}
    >
      {route.name === "settings" ? (
        // Until the settings arrive, an empty side bar keeps the layout in place.
        <Suspense fallback={<aside className="side set-side" aria-label="Réglages" />}>
          <SettingsNav
            section={route.section}
            onPick={(section) => go({ name: "settings", section })}
            onBack={() => go({ name: "home" })}
          />
        </Suspense>
      ) : (
        <Sidebar
          state={state}
          activeThreadId={thread?.id}
          activeProjectId={project?.id}
          onPlanner={route.name === "planner"}
          onOpenPlanner={() => go({ name: "planner" })}
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
            // On the planner, picking a project shows that project's planner.
            go(route.name === "planner" ? { name: "planner" } : { name: "home" });
          }}
          onOpenThread={(id) => go({ name: "thread", threadId: id })}
          onTogglePin={togglePin}
          onRemoveProject={(id) => {
            setDrawer(false);
            askRemoveProject(id);
          }}
          onOpenSettings={() => go({ name: "settings", section: "general" })}
          onOpenSearch={() => {
            setDrawer(false);
            setSearchOpen(true);
          }}
        />
      )}
      <div className="side-scrim" onClick={() => setDrawer(false)} />
      <main className="center">
        <header className="top">
          <button className="ib mobile-only" aria-label="Menu" onClick={() => setDrawer(true)}>
            <IconMenu />
          </button>
          <div className="ttl">
            {route.name === "settings" ? "Réglages" : (thread?.title ?? "")}
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
          <Suspense fallback={<div className="view" />}>
            <SettingsPage
              section={route.section}
              agents={state.agents}
              favorites={state.favorites}
              projects={state.projects}
              projectId={project?.id}
              mcpServers={state.mcpServers}
              onPickProject={pickProject}
              onOpenConnections={() => setConnectionsOpen(true)}
              onOpenMcp={() => setMcpOpen(true)}
            />
          </Suspense>
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
        ) : route.name === "planner" ? (
          <Suspense fallback={<div className="view" />}>
            <Planner
              key={project?.id}
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
        ) : (
          <Home state={state} project={project} onNewProject={() => setCreatingProject(true)} />
        )}
        {route.name !== "settings" && route.name !== "planner" && (
          <div className="dock">
            {thread?.archived ? (
              <div className="archived-bar" role="status">
                <IconArchive />
                <span>Cette discussion est archivée.</span>
                <button className="btn sm" onClick={() => setArchived(thread.id, false)}>
                  Désarchiver
                </button>
              </div>
            ) : (
              <Composer
                key={thread?.id ?? "new"}
                agents={state.agents}
                favorites={state.favorites}
                thread={thread}
                project={project}
                onNewProject={() => setCreatingProject(true)}
                onCreated={(id) => navigate({ name: "thread", threadId: id })}
                onExport={exportThread}
                onSearch={() => setSearchOpen(true)}
                onRequests={() => setRequestsOpen(true)}
                onConnections={() => setConnectionsOpen(true)}
                onArchive={() => thread && setArchived(thread.id, true)}
                onDelete={() => thread && askDeleteThread(thread)}
                onTeam={(task) => setTeamTask(task)}
                onSchedule={(text) => setScheduling({ text })}
                onSettings={() => go({ name: "settings", section: "general" })}
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
            go({ name: "thread", threadId: id });
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
          state={state}
          actions={quickActions}
          onClose={() => setSearchOpen(false)}
          onOpenThread={(id, itemId) => {
            if (itemId) focusItem(id, itemId);
            go({ name: "thread", threadId: id });
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
