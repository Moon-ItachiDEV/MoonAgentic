import type { AgentInfo, Thread } from "@moonagentic/protocol";
import type { State } from "../state.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconChevron } from "./icons.tsx";

/** A conversation that is live right now, as the phone's home page shows it. */
export interface HomeCard {
  thread: Thread;
  /** The agents at work: the team's members, or the thread's own agent. */
  agentIds: string[];
  sub: string;
  /** Tone of the line under the title. */
  tone: "work" | "wait" | "review";
  /** One segment per piece of a team: done, under way, or not started. */
  pieces?: ("done" | "busy" | "todo")[];
}

const BUSY = new Set(["running", "reviewing", "testing", "lead"]);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * The conversations worth coming back to, newest first: an agent at work, an agent waiting
 * for you, a team under way, or changes to review. Only what the server reports, nothing
 * made up.
 */
export function homeCards(state: Pick<State, "threads" | "reviews">, max = 4): HomeCard[] {
  const cards: HomeCard[] = [];
  const threads = [...state.threads]
    .filter((t) => !t.parentId && !t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const thread of threads) {
    const team = thread.team;
    // A member asking for your permission stops the team as much as a blocked phase does.
    const asking =
      team?.phase === "blocked" ||
      state.threads.some((t) => t.parentId === thread.id && t.status === "waiting");
    if (team && !["done", "failed", "stopped"].includes(team.phase)) {
      const done = team.tasks.filter((p) => p.status === "done").length;
      const busy = team.tasks.filter((p) => BUSY.has(p.status)).length;
      const members = [thread.agentId, team.coder.agentId, team.reviewer?.agentId]
        .concat(team.tester?.agentId, team.merger?.agentId)
        .filter((id): id is string => !!id);
      cards.push({
        thread,
        agentIds: [...new Set(members)],
        tone: asking ? "wait" : "work",
        sub: asking
          ? "Attend ta réponse"
          : team.tasks.length
            ? `${plural(busy, "agent au travail", "agents au travail")} · ${done} sur ${team.tasks.length} terminés`
            : "Le chef découpe la tâche",
        pieces: team.tasks.map((p) =>
          p.status === "done" ? "done" : BUSY.has(p.status) ? "busy" : "todo",
        ),
      });
    } else if (thread.status === "waiting") {
      cards.push({ thread, agentIds: [thread.agentId], tone: "wait", sub: "Attend ta réponse" });
    } else if (thread.status === "running") {
      cards.push({ thread, agentIds: [thread.agentId], tone: "work", sub: "Au travail" });
    } else {
      const files = state.reviews[thread.id]?.files?.length ?? 0;
      if (files > 0 && thread.workspace)
        cards.push({
          thread,
          agentIds: [thread.agentId],
          tone: "review",
          sub: `À revoir · ${plural(files, "fichier", "fichiers")}`,
        });
    }
    if (cards.length >= max) break;
  }
  return cards;
}

export function HomeCards(props: {
  state: State;
  agents: AgentInfo[];
  /** Opens the card: the thread, or the project's page for a project's coordinator. */
  onOpen: (thread: Thread) => void;
}) {
  const cards = homeCards(props.state);
  if (!cards.length) return null;
  return (
    <div className="qcards" aria-label="En cours">
      {cards.map((c) => (
        <button key={c.thread.id} className="qcard" onClick={() => props.onOpen(c.thread)}>
          <span className={`stk${c.agentIds.length > 1 ? " many" : ""}`}>
            {c.agentIds.slice(0, 4).map((id) => (
              <AgentBadge
                key={id}
                agent={props.agents.find((a) => a.id === id) ?? { id, short: "?" }}
              />
            ))}
          </span>
          <span className="qc-tx">
            <span className="qc-t">{c.thread.title}</span>
            <span className={`qc-s ${c.tone}`}>{c.sub}</span>
            {c.pieces && c.pieces.length > 0 && (
              <span className="qc-bars" aria-hidden>
                {c.pieces.map((p, i) => (
                  <i key={i} className={p} />
                ))}
              </span>
            )}
          </span>
          <IconChevron size={14} />
        </button>
      ))}
    </div>
  );
}
