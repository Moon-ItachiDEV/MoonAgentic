import {
  type AgentInfo,
  type Artifact,
  type CoordinatorSettings,
  DEFAULT_PARALLEL,
  MAX_FILE_RESULTS,
  type Favorites,
  type Project,
  type Schedule,
  type Thread,
  type ThreadGroup,
} from "@moonagentic/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileName } from "../artifacts.ts";
import { connection, newId } from "../connection.ts";
import { coordinatorDefault, findModel, isNeonOrchestrator } from "../default-models.ts";
import { baseName, type FileDir, fileTree } from "../file-tree.ts";
import { modelNameOf } from "../model-label.ts";
import { groupThreads, membersByLead, shortAgo, threadLine } from "../project-threads.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { momentLabel, repeatLabel } from "../schedule.ts";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { Glyph, I } from "../v2/I.tsx";
import { useThreadRowMenu } from "../v2/ThreadRowMenu.tsx";
import type { ModelPick } from "../model-pick.ts";

/** The groups, in the words the mockup uses. */
const GROUP_NAME: Record<ThreadGroup, string> = {
  waiting: "T'attend",
  running: "En cours",
  idle: "Inactifs",
  resolved: "Terminés",
};
/** Resolved conversations shown before « Voir plus ». */
const RESOLVED_SHOWN = 5;

