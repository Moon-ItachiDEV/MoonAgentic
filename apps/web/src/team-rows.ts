// A team as the lines of its card: one per role, from what its threads really do. Pure.
import type { AgentInfo, Team, TeamLanePhase } from "@moonagentic/protocol";
import type { FrostMoonState } from "./components/FrostMoon.tsx";
import { modelNameOf } from "./model-label.ts";
import type { TeamTreeModel, TreeNode } from "./team-tree.ts";
import type { MascJob } from "./v2/Masc.tsx";

const LEAD_LANE = -1;
const MERGE_LANE = -2;

export const teamActive = (team: Team) =>
  team.phase === "planning" || team.phase === "coding" || team.phase === "merging";
/** Every piece done, to be merged onto one branch: more than one, as the server does. */
export const mergeable = (team: Team) =>
  team.tasks.length > 1 && team.tasks.every((t) => t.status === "done");

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

/** A length of time as a clock reads it: « 58 s », « 6 min 13 », « 1 h 04 ». */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${m} min ${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

/** How long a lane's agents really worked, from the changes the server wrote down. */
function laneTime(team: Team, lane: number, until: number): number {
  const events = (team.timeline ?? []).filter((e) => e.lane === lane);
  let total = 0;
  events.forEach((e, i) => {
    if (WORKING.has(e.phase)) total += (events[i + 1]?.at ?? until) - e.at;
  });
  return total;
}

/** A verdict line is for the server: the note says what it means already. */
export const noteText = (note: string) =>
  note.replace(/^\s*VERDICT\s*:.*$/gim, "").trim() || note.trim();

/** The branch that holds a finished team's work: the merge's, or its only piece's. */
export const shipTarget = (team: Team) =>
  team.mergeThreadId ?? (team.tasks.length === 1 ? team.tasks[0]?.threadId : undefined);

export type RowState = "ok" | "run" | "idle" | "stop";
export interface Row {
  key: string;
  job: MascJob;
  name: string;
  model: string;
  state: RowState;
  /** What the mascot's eyes say. */
  face: FrostMoonState;
  text: string;
  /** Its agent is at it right now: the line shimmers. */
  live: boolean;
  /** Red, for what went wrong or is to be corrected. */
  bad: boolean;
  time?: string;
  threadId?: string;
}

const modelOf = (node: TreeNode) => node.sub.split(" · ").at(-1) ?? "";

/** A line of the list, from one agent of the team as the tree knows it. */
function rowOf(node: TreeNode, base: Pick<Row, "key" | "job" | "name">, rest: string): Row {
  const live = node.tone === "work";
  const stopped = node.label === "Arrêté";
  const state: RowState =
    node.tone === "ok" ? "ok" : live || node.tone === "warn" ? "run" : stopped ? "stop" : "idle";
  const bad = node.tone === "err" || node.label === "À corriger";
  const face: FrostMoonState = bad
    ? "erreur"
    : node.tone === "ok"
      ? "termine"
      : live
        ? (node.glyph ?? "travaille")
        : node.tone === "warn"
          ? "attend"
          : stopped
            ? "repos"
            : "file";
  return {
    ...base,
    model: modelOf(node),
    state: node.tone === "err" ? "stop" : state,
    face,
    text: live || node.tone !== "idle" ? node.action || node.label : rest,
    live,
    bad,
    ...(node.threadId ? { threadId: node.threadId } : {}),
  };
}

/**
 * One line for every reviewer (or tester) of the team: they are the same agent, at work on
 * one piece after the other. It says what the one at work does, else what they found.
 */
function checkRow(
  nodes: TreeNode[],
  base: Pick<Row, "key" | "job" | "name">,
  rest: string,
): Row | undefined {
  const first = nodes[0];
  if (!first) return undefined;
  const at =
    nodes.find((n) => n.tone === "work") ??
    nodes.find((n) => n.tone === "err") ??
    nodes.find((n) => n.tone === "warn");
  if (at) return rowOf(at, base, rest);
  if (nodes.every((n) => n.tone === "ok")) return rowOf(first, base, rest);
  const row = rowOf(nodes.findLast((n) => !n.pending) ?? first, base, rest);
  const passed = nodes.filter((n) => n.tone === "ok").length;
  return passed
    ? { ...row, state: "idle", face: "file", text: `${passed} sur ${nodes.length}` }
    : row;
}

/** The card's lines, in the order the work goes: lead, coders, review, tests, merge. */
export function teamRows(
  team: Team,
  model: TeamTreeModel,
  agents: AgentInfo[],
  end: number,
): Row[] {
  const running = teamActive(team);
  const pieces = team.tasks.length;
  const rows: Row[] = [];
  const chef = rowOf(
    model.lead,
    { key: "lead", job: "chef", name: "Chef" },
    pieces ? `Plan en ${pieces} ${pieces > 1 ? "parties" : "partie"}` : "",
  );
  // Its plan made, the lead's part is done while the others work.
  if (team.phase !== "planning" && model.lead.tone === "idle" && pieces) {
    chef.state = "ok";
    chef.face = "termine";
  }
  // The plan is being made, whatever its thread shows at this instant.
  if (team.phase === "planning" && chef.state === "idle") {
    chef.state = "run";
    chef.face = "pense";
    chef.text = "Prépare le plan";
  }
  chef.time = clock(laneTime(team, LEAD_LANE, end));
  rows.push(chef);
  model.pieces.forEach((p, i) => {
    const task = team.tasks[i];
    const row = rowOf(
      p.coder,
      { key: p.coder.key, job: "code", name: pieces > 1 ? `Codeur ${i + 1}` : "Codeur" },
      task?.title ?? "",
    );
    // At rest or done, the line names the piece: that is what tells the coders apart.
    const quiet = !row.live && !row.bad && p.coder.tone !== "warn";
    // Also while it works and nothing of what it does is known yet.
    if (task && (quiet || (row.live && !p.coder.action))) row.text = task.title;
    if (row.state === "ok") row.time = clock(laneTime(team, i, end));
    rows.push(row);
  });
  const review = checkRow(
    model.pieces.flatMap((p) => (p.reviewer ? [p.reviewer] : [])),
    { key: "review", job: "relit", name: "Relecture" },
    "Après les codeurs",
  );
  const tests = checkRow(
    model.pieces.flatMap((p) => (p.tester ? [p.tester] : [])),
    { key: "tests", job: "tests", name: "Tests" },
    team.reviewer ? "Après la relecture" : "Après les codeurs",
  );
  // While the lead plans there is no piece yet: the roles to come are listed all the same.
  const member = (m: { agentId: string; model?: string }) => {
    const agent = agents.find((a) => a.id === m.agentId);
    return modelNameOf(agent?.models, m.model) ?? agent?.name ?? m.agentId;
  };
  const toCome = (key: string, job: MascJob, name: string, model: string, text: string): Row => ({
    key,
    job,
    name,
    model,
    state: running ? "idle" : "stop",
    face: running ? "file" : "repos",
    text: running ? text : "",
    live: false,
    bad: false,
  });
  if (!pieces) {
    rows.push(toCome("coders", "code", "Codeurs", member(team.coder), "Après le plan"));
  }
  if (review) rows.push(review);
  else if (team.reviewer)
    rows.push(toCome("review", "relit", "Relecture", member(team.reviewer), "Après les codeurs"));
  if (tests) rows.push(tests);
  else if (team.tester)
    rows.push(
      toCome(
        "tests",
        "tests",
        "Tests",
        member(team.tester),
        team.reviewer ? "Après la relecture" : "Après les codeurs",
      ),
    );
  if (model.merger) {
    const row = rowOf(model.merger, { key: "merge", job: "fusion", name: "Fusion" }, "À la fin");
    if (row.state === "ok") row.time = clock(laneTime(team, MERGE_LANE, end));
    rows.push(row);
  } else if (team.merger && pieces !== 1) {
    rows.push(toCome("merge", "fusion", "Fusion", member(team.merger), "À la fin"));
  }
  // A team that is over has nobody waiting for a turn.
  if (!running) {
    for (const row of rows) {
      if (row.state === "idle") {
        row.state = "stop";
        row.face = "repos";
        if (row.text.startsWith("Après") || row.text === "À la fin") row.text = "";
      }
    }
  }
  return rows;
}
