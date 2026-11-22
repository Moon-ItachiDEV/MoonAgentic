import type { Thread } from "@moonagentic/protocol";
import { useState, useSyncExternalStore } from "react";
import { Composer } from "./components/Composer.tsx";
import { Home } from "./components/Home.tsx";
import { IconBranch, IconMenu, IconCompose } from "./components/icons.tsx";
import { McpDialog } from "./components/McpDialog.tsx";
import { MoonMark } from "./components/MoonMark.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { ReviewPanel } from "./components/ReviewPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { connection } from "./connection.ts";
import { readPref, writePref } from "./prefs.ts";
import { navigate, useRoute } from "./router.ts";

export function App() {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pickedProjectId, setPickedProjectId] = useState(() => readPref("project"));

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

  return (
    <div className={`app${drawer ? " drawer" : ""}${route.name === "home" ? " home-route" : ""}`}>
      <Sidebar
        state={state}
        activeThreadId={thread?.id}
        activeProjectId={project?.id}
        onNewThread={() => go({ name: "home" })}
        onNewProject={() => {
          setDrawer(false);
          setCreatingProject(true);
        }}
        onOpenMcp={() => {
          setDrawer(false);
          setMcpOpen(true);
        }}
        onPickProject={(id) => {
          pickProject(id);
          go({ name: "home" });
        }}
        onOpenThread={(id) => go({ name: "thread", threadId: id })}
      />
      <div className="side-scrim" onClick={() => setDrawer(false)} />
      <main className="center">
        <header className="top">
          <button className="ib mobile-only" aria-label="Menu" onClick={() => setDrawer(true)}>
            <IconMenu />
          </button>
          <div className="ttl">{thread?.title ?? ""}</div>
          {thread?.workspace && (
            <button
              className="review-btn"
              aria-label="À revoir"
              title="À revoir"
              onClick={() => setReviewOpen(true)}
            >
              <IconBranch />
              <span className="lbl">À revoir</span>
            </button>
          )}
          {route.name === "thread" ? (
            <button
              className="ib mobile-only"
              aria-label="Nouvelle discussion"
              onClick={() => go({ name: "home" })}
            >
              <IconCompose size={17} />
            </button>
          ) : (
            <span className="spacer mobile-only" />
          )}
        </header>
        {route.name === "thread" ? (
          thread ? (
            <ThreadView thread={thread} items={state.items[thread.id]} agents={state.agents} />
          ) : (
            <div className="view">
              <div className="home">
                <p className="greet-sub">{state.ready ? "Ce fil n'existe plus." : "Chargement…"}</p>
              </div>
            </div>
          )
        ) : (
          <Home state={state} project={project} onNewProject={() => setCreatingProject(true)} />
        )}
        <div className="dock">
          <Composer
            key={thread?.id ?? "new"}
            agents={state.agents}
            favorites={state.favorites}
            thread={thread}
            project={project}
            onNewProject={() => setCreatingProject(true)}
            onCreated={(id) => navigate({ name: "thread", threadId: id })}
          />
        </div>
      </main>
      {creatingProject && (
        <NewProjectDialog
          onClose={() => setCreatingProject(false)}
          onCreated={(id) => {
            setCreatingProject(false);
            pickProject(id);
            go({ name: "home" });
          }}
        />
      )}
      {reviewOpen && thread?.workspace && (
        <ReviewPanel
          thread={thread}
          files={state.reviews[thread.id]}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {mcpOpen && <McpDialog servers={state.mcpServers} onClose={() => setMcpOpen(false)} />}
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