interface ThreadActions {
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onSetArchived: (id: string, archived: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
}

/** The times on the lines move on by themselves. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What leads a conversation's line: what it is really doing. */
function Lead({ group, thread }: { group: ThreadGroup; thread: Thread }) {
  if (group === "resolved") return <I n="check" s={18} className="ok" />;
  if (group === "running") return <Glyph />;
  if (group === "waiting")
    return (
      <i
        className={`ud${thread.status === "error" ? " err" : ""}`}
        role="img"
        aria-label="T'attend"
      />
    );
  return <i className="idl" aria-hidden />;
}

/**
 * A project's conversations beside its coordinator, on a wide screen: grouped by what is
 * really going on, those waiting on the user first.
 */
export function ProjectThreads(props: { project: Project; threads: Thread[] } & ThreadActions) {
  const now = useNow();
  const groups = groupThreads(props.threads, props.project.id);
  const members = membersByLead(props.threads);
  const [all, setAll] = useState(false);
  const { bind, menu } = useThreadRowMenu(props.threads, props);
  return (
    <>
      <div className="rph">Fils</div>
      <div className="sbody">
        {groups.map(({ group, threads }) => {
          if (!threads.length) return null;
          const shown = group === "resolved" && !all ? threads.slice(0, RESOLVED_SHOWN) : threads;
          return (
            <div key={group} data-group={group}>
              <div className="gl2">{GROUP_NAME[group]}</div>
              <div className="ins">
                {shown.map((t) => {
                  const line = threadLine(t, members.get(t.id));
                  return (
                    <button
                      key={t.id}
                      className={`it thr${t.unread ? " unread" : ""}`}
                      onClick={() => props.onOpenThread(t.id)}
                      {...bind(t)}
                    >
                      <Lead group={group} thread={t} />
                      <span className="tx">
                        <span className="thn">{t.title}</span>
                        <small
                          className={
                            t.status === "error"
                              ? "mer"
                              : group === "waiting" || group === "running"
                                ? "acc"
                                : ""
                          }
                        >
                          {group === "resolved" || !line
                            ? shortAgo(t.updatedAt, now)
                            : `${line} · ${shortAgo(t.updatedAt, now)}`}
                        </small>
                      </span>
                      <I n="right" s={15} />
                    </button>
                  );
                })}
                {shown.length < threads.length && (
                  <button className="it acc" onClick={() => setAll(true)}>
                    <span className="tx">Voir plus ({threads.length - shown.length})</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button className="newth press" onClick={props.onNewThread}>
          <I n="plus" s={18} />
          Nouveau fil
        </button>
      </div>
      {menu}
    </>
  );
}

/** A folder of the project's tree, folded until pressed. */
function Dir({
  dir,
  open,
  onToggle,
}: {
  dir: FileDir;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {dir.dirs.map((sub) => {
        const isOpen = open.has(sub.path);
        return (
          <div key={sub.path} className={isOpen ? "open" : ""}>
            <button aria-expanded={isOpen} onClick={() => onToggle(sub.path)}>
              <I n="right" s={14} className="cv" />
              <I n="folder" s={19} />
              <span>{sub.name}</span>
            </button>
            {isOpen && (
              <div className="sub">
                <Dir dir={sub} open={open} onToggle={onToggle} />
              </div>
            )}
          </div>
        );
      })}
      {dir.files.map((file) => (
        <div key={file} className="tf">
          <I n="file" s={17} />
          <span className="mono">{baseName(file)}</span>
        </div>
      ))}
    </>
  );
}

/** « Contexte »: the project's folder as it is, and what its coordinator is set to. */
function Context(props: {
  project: Project;
  coordinator: Thread | undefined;
  settings: CoordinatorSettings | undefined;
  agents: AgentInfo[];
  onOpenSettings: () => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    connection
      .ask({
        type: "files.search",
        requestId: newId(),
        projectId: props.project.id,
        query: "",
        limit: MAX_FILE_RESULTS,
      })
      .then(
        (reply) => live && setFiles(reply.files),
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
    };
  }, [props.project.id]);
  const tree = useMemo(() => (files ? fileTree(files) : null), [files]);
  const agent = props.agents.find((a) => a.id === props.coordinator?.agentId);
  return (
    <>
      {props.coordinator && (
        <div className="ins ovins">
          <button className="it" onClick={props.onOpenSettings}>
            <span className="tx">Coordinateur</span>
            <span className="rt">
              {modelNameOf(agent?.models, props.coordinator.model) ?? agent?.name ?? "Agent retiré"}
              <I n="right" s={15} />
            </span>
          </button>
          <div className="it ro">
            <span className="tx">Accès des fils</span>
            <span className="rt">
              {props.coordinator.permissionMode === "full" ? "Complet" : "Supervisé"}
            </span>
          </div>
          <div className="it ro">
            <span className="tx">Fils en même temps</span>
            <span className="rt">{props.settings?.parallel ?? DEFAULT_PARALLEL}</span>
          </div>
        </div>
      )}
      <div className="ovh">
        <span>Dossier</span>
        <span className="mono">{props.project.path}</span>
      </div>
      {error ? (
        <div className="empty">
          <b>{error}</b>
        </div>
      ) : (
        <div className="tree" aria-busy={!tree}>
          {tree && (
            <Dir
              dir={tree}
              open={open}
              onToggle={(path) => {
                const next = new Set(open);
                if (!next.delete(path)) next.add(path);
                setOpen(next);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

type OverviewTab = "fils" | "contexte" | "planif";
const TABS: [OverviewTab, string][] = [
  ["fils", "Fils"],
  ["contexte", "Contexte"],
  ["planif", "Planifiées"],
];

/**
 * « Vue d'ensemble » of a project: its conversations by what is really going on with its
 * artifacts above, its folder and coordinator, its scheduled tasks.
 */
export function ProjectOverview(
  props: {
    project: Project;
    threads: Thread[];
    agents: AgentInfo[];
    schedules: Schedule[];
    coordinator: Thread | undefined;
    settings: CoordinatorSettings | undefined;
    onOpenSettings: () => void;
    onOpenArtifacts: () => void;
    onSchedule: (schedule?: Schedule) => void;
  } & ThreadActions,
) {
  const [tab, setTab] = useState<OverviewTab>("fils");
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const now = useNow();
  const projectId = props.project.id;
  useEffect(() => {
    let live = true;
    connection.ask({ type: "artifacts.list", requestId: newId() }).then(
      (reply) =>
        live &&
        setArtifacts(
          reply.artifacts
            .filter((a) => a.projectId === projectId)
            .sort((a, b) => b.mtime - a.mtime),
        ),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId]);
  const groups = groupThreads(props.threads, projectId);
  const members = membersByLead(props.threads);
  const { bind, menu } = useThreadRowMenu(props.threads, props);
  const schedules = props.schedules.filter((s) => s.projectId === projectId);
  const total = groups.reduce((n, g) => n + g.threads.length, 0);

  const row = (group: ThreadGroup, t: Thread) => {
    const line = threadLine(t, members.get(t.id));
    return (
      <button
        key={t.id}
        className={`trow${t.unread ? " unread" : ""}`}
        data-group={group}
        onClick={() => props.onOpenThread(t.id)}
        {...bind(t)}
      >
        <span className="ld">
          <Lead group={group} thread={t} />
        </span>
        <span className="t">{t.title}</span>
        <span className="tm">{shortAgo(t.updatedAt, now)}</span>
        {line && (
          <span className={`s${t.status === "error" ? " e" : group === "waiting" ? " w" : ""}`}>
            {line}
          </span>
        )}
        {(t.workspace?.base || t.pr) && (
          <span className="chip">
            <I n="branch" s={12} />
            <span>
              {t.pr ? `#${t.pr.number} · ` : ""}
              {t.workspace?.branch ?? ""}
            </span>
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="view" id="view">
      <div className="ovtabs" role="tablist" aria-label="Vue d'ensemble">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "fils" ? (
        <>
          {artifacts.length > 0 && (
            <>
              <button className="ovh" onClick={props.onOpenArtifacts}>
                Artefacts <I n="right" s={13} />
              </button>
              <div className="carou">
                {artifacts.slice(0, 12).map((a) => (
                  <button
                    key={`${a.threadId}:${a.path}`}
                    className="art"
                    onClick={props.onOpenArtifacts}
                  >
                    <span className="thumb ic">
                      <I
                        n={a.kind === "image" ? "image" : a.kind === "html" ? "code" : "file"}
                        s={26}
                      />
                    </span>
                    <b>{fileName(a.path)}</b>
                    <small>{shortAgo(a.mtime, now)}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {groups.map(({ group, threads }) =>
            !threads.length ? null : group === "resolved" ? (
              <div key={group} className="ovg">
                <button
                  className={`more${resolvedOpen ? " op" : ""}`}
                  aria-expanded={resolvedOpen}
                  onClick={() => setResolvedOpen(!resolvedOpen)}
                >
                  Résolus · {threads.length} <I n="right" s={13} />
                </button>
                {resolvedOpen && <div className="reslist">{threads.map((t) => row(group, t))}</div>}
              </div>
            ) : (
              <div key={group} className="ovg">
                <div className="ovh">
                  {GROUP_NAME[group]} · {threads.length}
                </div>
                <div>{threads.map((t) => row(group, t))}</div>
              </div>
            ),
          )}
          {total === 0 && (
            <div className="empty">
              <span className="ei">
                <I n="bubble" s={24} />
              </span>
              <b>Aucun fil</b>
            </div>
          )}
          <button className="newth press" onClick={props.onNewThread}>
            <I n="plus" s={18} />
            Nouveau fil
          </button>
        </>
      ) : tab === "contexte" ? (
        <Context
          project={props.project}
          coordinator={props.coordinator}
          settings={props.settings}
          agents={props.agents}
          onOpenSettings={props.onOpenSettings}
        />
      ) : schedules.length ? (
        <>
          <div className="ins ovins">
            {schedules.map((s) => (
              <button key={s.id} className="it" onClick={() => props.onSchedule(s)}>
                <span className="tx">
                  {s.title}
                  <small className={s.lastError ? "mer" : ""}>
                    {s.lastError ??
                      (s.enabled
                        ? `${momentLabel(s.nextAt, now)} · ${repeatLabel(s)}`
                        : "En pause")}
                  </small>
                </span>
                <I n="right" s={15} />
              </button>
            ))}
          </div>
          <button className="newth press" onClick={() => props.onSchedule()}>
            <I n="plus" s={18} />
            Nouvelle tâche
          </button>
        </>
      ) : (
        <div className="empty">
          <span className="ei">
            <I n="clock" s={24} />
          </span>
          <b>Aucune tâche planifiée pour ce projet</b>
          <button className="newth press" onClick={() => props.onSchedule()}>
            <I n="plus" s={18} />
            Nouvelle tâche
          </button>
        </div>
      )}
      <div className="end" />
      {menu}
    </div>
  );
}

/**
 * A project without a coordinator yet. With Antigravity's Neon orchestrator at hand it starts
 * by itself; otherwise the user picks who coordinates, among their favorite models.
 */
export function CoordinatorStart(props: {
  project: Project;
  agents: AgentInfo[];
  favorites: Favorites;
  ready: boolean;
  onStart: (pick: ModelPick) => Promise<void>;
  onOpenConnections: () => void;
}) {
  const ready = props.agents.filter((a) => a.available);
  const [pick, setPick] = useState<ModelPick>();
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string>();
  const picked =
    pick && ready.some((a) => a.id === pick.agentId)
      ? pick
      : coordinatorDefault(props.agents, props.favorites);
  // The project's composer always speaks to its coordinator: with the Neon orchestrator at
  // hand, the coordinator starts by itself.
  const orchestrator = findModel(props.agents, isNeonOrchestrator);
  const started = useRef<string | null>(null);
  const { onStart } = props;
  useEffect(() => {
    if (!props.ready || !orchestrator || pick) return;
    if (started.current === props.project.id) return;
    started.current = props.project.id;
    onStart(orchestrator).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [onStart, props.ready, orchestrator, pick, props.project.id]);
  // Antigravity's models are only known once asked: asked once, while there is no coordinator.
  const discovered = useRef<string | null>(null);
  useEffect(() => {
    if (!props.ready || discovered.current === props.project.id) return;
    const agy = props.agents.find((a) => a.id === "antigravity");
    if (!agy?.available || agy.models || agy.modelsError) return;
    discovered.current = props.project.id;
    connection.send({ type: "agent.discover", agentId: agy.id, projectId: props.project.id });
  }, [props.ready, props.agents, props.project.id]);

  const { groups, favoritesOnly } = routeChoices(props.agents, props.favorites, picked, all);
  const choices: Choice[] = groups.flatMap((g) =>
    g.options.map((o) => ({ value: o.value, label: o.label, group: g.agent.name })),
  );
  const value = picked ? routeValue(picked.agentId, picked.model) : "";
  return (
    <div className="view" id="view">
      <div className="empty cst">
        {props.ready && !orchestrator && (
          <>
            <span className="ei">
              <I n="branch" s={24} />
            </span>
            <b>Coordinateur du projet</b>
            {picked ? (
              <>
                <div className="ins">
                  <ChoiceRow
                    title="Modèle"
                    label="Modèle du coordinateur"
                    value={value}
                    shown={choices.find((c) => c.value === value)?.label ?? ""}
                    choices={choices}
                    {...(favoritesOnly || all
                      ? {
                          more: {
                            label: all ? "Favoris" : "Tous",
                            on: all,
                            toggle: () => setAll((on) => !on),
                          },
                        }
                      : {})}
                    onPick={(v) => {
                      const to = parseRouteValue(v);
                      if (to) setPick(to);
                    }}
                  />
                </div>
                <button
                  className="newth press"
                  onClick={() => {
                    setError(undefined);
                    props
                      .onStart(picked)
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                >
                  Activer le coordinateur
                </button>
              </>
            ) : (
              <button className="newth press" onClick={props.onOpenConnections}>
                Connecter un agent
              </button>
            )}
          </>
        )}
        {error && (
          <span className="ppill err" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
