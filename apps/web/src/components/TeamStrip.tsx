import type { AgentInfo, Team, TeamLanePhase, Thread } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modelNameOf } from "../model-label.ts";
import { TeamTree } from "./TeamTree.tsx";

const LEAD_LANE = -1;
const MERGE_LANE = -2;
/** Lanes for roles that have no piece to work on yet, while the lead plans. */
const QUEUED_REVIEW = -3;
const QUEUED_TEST = -4;

const active = (team: Team) =>
  team.phase === "planning" || team.phase === "coding" || team.phase === "merging";

/** Phases during which an agent of the lane is at work. */
const WORKING = new Set<TeamLanePhase>([
  "planning",
  "lead",
  "running",
  "reviewing",
  "testing",
  "merging",
  "solving",
  "checking",
]);

/** Under this width the tree has no room in the strip: it takes the whole centre instead. */
const TREE_MIN_WIDTH = 640;
const DESKTOP = "(min-width: 861px)";

/** The colour family of a phase on the track. */
const kind = (phase: TeamLanePhase) =>
  phase === "running"
    ? "code"
    : phase === "reviewing"
      ? "review"
      : phase === "testing"
        ? "test"
        : phase === "planning" || phase === "lead"
          ? "orch"
          : phase === "merging" || phase === "solving" || phase === "checking"
            ? "merge"
            : phase === "blocked"
              ? "wait"
              : phase === "waiting"
                ? "queue"
                : undefined;

const LABEL: Record<TeamLanePhase, string> = {
  planning: "prépare le plan",
  idle: "",
  lead: "revoit une consigne",
  waiting: "en attente",
  running: "code",
  reviewing: "relecture",
  testing: "tests",
  blocked: "à toi de voir",
  done: "terminé",
  failed: "échoué",
  stopped: "arrêté",
  merging: "fusionne",
  solving: "règle un conflit",
  checking: "vérifie l'ensemble",
};

export interface Lane {
  lane: number;
  who: string;
  /** The agent and model, when known. */
  sub: string;
  /** The thread to open from the row. */
  open: string | undefined;
  /** The thread working for the lane at its current phase. */
  live: string | undefined;
  /** A role still to come: what it waits on, as the team was set up. */
  after?: string;
}

/**
 * The strip's lanes: the lead, each piece (or, while the lead plans, the roles to come) and
 * the merge. Each says its role, then the agent and model at work in it.
 */
