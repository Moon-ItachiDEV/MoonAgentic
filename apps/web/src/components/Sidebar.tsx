import type { Thread } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { useState } from "react";
import {
  IconArchive,
  IconClose,
  IconCompose,
  IconFolder,
  IconInbox,
  IconPin,
  IconPlug,
} from "./icons.tsx";
import { Wordmark } from "./MoonMark.tsx";

function ThreadStatus({ thread }: { thread: Thread }) {
  if (thread.status === "running") return <span className="spin" aria-label="En cours" />;
  if (thread.status === "waiting") return <span className="dot" aria-label="Attend ta réponse" />;
  if (thread.status === "error") return <span className="dot err" aria-label="Erreur" />;
  return null;
}

export function Sidebar(props: {
  state: State;
  activeThreadId: string | undefined;
  activeProjectId: string | undefined;
  onNewThread: () => void;
  onNewProject: () => void;
  onOpenConnections: () => void;
  onOpenRequests: () => void;
  onPickProject: (id: string) => void;
  onOpenThread: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onRemoveProject: (id: string) => void;
}) {
  const { state } = props;
  const available = state.agents.filter((a) => a.available).length;
  const countByProject = new Map<string, number>();
  for (const t of state.threads)
    countByProject.set(t.projectId, (countByProject.get(t.projectId) ?? 0) + 1);

  const [showArchived, setShowArchived] = useState(false);
  const live = state.threads.filter((t) => !t.archived);
  const archived = state.threads.filter((t) => t.archived);
  // A coder's thread sits under its lead's, wherever the lead is listed.
  const listed = new Set(live.map((t) => t.id));
  const childrenOf = new Map<string, Thread[]>();
  for (const t of live) {
    if (t.parentId && listed.has(t.parentId)) {
      childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
    }
  }
  const top = live.filter((t) => !(t.parentId && listed.has(t.parentId)));
  // A team's reviewers and testers are reached from its card; they show here only while
  // open, or while they wait on the user.
  const shown = (t: Thread) =>
    (t.role !== "reviewer" && t.role !== "tester") ||
    t.id === props.activeThreadId ||
    t.status === "waiting";
  const pinned = top.filter((t) => t.pinned);
  const recent = top.filter((t) => !t.pinned);
  // Coders in the order the lead handed out their pieces.
  const tree = (t: Thread) => [
    row(t),
    ...(childrenOf.get(t.id) ?? [])
      .filter(shown)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => row(c, true)),
  ];
  const row = (t: Thread, child = false) => (
    <div key={t.id} className={`thr-row${t.pinned ? " pinned" : ""}${child ? " child" : ""}`}>
      <button
        className={`thr${t.id === props.activeThreadId ? " on" : ""}`}
        onClick={() => props.onOpenThread(t.id)}
      >
        <span className="t">{t.title}</span>
        <ThreadStatus thread={t} />
      </button>
      {!t.archived && (
        <button
          className="pin"
          aria-pressed={!!t.pinned}
          aria-label={t.pinned ? `Désépingler ${t.title}` : `Épingler ${t.title}`}
          title={t.pinned ? "Désépingler" : "Épingler"}
          onClick={() => props.onTogglePin(t.id, !t.pinned)}
        >
          <IconPin filled={!!t.pinned} />
        </button>
      )}
    </div>
  );

  return (
    <aside className="side">
      <div className="side-top">
        <Wordmark />
      </div>
      <nav className="nav">
        <button className={!props.activeThreadId ? "on" : ""} onClick={props.onNewThread}>
          <IconCompose />
          Nouvelle discussion
        </button>
        <button onClick={props.onNewProject}>
          <IconFolder />
          Nouveau projet
        </button>
        <button onClick={props.onOpenRequests}>
          <IconInbox />À traiter
          {state.requests.length > 0 && <span className="aux badge">{state.requests.length}</span>}
        </button>
        <button onClick={props.onOpenConnections}>
          <IconPlug />
          Connexions
        </button>
      </nav>
      <div className="side-scroll">
        <div className="sec-h">Projets</div>
        {state.ready && state.projects.length === 0 && (
          <div className="empty-note">Aucun projet pour l'instant.</div>
        )}
        {state.projects.map((p) => (
          <div key={p.id} className="thr-row proj">
            <button
              className={`thr${!props.activeThreadId && p.id === props.activeProjectId ? " on" : ""}`}
              title={p.path}
              onClick={() => props.onPickProject(p.id)}
            >
              <IconFolder />
              <span className="t">{p.name}</span>
              <span className="aux">{countByProject.get(p.id) ?? ""}</span>
            </button>
            <button
              className="pin"
              aria-label={`Retirer le projet ${p.name}`}
              title="Retirer de MoonAgentic"
              onClick={() => props.onRemoveProject(p.id)}
            >
              <IconClose />
            </button>
          </div>
        ))}
        {pinned.length > 0 && <div className="sec-h">Épinglés</div>}
        {pinned.flatMap(tree)}
        {recent.length > 0 && <div className="sec-h">Récents</div>}
        {recent.flatMap(tree)}
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
        {showArchived && archived.map((t) => row(t))}
      </div>
      <div className="side-foot">
        {state.status === "open" ? (
          <button className={`st ${available ? "ok" : "warn"}`} onClick={props.onOpenConnections}>
            {available} {available > 1 ? "agents prêts" : "agent prêt"}
          </button>
        ) : (
          <span className="st warn">Reconnexion au serveur…</span>
        )}
      </div>
    </aside>
  );
}
