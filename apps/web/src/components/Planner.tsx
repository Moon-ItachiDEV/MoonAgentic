import {
  PLAN_STATUSES,
  type AgentInfo,
  type ClientMessage,
  type PermissionMode,
  type PlanStatus,
  type PlanTask,
  type Project,
  type Schedule,
  type Thread,
} from "@moonagentic/protocol";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import {
  PLAN_COLUMNS,
  canRun,
  cardWork,
  dayToDue,
  dueDay,
  dueLabel,
  followedThread,
  isLate,
  linkableThreads,
  planLabel,
} from "../planner.ts";
import { useDefaults } from "../defaults.ts";
import { readPref, writePref } from "../prefs.ts";
import type { PlannerView } from "../router.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { Fab } from "../v2/Fab.tsx";
import { Glyph, I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { firstPick, type ModelPick } from "../model-pick.ts";
import { PlanSchedules } from "./PlanSchedules.tsx";
import { PlanTimeline } from "./PlanTimeline.tsx";

type Filter = "all" | "lead" | "hermes" | "user";
type PlanRequest = Extract<ClientMessage, { type: `plan.${string}` }>;

/** Sends a change to the server; a refusal is shown rather than lost. */
const call = (message: PlanRequest) =>
  connection
    .request(message)
    .catch((error: unknown) =>
      connection.notify(error instanceof Error ? error.message : String(error)),
    );

const move = (card: PlanTask, status: PlanStatus) =>
  call({ type: "plan.update", requestId: newId(), id: card.id, status });

/**
 * A project's planner: its cards by column. The user writes and moves their own cards, and
 * starts one's work in a new thread; from then on the card moves only as that thread really
 * does. A team's cards are laid down by its lead and move with the team's work.
 */
export function Planner({
  project,
  view: asked,
  onView,
  plan,
  threads,
  agents,
  schedules,
  projects,
  onSchedule,
  onOpenThread,
  onNewProject,
}: {
  project: Project | undefined;
  /** The view its address names; the board when none. */
  view: PlannerView | undefined;
  /** Goes to a view's address. */
  onView: (view: PlannerView | undefined) => void;
  plan: PlanTask[];
  /** The tasks planned for later, of every project. */
  schedules: Schedule[];
  /** Every project open to the user: the planned tasks are listed for all of them. */
  projects: Project[];
  /** Opens the planning of a new task, or of the one given. */
  onSchedule: (schedule?: Schedule) => void;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
  onNewProject: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  // The board holds every project's cards, as the mockup's does; one project alone on demand.
  const [scope, setScope] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  // The card whose detail opened on its launch, from « Lancer » on the board.
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [adding, setAdding] = useState<PlanStatus | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<PlanStatus | null>(null);
  const view = asked ?? "tableau";
  // The timeline's scale is this device's own choice.
  const [zoom, setZoom] = useState<"sem" | "mois">(() =>
    readPref("plannerZoom") === "sem" ? "sem" : "mois",
  );
  // On a phone one column shows at a time: the one in sight, by its tab.
  const [column, setColumn] = useState(1);
  const board = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const columnOf = (index: number) => board.current?.children[index] as HTMLElement | undefined;
  useLayoutEffect(() => {
    const el = board.current;
    const first = columnOf(1);
    // Opens on « En cours », as the mockup does: what moves is what is looked at first.
    if (el && first && el.scrollWidth > el.clientWidth) el.scrollLeft = first.offsetLeft - 20;
  }, [view, project?.id]);

  if (view === "planifiees") {
    return (
      <PlanSchedules
        schedules={schedules}
        projects={projects}
        threads={threads}
        agents={agents}
        onEdit={onSchedule}
        onNew={projects.length > 0 ? () => onSchedule() : undefined}
        onOpenThread={onOpenThread}
      />
    );
  }

  if (!project) {
    return (
      <div className="view" id="view">
        <div className="empty">
          <span className="ei">
            <I n="grid" s={24} />
          </span>
          <b>Le planner range les tâches d'un projet</b>
          <button className="newth press" onClick={onNewProject}>
            <I n="plus" s={18} />
            Nouveau projet
          </button>
        </div>
      </div>
    );
  }

  const projectOf = (card: PlanTask) => projects.find((p) => p.id === card.projectId);
  const everyCard = plan.filter((c) => projectOf(c));
  const withCards = projects.filter((p) => everyCard.some((c) => c.projectId === p.id));
  // A project whose last card left is no longer a choice: back to all of them.
  const inScope = scope !== "all" && withCards.some((p) => p.id === scope) ? scope : "all";
  const cards = everyCard.filter((c) => inScope === "all" || c.projectId === inScope);
  const shown = cards.filter((c) => filter === "all" || c.source === filter);
  const fromLead = cards.filter((c) => c.source === "lead").length;
  const fromHermes = cards.filter((c) => c.source === "hermes").length;
  const sorted = fromLead + fromHermes > 0;
  const open = cards.find((c) => c.id === openId);
  const dragged = cards.find((c) => c.id === dragId);
  const now = Date.now();

  const drop = (status: PlanStatus) => {
    if (dragged && dragged.status !== status) void move(dragged, status);
    setDragId(null);
    setOver(null);
  };

  return (
    <div className="view" id="view">
      <div className="ovtabs" role="tablist" aria-label="Vue">
        {(
          [
            ["tableau", "Tableau"],
            ["timeline", "Timeline"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => {
              // Board or timeline: the one last looked at is where « Planner » opens.
              writePref("plannerView", key);
              onView(key === "tableau" ? undefined : key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {(sorted || withCards.length > 1 || view === "timeline") && (
        <div className="chips plf" role="group" aria-label="Filtrer les tâches">
          {withCards.length > 1 && (
            <>
              <button aria-pressed={inScope === "all"} onClick={() => setScope("all")}>
                Tous les projets
              </button>
              {withCards.map((p) => (
                <button key={p.id} aria-pressed={inScope === p.id} onClick={() => setScope(p.id)}>
                  <i className={`pdot${p.color ? ` pc-${p.color}` : ""}`} />
                  {p.name}
                </button>
              ))}
              {sorted && <span className="sp" />}
            </>
          )}
          {sorted &&
            (
              [
                ["all", "Toutes"],
                ...(fromLead > 0 ? ([["lead", "Planifiées par le chef"]] as const) : []),
                ...(fromHermes > 0 ? ([["hermes", "Planifiées par Hermes"]] as const) : []),
                ["user", "Ajoutées à la main"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          {view === "timeline" && (
            <>
              <span className="sp" />
              {(
                [
                  ["sem", "Semaines"],
                  ["mois", "Mois"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={zoom === key}
                  onClick={() => {
                    setZoom(key);
                    writePref("plannerZoom", key);
                  }}
                >
                  {label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {view === "timeline" ? (
        <PlanTimeline
          cards={shown}
          threads={threads}
          agents={agents}
          zoom={zoom}
          onOpen={setOpenId}
        />
      ) : (
        <>
          <div className="kbtabs" id="kbtabs" ref={tabs}>
            {PLAN_COLUMNS.map((c, i) => (
              <button
                key={c.status}
                aria-pressed={column === i}
                title={c.hint || undefined}
                onClick={() => {
                  const el = board.current;
                  const to = columnOf(i);
                  if (el && to) el.scrollTo({ left: to.offsetLeft - 20, behavior: "smooth" });
                }}
              >
                {c.label}
                <i>{shown.filter((x) => x.status === c.status).length}</i>
              </button>
            ))}
          </div>
          <div
            className="kb"
            id="kb"
            ref={board}
            onScroll={(e) => {
              const el = e.currentTarget;
              const first = columnOf(0);
              if (!first || el.scrollWidth <= el.clientWidth) return;
              const at = Math.max(
                0,
                Math.min(
                  PLAN_COLUMNS.length - 1,
                  Math.round(el.scrollLeft / (first.offsetWidth + 10)),
                ),
              );
              if (at === column) return;
              setColumn(at);
              tabs.current?.children[at]?.scrollIntoView({
                inline: "center",
                block: "nearest",
                behavior: "smooth",
              });
            }}
          >
            {PLAN_COLUMNS.map((c) => {
              const list = shown.filter((x) => x.status === c.status);
              return (
                <section
                  key={c.status}
                  className={`kbc${over === c.status ? " over" : ""}`}
                  aria-label={c.label}
                  onDragOver={(e) => {
                    if (!dragged) return;
                    e.preventDefault();
                    setOver(c.status);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(c.status);
                  }}
                >
                  {list.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      project={projectOf(card) ?? project}
                      work={cardWork(card, threads, agents)}
                      late={isLate(card, now)}
                      dragging={card.id === dragId}
                      free={!card.team && !followedThread(card, threads)}
                      onOpen={() => setOpenId(card.id)}
                      onRun={
                        card.status === "todo" && canRun(card, threads)
                          ? () => {
                              setLaunchId(card.id);
                              setOpenId(card.id);
                            }
                          : undefined
                      }
                      onDrag={setDragId}
                    />
                  ))}
                  {list.length === 0 && <p className="kbe">Aucune carte</p>}
                  <button
                    className="kba"
                    aria-label={`Ajouter une tâche, ${c.label}`}
                    onClick={() => setAdding(c.status)}
                  >
                    <I n="plus" s={16} />
                  </button>
                </section>
              );
            })}
          </div>
        </>
      )}
      <div className="end" />
      <Fab>
        <button
          className="newd press"
          onClick={() => {
            // A card is written on the board, in the column in sight.
            if (view !== "tableau") onView(undefined);
            const el = board.current;
            // Where every column shows at once, a new card starts in the first one.
            const paged = !!el && el.scrollWidth > el.clientWidth;
            setAdding((paged && PLAN_COLUMNS[column]?.status) || "todo");
          }}
        >
          <I n="plus" s={20} />
          Ajouter une tâche
        </button>
      </Fab>
      <PlannerHelp />
      <QuickAdd
        projects={projects}
        projectId={inScope === "all" ? project.id : inScope}
        status={adding}
        onClose={() => setAdding(null)}
      />
      <Sheet
        open={!!open}
        onClose={() => {
          setOpenId(null);
          setLaunchId(null);
        }}
        title={open ? `Tâche #${open.number}` : "Tâche"}
        tall
        className="pld"
      >
        {open && (
          <Detail
            key={open.id}
            card={open}
            work={cardWork(open, threads, agents)}
            project={projectOf(open) ?? project}
            agents={agents}
            followed={followedThread(open, threads)}
            launch={launchId === open.id}
            threads={linkableThreads(open, threads)}
            onOpenThread={onOpenThread}
            onClose={() => {
              setOpenId(null);
              setLaunchId(null);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function Card({
  card,
  project,
  work,
  late,
  dragging,
  free,
  onOpen,
  onRun,
  onDrag,
}: {
  card: PlanTask;
  project: Project;
  work: ReturnType<typeof cardWork>;
  late: boolean;
  dragging: boolean;
  /** Moved by hand: a card a thread or a team works on is moved by that work. */
  free: boolean;
  onOpen: () => void;
  /** Opens the card on its launch, when its work can be started. */
  onRun: (() => void) | undefined;
  onDrag: (id: string | null) => void;
}) {
  const step = (by: -1 | 1) => {
    const next = PLAN_STATUSES[PLAN_STATUSES.indexOf(card.status) + by];
    if (free && next) void move(card, next);
  };
  const doing = [work.agent, work.label].filter(Boolean).join(" · ");
  return (
    <article
      className={`pc press${card.status === "live" ? " done" : ""}${dragging ? " drag" : ""}`}
      role="button"
      tabIndex={0}
      draggable={free}
      aria-label={`Tâche ${card.number} : ${card.title}, ${planLabel(card.status)}`}
      aria-describedby={free ? "pl-help" : card.team ? "pl-help-team" : "pl-help-thread"}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        } else if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.title);
        onDrag(card.id);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <span className="pct">
        {work.tone === "live" && <Glyph />}
        {card.title}
      </span>
      <span className="pcm">
        <i className={`pdot${project.color ? ` pc-${project.color}` : ""}`} />
        {project.name}
        <span className="dotsep" />#{card.number}
        {card.due && card.status !== "live" && !late && (
          <>
            <span className="dotsep" />
            {dueLabel(card.due)}
          </>
        )}
      </span>
      {doing && <span className={`pcw t-${work.tone}`}>{doing}</span>}
      {late && card.due && card.status !== "live" && (
        <span className="pcl">en retard · {dueLabel(card.due)}</span>
      )}
      {card.source === "lead" && <span className="pco">Planifiée par le chef</span>}
      {card.source === "hermes" && <span className="pco">Planifiée par Hermes</span>}
      {onRun && (
        <button
          className="mini press"
          aria-label={`Lancer la tâche ${card.number}`}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          Lancer
        </button>
      )}
    </article>
  );
}

/** A new card: its title, and the column it starts in. */
function QuickAdd({
  projects,
  projectId: first,
  status,
  onClose,
}: {
  projects: Project[];
  /** The project it opens on: the one in sight. */
  projectId: string;
  /** The column asked for; nothing while the sheet is closed. */
  status: PlanStatus | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<PlanStatus>("todo");
  const [projectId, setProjectId] = useState(first);
  useEffect(() => {
    if (!status) return;
    setPicked(status);
    setProjectId(first);
  }, [status, first]);
  const add = () => {
    if (!title.trim()) return;
    void call({
      type: "plan.add",
      requestId: newId(),
      projectId,
      title: title.trim(),
      status: picked,
    });
    setTitle("");
    onClose();
  };
  return (
    <Sheet open={status !== null} onClose={onClose} title="Ajouter une tâche">
      <form
        className="sbody"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="fld">
          <input
            // Focused when the sheet opens, where the keyboard is wanted at once.
            ref={(el) => {
              if (el && status !== null && document.activeElement !== el) el.focus();
            }}
            aria-label={`Nouvelle tâche, ${planLabel(picked)}`}
            placeholder="Titre de la tâche"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="chips wrap" role="radiogroup" aria-label="Colonne">
          {PLAN_COLUMNS.map((c) => (
            <button
              key={c.status}
              type="button"
              role="radio"
              aria-checked={picked === c.status}
              aria-pressed={picked === c.status}
              onClick={() => setPicked(c.status)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {projects.length > 1 && (
          <div className="ins">
            <ChoiceRow
              title="Projet"
              value={projectId}
              shown={projects.find((p) => p.id === projectId)?.name ?? ""}
              choices={projects.map((p) => ({ value: p.id, label: p.name }))}
              onPick={setProjectId}
            />
          </div>
        )}
        <div className="mga">
          <button className="b2 ink press" disabled={!title.trim()}>
            Ajouter
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function Detail({
  card,
  work,
  project,
  agents,
  followed,
  launch,
  threads,
  onOpenThread,
  onClose,
}: {
  card: PlanTask;
  work: ReturnType<typeof cardWork>;
  project: Project;
  agents: AgentInfo[];
  /** The thread the card follows: its state is then that thread's. */
  followed: Thread | undefined;
  /** Opened from « Lancer »: the launch is shown at once. */
  launch: boolean;
  threads: Thread[];
  onOpenThread: (id: string) => void;
  onClose: () => void;
}) {
  const [launching, setLaunching] = useState(launch);
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? "");
  // What another device writes shows here too, unless this one is being typed over.
  const known = useRef({ title: card.title, description: card.description ?? "" });
  useEffect(() => {
    const next = { title: card.title, description: card.description ?? "" };
    // Read now: React may run these later, once « known » already holds what came.
    const before = known.current;
    setTitle((t) => (t === before.title ? next.title : t));
    setDescription((d) => (d === before.description ? next.description : d));
    known.current = next;
  }, [card.title, card.description]);
  const update = (
    patch: Omit<Extract<PlanRequest, { type: "plan.update" }>, "type" | "requestId" | "id">,
  ) => call({ type: "plan.update", requestId: newId(), id: card.id, ...patch });
  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(card.title);
    else if (next !== card.title) void update({ title: next });
  };
  const saveDescription = () => {
    const next = description.trim();
    if (next !== (card.description ?? "")) void update({ description: next || null });
  };
  // Leaving saves what is being typed: the sheet closes before the field's blur.
  const latest = useRef({ saveTitle, saveDescription });
  latest.current = { saveTitle, saveDescription };
  useEffect(
    () => () => {
      latest.current.saveTitle();
      latest.current.saveDescription();
    },
    [],
  );
  const doing = [work.agent, work.label].filter(Boolean).join(" · ");
  const linked: Choice[] = [
    { value: "", label: "Aucun" },
    ...threads.map((t) => ({ value: t.id, label: t.title })),
  ];
  return (
    <div className="sbody">
      {launching && !card.team && !followed && (
        <Launch
          card={card}
          project={project}
          agents={agents}
          // What is being typed is what the agent is told.
          before={() => {
            saveTitle();
            saveDescription();
          }}
          onCancel={() => setLaunching(false)}
        />
      )}
      <div className="gl2">Titre</div>
      <label className="fld">
        <input
          aria-label="Titre"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      <div className="gl2">Description</div>
      <label className="fld ta">
        <textarea
          aria-label="Description"
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
        />
      </label>
      <div className="gl2">État</div>
      <div className="chips wrap plst" role="group" aria-label="État de la tâche">
        {PLAN_COLUMNS.map((c) => (
          <button
            key={c.status}
            aria-pressed={card.status === c.status}
            disabled={!!card.team || !!followed}
            onClick={() => card.status !== c.status && void move(card, c.status)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="ins">
        {(card.team || followed) && (
          <div className="it ro">
            <span className="tx">{card.team ? "Suit le travail de l'équipe" : "Suit son fil"}</span>
            {doing && <span className={`rt${work.tone === "err" ? " mer" : ""}`}>{doing}</span>}
          </div>
        )}
        <label className="it ro">
          <span className="tx">Début prévu</span>
          <input
            className="dte"
            type="date"
            value={dueDay(card.start)}
            onChange={(e) => {
              const start = dayToDue(e.target.value);
              if (start !== null || e.target.value === "") void update({ start });
            }}
          />
        </label>
        <label className="it ro">
          <span className="tx">Échéance</span>
          <input
            className="dte"
            type="date"
            value={dueDay(card.due)}
            onChange={(e) => {
              // A day still being typed is not sent; an emptied field clears it.
              const due = dayToDue(e.target.value);
              if (due !== null || e.target.value === "") void update({ due });
            }}
          />
        </label>
        {!card.team && (
          <ChoiceRow
            title="Fil qui s'en occupe"
            value={card.threadId ?? ""}
            shown={linked.find((c) => c.value === (card.threadId ?? ""))?.label ?? "Aucun"}
            choices={linked}
            onPick={(value) => void update({ threadId: value || null })}
          />
        )}
      </div>
      <div className="ins">
        {!card.team && !followed && !launching && (
          <button className="it acc" onClick={() => setLaunching(true)}>
            <I n="play" s={17} />
            <span className="tx">Lancer</span>
          </button>
        )}
        {work.threadId && (
          <button
            className="it acc"
            onClick={() => {
              saveTitle();
              saveDescription();
              onOpenThread(work.threadId!);
            }}
          >
            <span className="tx">Ouvrir le fil</span>
          </button>
        )}
        <button
          className="it dng"
          onClick={() => {
            void call({ type: "plan.remove", requestId: newId(), id: card.id });
            onClose();
          }}
        >
          <span className="tx">Supprimer</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Starts a card's work: a new thread of the project gets the card's title and description,
 * with the agent chosen here. The card then follows that thread.
 */
function Launch({
  card,
  project,
  agents,
  before,
  onCancel,
}: {
  card: PlanTask;
  project: Project;
  agents: AgentInfo[];
  before: () => void;
  onCancel: () => void;
}) {
  const favorites = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().favorites,
  );
  const [pick, setPick] = useState<ModelPick | undefined>(() => firstPick(agents, favorites));
  const agentId = pick?.agentId ?? "";
  const model = pick?.model ?? "";
  // Starts as the defaults say; a change here is for this card only.
  const defaults = useDefaults();
  const [mode, setMode] = useState<PermissionMode>(defaults.permissionMode);
  const [isolated, setIsolated] = useState(defaults.isolated);
  const [busy, setBusy] = useState(false);
  // Asked for from the foot of a long card: it comes into sight.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // In braces: a recent browser answers a scroll with a promise, which is no clean-up.
    form.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const run = async () => {
    if (!agentId || busy) return;
    setBusy(true);
    before();
    try {
      await connection.request({
        type: "plan.run",
        requestId: newId(),
        id: card.id,
        agentId,
        permissionMode: mode,
        ...(model ? { model } : {}),
        ...(project.git ? { isolated } : {}),
      });
      // The card now has its thread: this form goes with what made it possible.
    } catch (error) {
      connection.notify(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const [all, setAll] = useState(false);
  const { groups, favoritesOnly } = routeChoices(agents, favorites, pick, all);
  const models: Choice[] = groups.flatMap((g) =>
    g.options.map((o) => ({ value: o.value, label: o.label, group: g.agent.name })),
  );
  const value = pick ? routeValue(pick.agentId, pick.model) : "";

  return (
    <form
      ref={form}
      className="pll"
      aria-label={`Lancer la tâche ${card.number}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <div className="ins">
        <ChoiceRow
          title="Modèle"
          value={value}
          shown={
            models.find((c) => c.value === value)?.label ??
            (agents.some((a) => a.available) ? "" : "Aucun agent prêt")
          }
          choices={models}
          {...(favoritesOnly || all
            ? {
                more: {
                  label: all ? "Favoris" : "Tous",
                  on: all,
                  toggle: () => setAll((on) => !on),
                },
              }
            : {})}
          onPick={(v) => setPick(parseRouteValue(v))}
        />
        <div className="it ro col">
          <span className="tx">Accès</span>
          <div className="seg three" role="radiogroup" aria-label="Accès de la tâche">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "supervised"}
              aria-pressed={mode === "supervised"}
              onClick={() => setMode("supervised")}
            >
              <I n="hand" s={15} />
              Me demander
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "edits"}
              aria-pressed={mode === "edits"}
              title="Modifie les fichiers du fil sans demander ; les commandes demandent encore"
              onClick={() => setMode("edits")}
            >
              <I n="edit" s={15} />
              Éditions auto
            </button>
            <button
              type="button"
              role="radio"
              className="f"
              aria-checked={mode === "full"}
              aria-pressed={mode === "full"}
              onClick={() => setMode("full")}
            >
              <I n="bolt" s={15} />
              Accès complet
            </button>
          </div>
        </div>
        {project.git && (
          <div className="it ro">
            <span className="tx">Branche à part</span>
            <button
              type="button"
              className="tog"
              role="switch"
              aria-checked={isolated}
              aria-label="Branche à part"
              onClick={() => setIsolated(!isolated)}
            />
          </div>
        )}
      </div>
      <div className="cfa">
        <button className="b2 ink press" disabled={busy || !agentId}>
          {busy ? "Lancement…" : "Lancer la tâche"}
        </button>
        <button type="button" className="b2 soft press" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

/** What a screen reader hears of a card's keys. */
const PlannerHelp = () => (
  <>
    <p id="pl-help" className="vh">
      Entrée pour ouvrir. Flèches gauche et droite pour changer de colonne.
    </p>
    <p id="pl-help-team" className="vh">
      Entrée pour ouvrir. L'état de cette carte suit le travail de l'équipe.
    </p>
    <p id="pl-help-thread" className="vh">
      Entrée pour ouvrir. L'état de cette carte suit son fil.
    </p>
  </>
);
