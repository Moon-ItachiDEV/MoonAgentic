import type { Artifact, Project, Thread } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { fileName, KIND_LABEL } from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { pinnedFirst, waitingCount } from "../project-threads.ts";
import { seenAgo } from "../remote.ts";
import { lineStatus } from "../sidebar-tree.ts";
import type { State } from "../state.ts";
import { Glyph, I } from "../v2/I.tsx";
import { ProjectIcon } from "./ProjectIcon.tsx";

/**
 * The conversation whose changes the « Code » tab opens: the latest one with its own branch,
 * a conversation of yours before a team member's.
 */
export function codeThread(state: Pick<State, "threads">): Thread | undefined {
  return codeThreads(state)[0];
}

/** The conversations with a branch of their own, the latest first, yours before a team member's. */
export function codeThreads(state: Pick<State, "threads">): Thread[] {
  const withCode = state.threads
    .filter((t) => t.workspace && !t.archived && t.kind !== "coordinator")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const own = withCode.filter((t) => !t.parentId);
  return own.length ? own : withCode;
}

export type TabPop = "projects" | "code" | "artifacts" | null;
const POS = { projects: 1, code: 2, artifacts: 3 } as const;
const SHOWN = 4;

/** The phone's tabs on the home page: « Nouveau », then three lists that open above their tab. */
export function TabBar(props: {
  state: Pick<State, "threads" | "requests" | "projects">;
  pop: TabPop;
  onPop: (pop: TabPop) => void;
}) {
  const { pop } = props;
  const waiting = props.state.requests.length > 0;
  const tab = (id: Exclude<TabPop, null>, icon: "stack" | "tcode" | "copies", label: string) => (
    <button
      className={pop === id ? "on pop" : undefined}
      aria-expanded={pop === id}
      aria-haspopup="menu"
      onClick={() => props.onPop(pop === id ? null : id)}
    >
      <span className="bd">
        <I n={icon} s={24} />
        {id === "projects" && waiting && <i role="img" aria-label="Un agent attend ta réponse" />}
      </span>
      {label}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Sections">
      <button
        className={pop ? undefined : "on"}
        aria-current={pop ? undefined : "page"}
        onClick={() => props.onPop(null)}
      >
        <span className="bd">
          <I n="tbubble" s={24} />
        </span>
        Nouveau
      </button>
      {tab("projects", "stack", "Projets")}
      {tab("code", "tcode", "Code")}
      {tab("artifacts", "copies", "Artefacts")}
    </nav>
  );
}

/** What a tab lists, above it. */
export function TabPopover(props: {
  state: Pick<State, "threads" | "requests" | "projects">;
  pop: Exclude<TabPop, null>;
  onPickProject: (id: string) => void;
  onNewProject: () => void;
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onOpenArtifacts: () => void;
}) {
  const { state, pop } = props;
  const projects = pinnedFirst(state.projects.filter((p) => !isDiscussionsProject(p)));
  const live = state.threads.filter((t) => !t.archived);
  return (
    <div
      className="tpop"
      role="menu"
      aria-label={pop === "projects" ? "Projets" : pop === "code" ? "Code" : "Artefacts"}
      style={{ "--tp": POS[pop] } as React.CSSProperties}
    >
      {pop === "projects" && (
        <>
          {projects.map((p: Project) => (
            <button
              key={p.id}
              className="pi2"
              role="menuitem"
              onClick={() => props.onPickProject(p.id)}
            >
              <ProjectIcon project={p} size={19} />
              <span className="nm">{p.name}</span>
              {p.locked ? (
                <I n="lock" s={15} className="lk" />
              ) : (
                waitingCount(live, p.id) > 0 && (
                  <span className="ud" role="img" aria-label="Un fil t'attend" />
                )
              )}
            </button>
          ))}
          <button className="pi2 add" role="menuitem" onClick={props.onNewProject}>
            <I n="plus" s={19} />
            <span className="nm">Nouveau projet</span>
          </button>
        </>
      )}
      {pop === "code" && (
        <>
          {codeThreads(state)
            .slice(0, SHOWN)
            .map((t) => {
              const status = lineStatus(t);
              return (
                <button
                  key={t.id}
                  className="pi2"
                  role="menuitem"
                  onClick={() => props.onOpenThread(t.id)}
                >
                  {status === "running" || status === "queued" ? (
                    <Glyph />
                  ) : status === "waiting" ? (
                    <span className="ud lead" role="img" aria-label="Attend ta réponse" />
                  ) : (
                    <I n="tcode" s={19} className="lead" />
                  )}
                  <span className="nm">
                    {t.title}
                    <small>
                      {[t.workspace?.branch, state.projects.find((p) => p.id === t.projectId)?.name]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </button>
              );
            })}
          <button className="pi2 add" role="menuitem" onClick={props.onNewThread}>
            <I n="plus" s={19} />
            <span className="nm">Nouvelle session de code</span>
          </button>
        </>
      )}
      {pop === "artifacts" && <RecentArtifacts onOpenArtifacts={props.onOpenArtifacts} />}
    </div>
  );
}

function RecentArtifacts({ onOpenArtifacts }: { onOpenArtifacts: () => void }) {
  const [list, setList] = useState<Artifact[] | null>(null);
  useEffect(() => {
    let current = true;
    connection
      .ask({ type: "artifacts.list", requestId: newId() })
      .then((reply) => current && setList(reply.artifacts))
      .catch(() => current && setList([]));
    return () => {
      current = false;
    };
  }, []);
  const now = Date.now();
  return (
    <>
      {(list ?? []).slice(0, SHOWN).map((a) => (
        <button
          key={`${a.threadId}:${a.path}`}
          className="pi2"
          role="menuitem"
          onClick={onOpenArtifacts}
        >
          <I n={a.kind === "pdf" ? "file" : "image"} s={19} />
          <span className="nm">
            {fileName(a.path)}
            <small>
              {KIND_LABEL[a.kind]} · {seenAgo(a.mtime, now)}
            </small>
          </span>
        </button>
      ))}
      <button className="pi2 add" role="menuitem" onClick={onOpenArtifacts}>
        <I n="copies" s={19} />
        <span className="nm">Tous les artefacts</span>
      </button>
    </>
  );
}
