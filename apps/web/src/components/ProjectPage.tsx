import type { AgentInfo, Project, Thread, ThreadGroup } from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { readPref, writePref } from "../prefs.ts";
import {
  checksLabel,
  FOLDED_BY_DEFAULT,
  GROUP_LABEL,
  groupThreads,
  shortAgo,
  threadLine,
} from "../project-threads.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconChevron, IconPlus } from "./icons.tsx";
import { PrChip } from "./PullRequestStatus.tsx";
import { ThreadMenu } from "./ThreadMenu.tsx";

/** The groups the user folded or unfolded, as they left them. */
const readFolds = (): Partial<Record<ThreadGroup, boolean>> => {
  try {
    return JSON.parse(readPref("threadGroups") ?? "{}") as Partial<Record<ThreadGroup, boolean>>;
  } catch {
    return {};
  }
};

/**
 * A project's page: its conversations grouped by what is really going on, those waiting
 * on the user first. Every line comes from the thread's own state, its team's and its
 * pull request's.
 */
export function ProjectPage(props: {
  project: Project;
  threads: Thread[];
  agents: AgentInfo[];
  ready: boolean;
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onSetResolved: (id: string, resolved: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
  onOpenPlanner: () => void;
  onRemoveProject: () => void;
}) {
  // The name being typed, while the project is renamed in place.
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = () => {
    const name = renaming?.trim();
    if (name && name !== props.project.name) {
      connection.send({ type: "project.rename", projectId: props.project.id, name });
    }
    setRenaming(null);
  };
  const [folds, setFolds] = useState(readFolds);
  // The times on the lines move on by themselves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const groups = groupThreads(props.threads, props.project.id);
  const total = groups.reduce((n, g) => n + g.threads.length, 0);
  const members = (leadId: string) => props.threads.filter((t) => t.parentId === leadId).length;

  return (
    <div className="view">
      <div className="proj-page">
        <div className="pp-head">
          <div>
            {renaming === null ? (
              <h1 className="pp-title">{props.project.name}</h1>
            ) : (
              <input
                className="pp-title pp-rename"
                aria-label="Nom du projet"
                value={renaming}
                maxLength={120}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            )}
            <div className="pp-path" title={props.project.path}>
              {props.project.path}
            </div>
          </div>
          <div className="pp-acts">
            <button className="btn sm" onClick={props.onNewThread}>
              <IconPlus size={13} />
              Fil
            </button>
            <ThreadMenu
              label="Actions du projet"
              actions={[
                {
                  label: "Ouvrir dans une nouvelle fenêtre",
                  run: () => window.open(location.href, "_blank", "noopener"),
                },
                { label: "Renommer", run: () => setRenaming(props.project.name) },
                { label: "Planner du projet", run: props.onOpenPlanner },
                { label: "Retirer de MoonAgentic…", danger: true, run: props.onRemoveProject },
              ]}
            />
          </div>
        </div>
        {props.ready && total === 0 && (
          <p className="pp-empty">
            Aucune discussion dans ce projet. Écris ci-dessous pour ouvrir la première.
          </p>
        )}
        {groups.map(({ group, threads }) => {
          if (!threads.length) return null;
          const open = folds[group] ?? !FOLDED_BY_DEFAULT.has(group);
          return (
            <section key={group} className="pp-group" data-group={group}>
              <button
                className={`pp-gh${open ? " open" : ""}`}
                aria-expanded={open}
                onClick={() => {
                  const next = { ...folds, [group]: !open };
                  setFolds(next);
                  writePref("threadGroups", JSON.stringify(next));
                }}
              >
                <span>{GROUP_LABEL[group]}</span>
                <span className="n">{threads.length}</span>
                <IconChevron size={11} />
              </button>
              {open &&
                threads.map((t) => {
                  const line = threadLine(t);
                  const team = members(t.id);
                  const checks = t.pr ? checksLabel(t.pr) : "";
                  return (
                    <div key={t.id} className="pp-row" data-group={group}>
                      <span className="pp-state" data-status={t.status} aria-hidden />
                      <button className="pp-open" onClick={() => props.onOpenThread(t.id)}>
                        <span className="pp-t">{t.title}</span>
                        {line && <span className="pp-line">{line}</span>}
                      </button>
                      <span className="pp-when">{shortAgo(t.updatedAt, now)}</span>
                      <ThreadMenu
                        label={`Actions de ${t.title}`}
                        actions={[
                          ...(t.archived
                            ? []
                            : [
                                {
                                  label: t.pinned ? "Désépingler" : "Épingler",
                                  run: () => props.onTogglePin(t.id, !t.pinned),
                                },
                              ]),
                          {
                            label: t.archived ? "Rouvrir" : "Marquer résolu",
                            run: () => props.onSetResolved(t.id, !t.archived),
                          },
                          {
                            label: "Supprimer…",
                            danger: true,
                            run: () => props.onDeleteThread(t),
                          },
                        ]}
                      />
                      <div className="pp-chips">
                        {t.pr && <PrChip pr={t.pr} />}
                        {checks && (
                          <span className="pp-checks" data-checks={t.pr?.checks}>
                            {checks}
                          </span>
                        )}
                        <span className="pp-agent">
                          <AgentBadge agent={props.agents.find((a) => a.id === t.agentId)} small />
                          {team > 0 ? `Équipe de ${team}` : (t.model ?? "")}
                        </span>
                        {t.workspace?.base && (
                          <span className="pp-branch">{t.workspace.branch}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
