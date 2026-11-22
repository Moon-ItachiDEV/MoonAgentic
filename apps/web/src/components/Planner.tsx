import {
  PLAN_STATUSES,
  type AgentInfo,
  type ClientMessage,
  type PlanStatus,
  type PlanTask,
  type Project,
  type Thread,
} from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import {
  PLAN_COLUMNS,
  cardWork,
  dayToDue,
  dueDay,
  dueLabel,
  isLate,
  planLabel,
} from "../planner.ts";
import { IconClose, IconFolder } from "./icons.tsx";

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
 * A project's planner: its cards by column. The user writes and moves their own cards; a
 * team's cards are laid down by its lead and move only as the team's work really does.
 */
export function Planner({
  project,
  plan,
  threads,
  agents,
  onOpenThread,
  onNewProject,
}: {
  project: Project | undefined;
  plan: PlanTask[];
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
  onNewProject: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<PlanStatus | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<PlanStatus | null>(null);

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
        <button className="btn pri" onClick={() => setAdding("todo")}>
          Ajouter une tâche
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
      <div className="pl-filters" role="group" aria-label="Filtrer les tâches">
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
      <div className="pl-board">
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
                    onOpen={() => setOpenId(card.id)}
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
      <PlannerHelp />
      {open && (
        <Detail
          key={open.id}
          card={open}
          work={cardWork(open, threads, agents)}
          threads={threads.filter((t) => t.projectId === project.id && !t.archived)}
          onOpenThread={onOpenThread}
          onClose={() => setOpenId(null)}
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
  onOpen,
  onDrag,
}: {
  card: PlanTask;
  work: ReturnType<typeof cardWork>;
  late: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDrag: (id: string | null) => void;
}) {
  // A team's card is moved by the team's work, not by hand.
  const free = !card.team;
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
      aria-describedby={free ? "pl-help" : "pl-help-team"}
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
  threads,
  onOpenThread,
  onClose,
}: {
  card: PlanTask;
  work: ReturnType<typeof cardWork>;
  threads: Thread[];
  onOpenThread: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? "");
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
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
  // Team threads are reached through their card; a card links to a thread of its own.
  const linkable = threads.filter((t) => !t.parentId || t.id === card.threadId);

  return (
    <div className="pl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        ref={panel}
        className="pl-detail"
        role="dialog"
        aria-modal
        aria-label={`Tâche ${card.number}`}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="pl-detail-h">
          <span className="pl-key">#{card.number}</span>
          <span className={`pl-src${card.source === "lead" ? " lead" : ""}`}>
            {card.source === "lead" ? "Planifiée par le chef" : "Ajoutée à la main"}
          </span>
          <button className="ib" aria-label="Fermer" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="pl-detail-b">
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
                  disabled={!!card.team}
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
          </div>
          <label className="field">
            Échéance
            <input
              type="date"
              value={dueDay(card.due)}
              onChange={(e) => void update({ due: dayToDue(e.target.value) })}
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
                {linkable.map((t) => (
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
          {work.threadId && (
            <button className="btn" onClick={() => onOpenThread(work.threadId!)}>
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

/** What a screen reader hears of a card's keys. */
const PlannerHelp = () => (
  <>
    <p id="pl-help" className="vh">
      Entrée pour ouvrir. Flèches gauche et droite pour changer de colonne.
    </p>
    <p id="pl-help-team" className="vh">
      Entrée pour ouvrir. L'état de cette carte suit le travail de l'équipe.
    </p>
  </>
);
