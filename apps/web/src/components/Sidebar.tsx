import type { Thread } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { IconCompose, IconFolder } from "./icons.tsx";
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
  onPickProject: (id: string) => void;
  onOpenThread: (id: string) => void;
}) {
  const { state } = props;
  const available = state.agents.filter((a) => a.available).length;
  const countByProject = new Map<string, number>();
  for (const t of state.threads)
    countByProject.set(t.projectId, (countByProject.get(t.projectId) ?? 0) + 1);

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
      </nav>
      <div className="side-scroll">
        <div className="sec-h">Projets</div>
        {state.ready && state.projects.length === 0 && (
          <div className="empty-note">Aucun projet pour l'instant.</div>
        )}
        {state.projects.map((p) => (
          <button
            key={p.id}
            className={`thr${!props.activeThreadId && p.id === props.activeProjectId ? " on" : ""}`}
            title={p.path}
            onClick={() => props.onPickProject(p.id)}
          >
            <IconFolder />
            <span className="t">{p.name}</span>
            <span className="aux">{countByProject.get(p.id) ?? ""}</span>
          </button>
        ))}
        {state.threads.length > 0 && <div className="sec-h">Récents</div>}
        {state.threads.map((t) => (
          <button
            key={t.id}
            className={`thr${t.id === props.activeThreadId ? " on" : ""}`}
            onClick={() => props.onOpenThread(t.id)}
          >
            <span className="t">{t.title}</span>
            <ThreadStatus thread={t} />
          </button>
        ))}
      </div>
      <div className="side-foot">
        {state.status === "open" ? (
          <span className={`st ${available ? "ok" : "warn"}`}>
            {available} {available > 1 ? "agents prêts" : "agent prêt"}
          </span>
        ) : (
          <span className="st warn">Reconnexion au serveur…</span>
        )}
      </div>
    </aside>
  );
}
