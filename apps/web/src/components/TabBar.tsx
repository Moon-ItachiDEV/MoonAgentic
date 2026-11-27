import type { Artifact, Project } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { artifactKey, artifactName, KIND_LABEL } from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import { codeThreads, tabProjects } from "../project-pick.ts";
import { waitingCount } from "../project-threads.ts";
import { seenAgo } from "../remote.ts";
import { lineStatus } from "../sidebar-tree.ts";
import type { State } from "../state.ts";
import { Glyph, I } from "../v2/I.tsx";
import { ProjectIcon } from "./ProjectIcon.tsx";

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
  state: Pick<State, "threads" | "requests" | "projects" | "status">;
  pop: Exclude<TabPop, null>;
  onPickProject: (id: string) => void;
  onNewProject: () => void;
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onOpenArtifacts: () => void;
}) {
  const { state, pop } = props;
  const projects = tabProjects(state.projects);
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
      {pop === "artifacts" && (
        <RecentArtifacts online={state.status === "open"} onOpenArtifacts={props.onOpenArtifacts} />
      )}
    </div>
  );
}

function RecentArtifacts({
  online,
  onOpenArtifacts,
}: {
  /** Asked once the connection is open: an ask before then fails at once. */
  online: boolean;
  onOpenArtifacts: () => void;
}) {
  const [list, setList] = useState<Artifact[] | null>(null);
  useEffect(() => {
    if (!online) return;
    let current = true;
    connection
      .ask({ type: "artifacts.list", requestId: newId() })
      .then((reply) => current && setList(reply.artifacts))
      .catch(() => current && setList([]));
    return () => {
      current = false;
    };
  }, [online]);
  const now = Date.now();
  return (
    <>
      {(list ?? []).slice(0, SHOWN).map((a) => (
        <button key={artifactKey(a)} className="pi2" role="menuitem" onClick={onOpenArtifacts}>
          <I n={a.kind === "pdf" ? "file" : "image"} s={19} />
          <span className="nm">
            {artifactName(a)}
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
