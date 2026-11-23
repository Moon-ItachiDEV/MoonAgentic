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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { readPref, writePref } from "../prefs.ts";
import type { PlannerView } from "../router.ts";
import { IconClose, IconFolder, IconPlay } from "./icons.tsx";
import { firstPick, type ModelPick, ModelSelect } from "./ModelSelect.tsx";
import { PlanSchedules } from "./PlanSchedules.tsx";
import { PlanTimeline } from "./PlanTimeline.tsx";

type Filter = "all" | "lead" | "user";
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
  /** Opens the planning of a new task, or of the one given. */
  onSchedule: (schedule?: Schedule) => void;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
  onNewProject: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
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

  if (!project) {
    return (
      <div className="pl">
        <div className="pl-none">
          <p>Le planner range les tâches d'un projet.</p>
          <button className="btn pri" onClick={onNewProject}>
            <IconFolder />
            Nouveau projet
          </button>
        </div>
      </div>
    );
  }

  const cards = plan.filter((c) => c.projectId === project.id);
  const planned = schedules.filter((s) => s.projectId === project.id);
  const shown = cards.filter((c) => filter === "all" || c.source === filter);
  const count = (status: PlanStatus) => cards.filter((c) => c.status === status).length;
  const fromLead = cards.filter((c) => c.source === "lead").length;
  const open = cards.find((c) => c.id === openId);
  const dragged = cards.find((c) => c.id === dragId);
  const now = Date.now();

  const drop = (status: PlanStatus) => {
    if (dragged && dragged.status !== status) void move(dragged, status);
    setDragId(null);
    setOver(null);
  };

  return (
    <div className="pl">
      <div className="pl-top">
        <h1>
          Planner <span className="pl-chip">{project.name}</span>
        </h1>
        {view === "timeline" && (
          <div className="pl-seg pl-zoom" role="group" aria-label="Échelle">
            {(
              [
                ["sem", "Semaines"],
                ["mois", "Mois"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={zoom === key ? "on" : ""}
                aria-pressed={zoom === key}
                onClick={() => {
                  setZoom(key);
                  writePref("plannerZoom", key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="pl-seg" role="tablist" aria-label="Vue">
          {(
            [
              ["tableau", "Tableau"],
              ["timeline", "Timeline"],
              ["planifiees", "Planifiées"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={view === key}
              className={view === key ? "on" : ""}
              onClick={() => {
                // Board or timeline: the one last looked at is where « Planner » opens.
                if (key !== "planifiees") writePref("plannerView", key);
                onView(key === "tableau" ? undefined : key);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="btn pri"
          onClick={() => {
            if (view === "planifiees") return onSchedule();
            // A card is written on the board, where its column is chosen.
            onView(undefined);
            setAdding("todo");
          }}
        >
          {view === "planifiees" ? "Planifier une tâche" : "Ajouter une tâche"}
        </button>
      </div>
      <div className="pl-sum" role="status">
        <span>
          <b>{cards.length}</b> tâche{cards.length > 1 ? "s" : ""}
        </span>
        {PLAN_COLUMNS.filter((c) => c.status !== "todo").map((c) => (
          <span key={c.status} className={`k s-${c.status}`}>
            <i />
            <b>{count(c.status)}</b> {c.label.toLowerCase()}
          </span>
        ))}
      </div>
      <div
        className="pl-filters"
        role="group"
        aria-label="Filtrer les tâches"
        hidden={view === "planifiees"}
      >
        {(
          [
            ["all", "Toutes", cards.length],
            ["lead", "Planifiées par le chef", fromLead],
            ["user", "Ajoutées à la main", cards.length - fromLead],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            className={filter === key ? "on" : ""}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label} <span>{n}</span>
          </button>
        ))}
      </div>
      {view === "timeline" && (
        <PlanTimeline
          cards={shown}
          threads={threads}
          agents={agents}
          zoom={zoom}
          onOpen={setOpenId}
        />
      )}
      {view === "planifiees" && (
        <PlanSchedules
          schedules={planned}
          threads={threads}
          agents={agents}
          onEdit={onSchedule}
          onNew={() => onSchedule()}
          onOpenThread={onOpenThread}
        />
      )}
      <div className="pl-board" hidden={view !== "tableau"}>
        {PLAN_COLUMNS.map((column) => {
          const list = shown.filter((c) => c.status === column.status);
          return (
            <section
              key={column.status}
              className={`pl-col s-${column.status}${over === column.status ? " over" : ""}`}
              aria-label={column.label}
              onDragOver={(e) => {
                if (!dragged) return;
                e.preventDefault();
                setOver(column.status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(column.status);
              }}
            >
              <div className="pl-col-h" title={column.hint}>
                <i />
                {column.label}
                <span>{list.length}</span>
              </div>
              <div className="pl-list">
                {list.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
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
                {list.length === 0 && (
                  <div className="pl-empty">
                    {filter !== "all" ? "Aucune carte avec ce filtre" : "Aucune carte"}
                  </div>
                )}
              </div>
              {adding === column.status ? (
                <QuickAdd
                  projectId={project.id}
                  status={column.status}
                  onClose={() => setAdding(null)}
                />
              ) : (
                <button className="pl-add" onClick={() => setAdding(column.status)}>
                  + Ajouter
                </button>
              )}
            </section>
          );
        })}
      </div>
      {view !== "planifiees" && <PlannerHelp />}
      {open && (
        <Detail
          key={open.id}
          card={open}
          work={cardWork(open, threads, agents)}
          project={project}
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
    </div>
  );
}

function Card({
  card,
  work,
  late,
  dragging,
  free,
  onOpen,
  onRun,
  onDrag,
}: {
  card: PlanTask;
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
  return (
    <article
      className={`pl-card s-${card.status}${dragging ? " drag" : ""}`}
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
      <div className="pl-row">
        <span className="pl-key">#{card.number}</span>
        <span className={`pl-src${card.source === "lead" ? " lead" : ""}`}>
          {card.source === "lead" ? "Chef" : "À la main"}
        </span>
      </div>
      <h3>{card.title}</h3>
      {onRun && (
        <button
          className="pl-run"
          aria-label={`Lancer la tâche ${card.number}`}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          <IconPlay size={11} />
          Lancer
        </button>
      )}
      {(work.agent || work.label || card.due) && (
        <div className="pl-meta">
          {(work.agent || work.label) && (
            <span className={`pl-who t-${work.tone}`}>
              <i />
              {[work.agent, work.label].filter(Boolean).join(" · ")}
            </span>
          )}
          {card.due && card.status !== "live" && (
            <span className={`pl-due${late ? " late" : ""}`}>
              {late ? "en retard · " : ""}
              {dueLabel(card.due)}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function QuickAdd({
  projectId,
  status,
  onClose,
}: {
  projectId: string;
  status: PlanStatus;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const add = () => {
    if (!title.trim()) return;
    void call({ type: "plan.add", requestId: newId(), projectId, title: title.trim(), status });
    setTitle("");
  };
  return (
    <form
      className="pl-quick"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input
        autoFocus
        aria-label={`Nouvelle tâche, ${planLabel(status)}`}
        placeholder="Titre de la tâche"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onBlur={() => !title.trim() && onClose()}
      />
      <small>Entrée pour ajouter, Échap pour fermer</small>
    </form>
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
  const panel = useRef<HTMLElement>(null);
  // Also once the card got its thread: the launch that had the focus is gone, and Escape
  // must still close the panel.
  useEffect(() => {
    panel.current?.focus();
  }, [followed?.id]);
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
  // Closing saves what is being typed: a click outside comes before the field's blur.
  const close = () => {
    saveTitle();
    saveDescription();
    onClose();
  };
  return (
    <div className="pl-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside
        ref={panel}
        className="pl-detail"
        role="dialog"
        aria-modal
        aria-label={`Tâche ${card.number}`}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="pl-detail-h">
          <span className="pl-key">#{card.number}</span>
          <span className={`pl-src${card.source === "lead" ? " lead" : ""}`}>
            {card.source === "lead" ? "Planifiée par le chef" : "Ajoutée à la main"}
          </span>
          <button className="ib" aria-label="Fermer" onClick={close}>
            <IconClose />
          </button>
        </div>
        <div className="pl-detail-b">
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
              onCancel={() => {
                setLaunching(false);
                panel.current?.focus();
              }}
            />
          )}
          <label className="field">
            Titre
            <input
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
          <label className="field">
            Description
            <textarea
              rows={4}
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={saveDescription}
            />
          </label>
          <div className="field">
            État
            <div className="pl-states" role="group" aria-label="État de la tâche">
              {PLAN_COLUMNS.map((c) => (
                <button
                  key={c.status}
                  className={`s-${c.status}${card.status === c.status ? " on" : ""}`}
                  aria-pressed={card.status === c.status}
                  disabled={!!card.team || !!followed}
                  onClick={() => card.status !== c.status && void move(card, c.status)}
                >
                  <i />
                  {c.label}
                </button>
              ))}
            </div>
            {card.team && (
              <small className="pl-note">
                Cette carte suit le travail de l'équipe : son état change avec lui.
              </small>
            )}
            {followed && (
              <small className="pl-note">
                Cette carte suit son fil : elle passe « En test » quand l'agent a fini, et « Livré »
                quand le fil est résolu ou sa pull request fusionnée. Choisis « Aucun » ci-dessous
                pour la déplacer à la main.
              </small>
            )}
          </div>
          <label className="field">
            Début prévu
            <input
              type="date"
              value={dueDay(card.start)}
              onChange={(e) => {
                const start = dayToDue(e.target.value);
                if (start !== null || e.target.value === "") void update({ start });
              }}
            />
          </label>
          <label className="field">
            Échéance
            <input
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
            <label className="field">
              Fil qui s'en occupe
              <select
                value={card.threadId ?? ""}
                onChange={(e) => void update({ threadId: e.target.value || null })}
              >
                <option value="">Aucun</option>
                {threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(work.agent || work.label) && (
            <div className={`pl-who t-${work.tone}`}>
              <i />
              {[work.agent, work.label].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        <div className="pl-detail-f">
          {!card.team && !followed && !launching && (
            <button className="btn pri" onClick={() => setLaunching(true)}>
              <IconPlay size={12} />
              Lancer
            </button>
          )}
          {work.threadId && (
            <button
              className="btn"
              onClick={() => {
                saveTitle();
                saveDescription();
                onOpenThread(work.threadId!);
              }}
            >
              Ouvrir le fil
            </button>
          )}
          <button
            className="btn danger"
            onClick={() => {
              void call({ type: "plan.remove", requestId: newId(), id: card.id });
              onClose();
            }}
          >
            Supprimer
          </button>
        </div>
      </aside>
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
  const favorites = useSyncExternalStore(connection.subscribe, connection.getState).favorites;
  const [pick, setPick] = useState<ModelPick | undefined>(() => firstPick(agents, favorites));
  const agentId = pick?.agentId ?? "";
  const model = pick?.model ?? "";
  const [mode, setMode] = useState<PermissionMode>(() =>
    readPref("permissionMode") === "full" ? "full" : "supervised",
  );
  const [isolated, setIsolated] = useState(() => readPref("isolated") !== "false");
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

  return (
    <form
      ref={form}
      className="pl-launch"
      aria-label={`Lancer la tâche ${card.number}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <p>
        Un nouveau fil de « {project.name} » reçoit le titre et la description de la carte. La carte
        suit ensuite ce fil.
      </p>
      <label className="field">
        Modèle
        <ModelSelect
          label="Modèle"
          agents={agents}
          favorites={favorites}
          value={pick}
          onChange={setPick}
          projectId={project.id}
        />
      </label>
      <label className="field">
        Accès de l'agent
        <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
          <option value="supervised">Il me demande avant d'agir</option>
          <option value="full">Accès complet, sans rien demander</option>
        </select>
      </label>
      {project.git && (
        <label className="pl-check">
          <input
            type="checkbox"
            checked={isolated}
            onChange={(e) => setIsolated(e.target.checked)}
          />
          Branche à part
        </label>
      )}
      {!agents.some((a) => a.available) && (
        <p className="error">Aucun agent n'est prêt : ouvre les Connexions.</p>
      )}
      <div className="pl-launch-f">
        <button type="button" className="btn quiet" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
        <button className="btn pri" disabled={busy || !agentId}>
          {busy ? "Lancement…" : "Lancer la tâche"}
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
