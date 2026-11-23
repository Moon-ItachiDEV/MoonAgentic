import {
  DEFAULT_PARALLEL,
  ROUTE_KINDS,
  type AgentInfo,
  type CoordinatorSettings,
  type Project,
  type Thread,
  type ThreadGroup,
} from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection } from "../connection.ts";
import { notificationsOn, projectMuted, setProjectMuted } from "../notifications.ts";
import { syncPush } from "../push.ts";
import { readPref, writePref } from "../prefs.ts";
import {
  checksLabel,
  FOLDED_BY_DEFAULT,
  GROUP_LABEL,
  groupThreads,
  KIND_LABEL,
  membersByLead,
  shortAgo,
  threadLine,
} from "../project-threads.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { BranchCleanup } from "./BranchCleanup.tsx";
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
  /** Locks it with the code: its threads leave every screen until the code is given. */
  onLock: () => void;
  /** Beside the coordinator's conversation: the list alone, without the project's heading. */
  panel?: boolean;
  /** The project's coordinator and what it is set to, shown under « Contexte ». */
  coordinator?: Thread | undefined;
  settings?: CoordinatorSettings | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** Given while the project has no coordinator yet: starts one with this agent. */
  onStartCoordinator?: ((agentId: string) => Promise<void>) | undefined;
}) {
  const ready = props.agents.filter((a) => a.available);
  const [muted, setMuted] = useState(() => projectMuted(props.project.id));
  const [coordAgent, setCoordAgent] = useState<string>();
  const [coordError, setCoordError] = useState<string>();
  const picked = ready.find((a) => a.id === coordAgent) ?? ready[0];
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
  const [cleaning, setCleaning] = useState(false);
  /** Beside the coordinator: the threads, or what the coordinator works with. */
  const [tab, setTab] = useState<"threads" | "context">("threads");
  const context = !!props.panel && tab === "context" && !!props.coordinator;
  const agentName = (id: string) => props.agents.find((a) => a.id === id)?.name ?? "Agent retiré";
  // The times on the lines move on by themselves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const groups = groupThreads(props.threads, props.project.id);
  const total = groups.reduce((n, g) => n + g.threads.length, 0);
  const members = membersByLead(props.threads);

  return (
    <div className={props.panel ? "pp-panel" : "view"}>
      <div className="proj-page">
        <div className="pp-head">
          <div>
            {renaming === null ? (
              props.panel && props.coordinator ? (
                <div className="pp-ptabs" role="tablist" aria-label="Panneau du projet">
                  <button
                    role="tab"
                    aria-selected={tab === "threads"}
                    onClick={() => setTab("threads")}
                  >
                    Fils de discussion
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "context"}
                    onClick={() => setTab("context")}
                  >
                    Contexte
                  </button>
                </div>
              ) : (
                <h1 className="pp-title">{props.project.name}</h1>
              )
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
                {
                  label: props.project.pinned ? "Désépingler" : "Épingler",
                  run: () =>
                    connection.send({
                      type: "project.setPinned",
                      projectId: props.project.id,
                      pinned: !props.project.pinned,
                    }),
                },
                { label: "Renommer", run: () => setRenaming(props.project.name) },
                // Only where this device notifies at all: nothing to cut otherwise.
                ...(notificationsOn()
                  ? [
                      {
                        label: muted
                          ? "Réactiver les notifications du projet"
                          : "Couper les notifications du projet",
                        run: () => {
                          setProjectMuted(props.project.id, !muted);
                          setMuted(!muted);
                          // The server, which sends Web Push, must know it too.
                          syncPush();
                        },
                      },
                    ]
                  : []),
                // Only when something is unread: nothing to mark otherwise.
                ...(props.threads.some((t) => t.projectId === props.project.id && t.unread)
                  ? [
                      {
                        label: "Tout marquer comme lu",
                        run: () =>
                          void connection.send({
                            type: "project.markRead",
                            projectId: props.project.id,
                          }),
                      },
                    ]
                  : []),
                { label: "Planner du projet", run: props.onOpenPlanner },
                // Only a git repository has branches of its threads.
                ...(props.project.git
                  ? [{ label: "Nettoyer les branches…", run: () => setCleaning(true) }]
                  : []),
                { label: "Verrouiller par code", run: props.onLock },
                { label: "Retirer de MoonAgentic…", danger: true, run: props.onRemoveProject },
              ]}
            />
          </div>
        </div>
        {props.onStartCoordinator && props.ready && (
          <div className="pp-coord">
            <div className="pp-coord-t">Coordinateur du projet</div>
            <p>
              Un agent à qui parler de tout le projet : il répond aux questions rapides et ouvre un
              fil sur sa propre branche pour un bug ou une fonctionnalité. Tu peux toujours ouvrir
              un fil toi-même avec « Fil ».
            </p>
            {picked ? (
              <div className="pp-coord-go">
                <select
                  aria-label="Agent du coordinateur"
                  value={picked.id}
                  onChange={(e) => setCoordAgent(e.target.value)}
                >
                  {ready.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm pri"
                  onClick={() => {
                    setCoordError(undefined);
                    props
                      .onStartCoordinator?.(picked.id)
                      .catch((error: unknown) =>
                        setCoordError(error instanceof Error ? error.message : String(error)),
                      );
                  }}
                >
                  Activer le coordinateur
                </button>
              </div>
            ) : (
              <p className="pp-coord-none">Aucun agent n'est prêt : vois « Connexions ».</p>
            )}
            {coordError && (
              <p className="pp-coord-none" role="alert">
                {coordError}
              </p>
            )}
          </div>
        )}
        {context && props.coordinator && (
          <dl className="pp-ctx">
            <dt>Dossier</dt>
            <dd className="mono">{props.project.path}</dd>
            <dt>Dépôt git</dt>
            <dd>
              {props.project.git
                ? "Oui : chaque fil travaille sur sa propre branche."
                : "Non : les fils travaillent dans le dossier lui-même."}
            </dd>
            <dt>Coordinateur</dt>
            <dd>
              {agentName(props.coordinator.agentId)}
              {props.coordinator.model ? ` · ${props.coordinator.model}` : ""}
            </dd>
            <dt>Accès des fils qu'il ouvre</dt>
            <dd>
              {props.coordinator.permissionMode === "full"
                ? "Accès complet : ils agissent sans demander."
                : "Supervisé : ils demandent avant de modifier ou de lancer quoi que ce soit."}
            </dd>
            <dt>Fils en même temps</dt>
            <dd>{props.settings?.parallel ?? DEFAULT_PARALLEL}</dd>
            <dt>Qui fait quoi</dt>
            <dd>
              {ROUTE_KINDS.some((k) => props.settings?.routes[k]) ? (
                <ul className="pp-routes">
                  {ROUTE_KINDS.map((kind) => {
                    const route = props.settings?.routes[kind] ?? props.settings?.routes.default;
                    return (
                      <li key={kind}>
                        <span>{KIND_LABEL[kind]}</span>
                        {route
                          ? `${agentName(route.agentId)}${route.model ? ` · ${route.model}` : ""}`
                          : "L'agent du coordinateur"}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                "Tout va à l'agent du coordinateur."
              )}
            </dd>
            <dt>Équipe</dt>
            <dd>
              {props.settings?.team
                ? "Celle que tu as lancée en dernier sert de modèle."
                : "L'équipe « Équilibrée » par défaut, tant que tu n'en as pas lancé une avec /equipe."}
            </dd>
            {props.onOpenSettings && (
              <dd className="pp-ctx-go">
                <button className="btn sm" onClick={props.onOpenSettings}>
                  Régler le coordinateur
                </button>
              </dd>
            )}
          </dl>
        )}
        {!context && props.ready && total === 0 && (
          <p className="pp-empty">
            {props.panel
              ? "Aucun fil de discussion pour le moment. Demande une tâche et elle s'affichera ici."
              : "Aucune discussion dans ce projet. Écris ci-dessous pour ouvrir la première."}
          </p>
        )}
        {groups.map(({ group, threads }) => {
          if (context || !threads.length) return null;
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
                  const line = threadLine(t, members.get(t.id));
                  const team = members.get(t.id)?.length ?? 0;
                  const checks = t.pr ? checksLabel(t.pr) : "";
                  return (
                    <div
                      key={t.id}
                      className={`pp-row${t.unread ? " unread" : ""}`}
                      data-group={group}
                    >
                      <span className="pp-state" data-status={t.status} aria-hidden />
                      <button className="pp-open" onClick={() => props.onOpenThread(t.id)}>
                        <span className="pp-t">
                          {t.title}
                          {t.unread && (
                            <span className="unread-mark" title="Non lu" aria-label="Non lu" />
                          )}
                        </span>
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
                          ...(t.archived
                            ? []
                            : [
                                {
                                  label: t.unread ? "Marquer comme lu" : "Marquer comme non lu",
                                  run: () =>
                                    void connection.send({
                                      type: "thread.setUnread",
                                      threadId: t.id,
                                      unread: !t.unread,
                                    }),
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
      {cleaning && <BranchCleanup project={props.project} onClose={() => setCleaning(false)} />}
    </div>
  );
}