export function teamLanes(
  lead: Thread,
  team: Team,
  threads: Thread[],
  agents: AgentInfo[],
): Lane[] {
  const running = active(team);
  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  /** The role, then the agent and model at work in it. */
  const label = (
    role: string,
    member: { agentId: string; model?: string | undefined } | undefined,
  ) => {
    if (!member) return role;
    const agent = agents.find((a) => a.id === member.agentId);
    const model = modelNameOf(agent?.models, member.model);
    return [role, agent?.name ?? member.agentId, model].filter(Boolean).join(" · ");
  };
  const of = (thread: Thread | undefined) =>
    thread ? { agentId: thread.agentId, model: thread.model } : undefined;

  const lastPhase = (lane: number) => team.timeline?.findLast((e) => e.lane === lane)?.phase;

  // Every role is there from the start: those still to come say what they wait on.
  const planning = team.phase === "planning" && !team.tasks.length;
  const merger = team.mergeThreadId || (team.merger && (running || team.phase === "blocked"));
  return [
    { lane: LEAD_LANE, who: "Chef", sub: label("Chef", of(lead)), open: lead.id, live: lead.id },
    ...(!planning
      ? team.tasks.map((task, i): Lane => {
          const phase = lastPhase(i);
          const live =
            phase === "reviewing"
              ? task.reviewThreadId
              : phase === "testing"
                ? task.testThreadId
                : task.threadId;
          const role =
            phase === "reviewing" ? "Relecteur" : phase === "testing" ? "Testeur" : "Codeur";
          // The agent shown is the one at work: the reviewer or tester during their phases.
          return {
            lane: i,
            who: task.title,
            sub: label(role, of(byId(live ?? task.threadId)) ?? team.coder),
            open: live,
            live,
          };
        })
      : [
          {
            lane: 0,
            who: team.coders > 1 ? `${team.coders} codeurs` : "Codeur",
            sub: label("Codeur", team.coder),
            open: undefined,
            live: undefined,
            after: "après le chef",
          },
        ]),
    ...(team.reviewer && planning
      ? [
          {
            lane: QUEUED_REVIEW,
            who: "Relecture",
            sub: label("Relecteur", team.reviewer),
            open: undefined,
            live: undefined,
            after: "après les codeurs",
          },
        ]
      : []),
    ...(team.tester && planning
      ? [
          {
            lane: QUEUED_TEST,
            who: "Tests",
            sub: label("Testeur", team.tester),
            open: undefined,
            live: undefined,
            after: "après la relecture",
          },
        ]
      : []),
    ...(merger
      ? [
          {
            lane: MERGE_LANE,
            who: "Fusion",
            sub: label("Fusionneur", of(byId(team.mergeThreadId)) ?? team.merger),
            open: team.mergeThreadId,
            live: team.mergeThreadId,
            ...(team.mergeThreadId || team.phase === "merging"
              ? {}
              : { after: team.tasks.length > 1 ? "après les sous-tâches" : "après les codeurs" }),
          },
        ]
      : []),
  ];
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

/**
 * The team's timeline, as it really ran: one lane for the lead, one per piece and one for
 * the merge, each drawn from the events the server wrote down when they happened. A lane
 * moves only while its agent's thread is running, and waits in amber while it asks the user.
 */
export function TeamStrip({
  lead,
  team,
  threads,
  agents,
  onOpenThread,
  defaultOpen,
}: {
  lead: Thread;
  team: Team;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The same team, seen as its steps over time or as the tree of its agents.
  const [view, setView] = useState<"steps" | "tree">("steps");
  const [enlarged, setEnlarged] = useState(false);
  const box = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setRoomy(el.clientWidth >= TREE_MIN_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The tree is for a wide screen: a phone keeps the steps.
  const [desktop, setDesktop] = useState(
    () => typeof matchMedia !== "function" || matchMedia(DESKTOP).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(DESKTOP);
    const change = () => setDesktop(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const tree = desktop && open && view === "tree";
  const whole = tree && (enlarged || !roomy);
  const centre = whole ? document.querySelector("main.center") : null;
  // A member's thread opened from the tree is what the user wants to read: the strip, which
  // stays above it, goes back to its steps instead of keeping the tree over the messages.
  const openFromTree = (id: string) => {
    setEnlarged(false);
    if (id !== lead.id) setView("steps");
    else if (!roomy) setView("steps");
    onOpenThread(id);
  };
  const back = () => {
    // With room in the strip the tree goes back there; without, back to the steps.
    if (roomy) setEnlarged(false);
    else setView("steps");
  };
  const running = active(team);
  // The present moves on, once a second, only while the team works.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const byId = (id: string | undefined) => (id ? threads.find((t) => t.id === id) : undefined);
  const events = team.timeline ?? [];
  const start = events[0]?.at ?? lead.createdAt;
  const end = Math.max(start + 1000, running ? now : (events.at(-1)?.at ?? start));
  const x = (at: number) => Math.min(1, Math.max(0, (at - start) / (end - start)));
  const lastPhase = (lane: number) => events.findLast((e) => e.lane === lane)?.phase;

  const lanes = teamLanes(lead, team, threads, agents);

  /** What the lane is at now: its phase, and whether its agent is really at work. */
  const state = (l: Lane) => {
    const phase = lastPhase(l.lane);
    const thread = byId(l.live);
    const working = running && !!phase && WORKING.has(phase);
    return {
      phase,
      asks: working && thread?.status === "waiting",
      // In line for a place on the server: its agent has not started.
      moving: working && thread?.status === "running" && !thread.inLine,
      inLine: working && !!thread?.inLine,
    };
  };

  const done = team.tasks.filter((t) => t.status === "done").length;
  const busy = lanes.filter((l) => state(l).moving).length;
  const asking = lanes.filter((l) => state(l).asks).length;
  const lined = lanes.filter((l) => state(l).inLine).length;
  const summary = running
    ? [
        busy ? `${busy} agent${busy > 1 ? "s" : ""} au travail` : "Personne ne tourne",
        lined ? `${lined} en file` : "",
        asking ? `${asking} attend${asking > 1 ? "ent" : ""} ton accord` : "",
        `depuis ${span(now - start)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : `${team.phase === "done" ? "Terminée" : team.phase === "blocked" ? "En attente de toi" : team.phase === "failed" ? "Échouée" : "Arrêtée"} · ${span(end - start)} en tout`;

  return (
    <section
      ref={box}
      className={`tlb${open ? " open" : ""}${running ? " live" : ""}${tree && !whole ? " arbre" : ""}`}
      aria-label="Frise de l'équipe"
    >
      <button className="tl-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tl-stack" aria-hidden>
          {lanes.map((l) => {
            const s = state(l);
            const dot = s.asks
              ? "wait"
              : s.moving
                ? "live"
                : s.phase === "done"
                  ? "done"
                  : s.phase === "blocked" || s.phase === "failed"
                    ? "wait"
                    : "idle";
            return (
              <span key={l.lane} className={`tl-b d-${dot}`}>
                {l.lane === LEAD_LANE
                  ? "C"
                  : l.lane === MERGE_LANE
                    ? "F"
                    : l.lane === QUEUED_REVIEW
                      ? "R"
                      : l.lane === QUEUED_TEST
                        ? "T"
                        : l.lane + 1}
              </span>
            );
          })}
        </span>
        <span className="tl-sum">{summary}</span>
        {team.tasks.length > 0 && (
          <span className="tl-n">
            <b>{done}</b>/{team.tasks.length}
          </span>
        )}
        <svg className="chev" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open && (
        <div className="tl-view">
          <span className="tl-seg" role="radiogroup" aria-label="Vue de l'équipe">
            <button role="radio" aria-checked={view === "steps"} onClick={() => setView("steps")}>
              Étapes
            </button>
            <button
              role="radio"
              aria-checked={view === "tree"}
              onClick={() => {
                setEnlarged(false);
                setView("tree");
              }}
            >
              Arbre
            </button>
          </span>
          {tree && !whole && (
            <button className="btn sm quiet" onClick={() => setEnlarged(true)}>
              Agrandir
            </button>
          )}
        </div>
      )}
      {tree && !whole && (
        <TeamTree
          lead={lead}
          team={team}
          threads={threads}
          agents={agents}
          onOpenThread={openFromTree}
        />
      )}
      {centre &&
        createPortal(
          <div className="tt-full" role="region" aria-label="Arbre de l'équipe">
            <header className="tt-full-h">
              <button className="btn sm" onClick={back}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M9.5 3.5 5 8l4.5 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Retour au fil
              </button>
              <b>{lead.title}</b>
              <span>{summary}</span>
            </header>
            <TeamTree
              lead={lead}
              team={team}
              threads={threads}
              agents={agents}
              onOpenThread={openFromTree}
            />
          </div>,
          centre,
        )}
      {open && !(tree && !whole) && (
        <div className="tl-body">
          <div className="tl-grid">
            {lanes.map((l) => {
              const s = state(l);
              const mine = events.filter((e) => e.lane === l.lane);
              return (
                <div
                  key={l.lane}
                  className={`tl-l${s.phase === "idle" ? " ph-idle" : ""}${l.after ? " tl-after" : ""}`}
                  // A lane whose thread is not made yet opens nothing: it is no button.
                  role={l.open ? "button" : "group"}
                  tabIndex={l.open ? 0 : undefined}
                  aria-label={`${l.who} : ${s.asks ? "attend ton accord" : LABEL[s.phase ?? "idle"] || l.after || "au repos"}`}
                  onClick={() => l.open && onOpenThread(l.open)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && l.open) {
                      e.preventDefault();
                      onOpenThread(l.open);
                    }
                  }}
                >
                  <span className="tl-who">
                    <b>{l.who}</b>
                    <small>{l.sub}</small>
                  </span>
                  <span className="tl-tr">
                    {mine.map((e, k) => {
                      const next = mine[k + 1];
                      const last = !next;
                      const from = x(e.at);
                      if (e.phase === "done") {
                        return (
                          <i key={k} className="tl-ok" style={{ left: `${from * 100}%` }}>
                            ✓
                          </i>
                        );
                      }
                      const k2 = kind(e.phase);
                      if (!k2) return null;
                      const to = x(next?.at ?? end);
                      const live = last && running && WORKING.has(e.phase);
                      return (
                        <i
                          key={k}
                          className={`tl-s p-${live && s.asks ? "wait" : k2}${live && (s.moving || s.asks) ? " lv" : ""}`}
                          style={{
                            left: `${from * 100}%`,
                            width: `${Math.max(0.6, (to - from) * 100)}%`,
                          }}
                        />
                      );
                    })}
                  </span>
                  <span className={`tl-st ph-${s.asks ? "wait" : (s.phase ?? "idle")}`}>
                    {s.asks ? "attend ton accord" : LABEL[s.phase ?? "idle"] || l.after}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="tl-ax">
            <span>{clock(start)}</span>
            <span className="tl-legs">
              <span className="tl-leg">
                <i className="p-code" />
                code
              </span>
              <span className="tl-leg">
                <i className="p-review" />
                relecture
              </span>
              <span className="tl-leg">
                <i className="p-test" />
                tests
              </span>
              <span className="tl-leg">
                <i className="p-wait" />
                attente
              </span>
            </span>
            <span>{running ? "maintenant" : clock(end)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
