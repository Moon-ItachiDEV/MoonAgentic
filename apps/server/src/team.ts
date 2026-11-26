import type {
  PermissionMode,
  TeamEvent,
  TeamLanePhase,
  ReviewFile,
  Team,
  TeamMember,
  TeamMission,
  TeamRole,
  TeamTask,
  Thread,
} from "@moonagentic/protocol";
import type { ShipResult } from "./git.ts";

/** Pieces of work a lead may hand out, so a plan never floods the machine with agents. */
const MAX_TASKS = 8;
/** Pieces a team holds at most, missions added along the way included. */
const MAX_TEAM_TASKS = 32;
/** Missions the user may add to one team. */
const MAX_MISSIONS = 16;
/** Times the lead is asked again for a plan that could not be read. */
const MAX_PLAN_TRIES = 2;
/** Corrections a coder gets before the lead rewrites its brief. */
export const MAX_TRIES = 3;
/** Characters of a piece's changes shown to its reviewer; it opens the files for more. */
const DIFF_LIMIT = 60_000;
/** Characters of remarks kept on a piece. */
const NOTE_LIMIT = 8_000;

/** What the team needs from the hub: threads, their turns and what their agent said. */
export interface TeamHost {
  thread(id: string): Thread | undefined;
  threads(): Thread[];
  createThread(input: {
    projectId: string;
    agentId: string;
    model?: string | undefined;
    permissionMode: PermissionMode;
    isolated: boolean;
    text: string;
    title: string;
    parentId?: string;
    role: TeamRole;
    /** The thread whose folder it works in. */
    worksIn?: string;
    /** Given at creation, so the thread is never seen without its team. */
    team?: Team;
    openedBy?: string;
    taskKey?: string;
  }): string;
  send(threadId: string, text: string): void;
  cancel(threadId: string): Promise<void>;
  setTeam(threadId: string, team: Team): void;
  /** Everything the agent said in the thread's last turn. */
  lastReply(threadId: string): string;
  /** What changed on the thread's branch since it started. */
  changes(threadId: string): Promise<{ files: ReviewFile[]; omitted?: number }>;
  /**
   * Commits what the `from` thread left, then merges its branch onto the `into` thread's.
   * Returns the files left in conflict, the merge then still under way; empty when merged.
   */
  mergeInto(intoId: string, fromId: string, message: string): Promise<string[]>;
  /** Commits what is left, pushes the thread's branch and opens its pull request. */
  ship(threadId: string, message: string, title: string, body: string): Promise<ShipResult>;
  /** The files still in conflict while a merge is under way in the thread's folder. */
  unfinishedMerge(threadId: string): Promise<string[] | undefined>;
  /** Whether the `from` thread's branch is part of the `into` thread's. */
  contains(intoId: string, fromId: string): Promise<boolean>;
}

export interface TeamInput {
  projectId: string;
  task: string;
  lead: TeamMember;
  coder: TeamMember;
  reviewer?: TeamMember | undefined;
  reviewer2?: TeamMember | undefined;
  judge?: TeamMember | undefined;
  tester?: TeamMember | undefined;
  merger?: TeamMember | undefined;
  coders: number;
  permissionMode: PermissionMode;
  /** Opens the pull request by itself once done; true when left out. */
  autoShip?: boolean | undefined;
  /** The coordinator that started it, and its name for the subject. */
  openedBy?: string | undefined;
  taskKey?: string | undefined;
}

const planPrompt = (task: string, coders: number) =>
  `Tu es le chef d'une équipe de ${coders} codeur${coders > 1 ? "s" : ""} qui travaillent en même temps, chacun sur sa propre branche.

Tâche : ${task}

Lis le projet sans rien modifier, puis découpe cette tâche en sous-tâches indépendantes, une par codeur si possible (${MAX_TASKS} au plus). Deux sous-tâches ne doivent pas modifier les mêmes fichiers. Pour chacune, écris une consigne complète : le codeur ne verra que sa consigne.

Termine ta réponse par ce bloc, et rien après :

\`\`\`json
{"tasks": [{"title": "titre court", "brief": "consigne complète"}]}
\`\`\``;

const coderPrompt = (task: string, piece: TeamTask) =>
  `Tu fais partie d'une équipe. La tâche de l'équipe : ${task}

Ta sous-tâche : ${piece.title}

${piece.brief}

Travaille seulement sur cette sous-tâche, dans ce dossier. Quand tu as fini, résume ce que tu as changé.`;

const VERDICT_RULE =
  "Termine ta réponse par la ligne « VERDICT : OK » si c'est bon, ou « VERDICT : À CORRIGER » après la liste de ce qu'il faut corriger.";

const pieceText = (team: Team, task: TeamTask) =>
  `La tâche de l'équipe : ${team.task}

La sous-tâche : ${task.title}

${task.brief}`;

const reviewPrompt = (team: Team, task: TeamTask, diff: string) =>
  `Tu relis le travail d'un codeur de l'équipe. ${pieceText(team, task)}

Ses changements, depuis le départ de sa branche :

\`\`\`\`diff
${diff || "(aucun changement)"}
\`\`\`\`

Tu es dans le dossier du codeur : ouvre les fichiers si besoin, mais ne modifie rien. Vérifie que la sous-tâche est faite, sans bug ni oubli. ${VERDICT_RULE}`;

const judgePrompt = (team: Team, task: TeamTask, reviews: string[]) =>
  `Tu arbitres les relectures du travail d'un codeur de l'équipe. ${pieceText(team, task)}

${reviews.map((r, i) => `Relecture ${i + 1} :\n\n${r || "(vide)"}`).join("\n\n---\n\n")}

Tu es dans le dossier du codeur : ouvre les fichiers si besoin, mais ne modifie rien. Vérifie chaque remarque dans le code, écarte celles qui sont fausses ou sans importance, et garde seulement ce qui est vraiment à corriger. ${VERDICT_RULE}`;

const testPrompt = (team: Team, task: TeamTask) =>
  `Tu testes le travail d'un codeur de l'équipe. ${pieceText(team, task)}

Tu es dans le dossier du codeur, sur sa branche. Lance les tests du projet et ajoute ceux qui manquent pour cette sous-tâche. Ne change pas le code lui-même : si un test échoue à cause du code, dis ce qui échoue. ${VERDICT_RULE}`;

const fixPrompt = (tries: number, notes: string) =>
  `Ta sous-tâche n'est pas encore bonne (correction ${tries} sur ${MAX_TRIES}).

${notes}

Corrige, puis résume ce que tu as changé.`;

const leadHelpPrompt = (task: TeamTask) =>
  `La sous-tâche « ${task.title} » bloque après ${MAX_TRIES} corrections.

Sa consigne :

${task.brief}

Les dernières remarques :

${task.note ?? "(aucune)"}

Regarde le projet et ce qui bloque, sans rien modifier, puis écris une nouvelle consigne plus précise pour le codeur. Termine ta réponse par ce bloc, et rien après :

\`\`\`json
{"brief": "nouvelle consigne complète"}
\`\`\``;

const missionPrompt = (team: Team, mission: TeamMission) =>
  `L'utilisateur ajoute une mission à l'équipe pendant qu'elle travaille :

${mission.text}

La tâche de l'équipe : ${team.task}

Le plan en cours :
${team.tasks.map((t) => `- ${t.title} (${t.status === "done" ? "fait" : t.status === "waiting" ? "pas commencé" : "en cours"})`).join("\n") || "(vide)"}

Lis le projet sans rien modifier, puis découpe cette mission en nouvelles sous-tâches pour les codeurs (${MAX_TASKS} au plus). Une sous-tâche ne doit pas modifier les fichiers d'une sous-tâche en cours. Pour chacune, écris une consigne complète : le codeur ne verra que sa consigne. Si le plan couvre déjà la mission, donne une liste vide.

Termine ta réponse par ce bloc, et rien après :

\`\`\`json
{"tasks": [{"title": "titre court", "brief": "consigne complète"}]}
\`\`\``;

const briefPrompt = (brief: string) =>
  `Le chef a revu ta consigne. Reprends ta sous-tâche avec celle-ci :

${brief}

Quand tu as fini, résume ce que tu as changé.`;

const conflictPrompt = (task: TeamTask, files: string[]) =>
  `Tu fusionnes le travail d'une équipe sur cette branche. La fusion de la sous-tâche « ${task.title} » a des conflits dans :

${files.map((f) => `- ${f}`).join("\n")}

Règle chaque conflit en gardant les deux changements quand c'est possible, puis termine la fusion avec \`git add\` et \`git commit --no-edit\`. Ne change rien d'autre.`;

const mergeCheckPrompt = (team: Team) =>
  `Toutes les sous-tâches de l'équipe sont fusionnées sur cette branche. La tâche de l'équipe : ${team.task}

Lance les tests du projet et corrige ce qui casse là où les sous-tâches se rejoignent, puis fais un commit de tes corrections. ${VERDICT_RULE}`;

const RESUME_PROMPT =
  "Reprends ta sous-tâche là où elle en est et termine-la. Quand tu as fini, résume ce que tu as changé.";

const VERDICT_AGAIN =
  "Je n'ai pas trouvé ton verdict. Termine par la ligne « VERDICT : OK » ou « VERDICT : À CORRIGER ».";

/** The JSON object that starts at `start`, up to its matching brace, strings skipped. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * The JSON objects with `key` in a reply, last first: from ```json blocks, then bare ones,
 * for an agent that left the fence out, however laid out and whatever it wrote after.
 */
function jsonObjects(reply: string, key: string): Record<string, unknown>[] {
  const blocks = [...reply.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map(
    (m) => m[1] ?? "",
  );
  const bare = [...reply.matchAll(new RegExp(`\\{\\s*"${key}"\\s*:`, "g"))]
    .map((m) => objectAt(reply, m.index))
    .filter((raw): raw is string => raw !== undefined);
  return [...blocks.reverse(), ...bare.reverse()].flatMap((raw) => {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      return typeof parsed === "object" && parsed !== null && key in parsed
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Reads the lead's plan from the last JSON block of its reply, or undefined. `empty`: an
 * empty list is an answer too (a mission the plan already covers).
 */
export function readPlan(
  reply: string,
  empty = false,
): { title: string; brief: string }[] | undefined {
  for (const parsed of jsonObjects(reply, "tasks")) {
    if (!Array.isArray(parsed.tasks)) continue;
    if (empty && !parsed.tasks.length) return [];
    const tasks = parsed.tasks.flatMap((t: unknown) => {
      if (typeof t !== "object" || t === null) return [];
      const { title, brief } = t as { title?: unknown; brief?: unknown };
      if (typeof title !== "string" || typeof brief !== "string") return [];
      if (!title.trim() || !brief.trim()) return [];
      return [{ title: title.trim().slice(0, 120), brief: brief.trim().slice(0, 20_000) }];
    });
    if (tasks.length) return tasks.slice(0, MAX_TASKS);
  }
  return undefined;
}

/** Reads the brief the lead rewrote, or undefined. */
export function readBrief(reply: string): string | undefined {
  for (const { brief } of jsonObjects(reply, "brief")) {
    if (typeof brief === "string" && brief.trim()) return brief.trim().slice(0, 20_000);
  }
  return undefined;
}

/** The reviewer's or tester's last verdict: `ok`, `fix`, or undefined when it gave none. */
export function readVerdict(reply: string): "ok" | "fix" | undefined {
  const last = [...reply.matchAll(/VERDICT\s*:?[\s*_`]*(OK\b|[ÀA]\s+CORRIGER)/giu)].at(-1);
  if (!last) return undefined;
  return /^ok$/i.test(last[1] ?? "") ? "ok" : "fix";
}

/** The changes as one unified diff, cut down to what a reviewer can read at once. */
export function diffText(
  changes: { files: ReviewFile[]; omitted?: number },
  limit = DIFF_LIMIT,
): string {
  let text = "";
  for (const file of changes.files) {
    const name = file.from ? `${file.from} → ${file.path}` : file.path;
    const head = `--- ${name} (${file.status}, +${file.added ?? "?"} -${file.removed ?? "?"})\n`;
    const body = file.patch ? file.patch.replace(/\n?$/, "\n") : "";
    if (file.truncated || text.length + head.length + body.length > limit) {
      text += `${head}(diff coupé : ouvre le fichier)\n`;
      continue;
    }
    text += head + body;
  }
  if (changes.omitted) text += `(${changes.omitted} autres fichiers changés, non montrés)\n`;
  return text.trimEnd();
}

const active = (team: Team | undefined) =>
  team?.phase === "planning" || team?.phase === "coding" || team?.phase === "merging";
/** Pieces merged onto one branch once they are all done; a single one ships on its own. */
const mergeable = (team: Team) =>
  team.tasks.length > 1 && team.tasks.every((t) => t.status === "done");
/** A piece someone is working on, which takes one of the team's places. */
const working = (t: TeamTask) =>
  t.status === "running" ||
  t.status === "reviewing" ||
  t.status === "judging" ||
  t.status === "testing" ||
  t.status === "lead";
const open = (t: TeamTask) => t.status === "waiting" || working(t);
/** A mission the lead has still to put in its plan. */
const unread = (m: TeamMission) => m.status === "waiting" || m.status === "reading";
const cut = (text: string) => (text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}…` : text);
/** The branch that holds a finished team's work: the merge's, or its only piece's. */
export const shipTarget = (team: Team): string | undefined =>
  team.mergeThreadId ?? (team.tasks.length === 1 ? team.tasks[0]?.threadId : undefined);

/** The pull request's description: the task as asked, and its pieces. */
const prBody = (team: Team) =>
  [
    team.task,
    "",
    "## Sous-tâches",
    ...team.tasks.map((t) => `- ${t.title}`),
    ...(team.missions?.length
      ? ["", "## Missions ajoutées en route", ...team.missions.map((m) => `- ${firstLine(m.text)}`)]
      : []),
    "",
    "Ouverte par l'équipe MoonAgentic, après relecture et tests de chaque sous-tâche.",
  ].join("\n");

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The thread a piece's agent works in at this point, if any. */
const runningThread = (t: TeamTask): string[] =>
  (t.status === "running"
    ? [t.threadId]
    : t.status === "reviewing"
      ? [t.reviewThreadId, t.review2ThreadId]
      : t.status === "judging"
        ? [t.judgeThreadId]
        : t.status === "testing"
          ? [t.testThreadId]
          : []
  ).filter((id): id is string => !!id);

/** The team with every piece at work cut short, what was done kept: a stop or a restart. */
const cutShort = (team: Team): Team => {
  const {
    leadTask: _lead,
    leadMission: _mission,
    mergeStep: _step,
    mergeReasked: _reasked,
    ...rest
  } = team;
  return {
    ...rest,
    tasks: team.tasks.map((t) => (open(t) ? { ...t, status: "stopped" } : t)),
    ...(team.missions
      ? {
          missions: team.missions.map((m) =>
            unread(m) ? { ...m, status: "stopped" as const } : m,
          ),
        }
      : {}),
  };
};

/** The reviewers of each piece: the first, and a second when the team has one. */
const reviewRoles = (team: Team): ("reviewer" | "reviewer2")[] =>
  team.reviewer ? (team.reviewer2 ? ["reviewer", "reviewer2"] : ["reviewer"]) : [];
const REVIEWER_NAME = { reviewer: "Le premier relecteur", reviewer2: "Le second relecteur" };

type CheckRole = "reviewer" | "reviewer2" | "judge" | "tester";
/** How each check of a piece is run: the piece's status meanwhile, and its thread. */
const CHECKS: Record<
  CheckRole,
  {
    status: TeamTask["status"];
    field: "reviewThreadId" | "review2ThreadId" | "judgeThreadId" | "testThreadId";
    title: string;
    what: string;
  }
> = {
  reviewer: {
    status: "reviewing",
    field: "reviewThreadId",
    title: "Relecture",
    what: "La relecture",
  },
  reviewer2: {
    status: "reviewing",
    field: "review2ThreadId",
    title: "Relecture 2",
    what: "La seconde relecture",
  },
  judge: { status: "judging", field: "judgeThreadId", title: "Arbitrage", what: "L'arbitrage" },
  tester: { status: "testing", field: "testThreadId", title: "Tests", what: "Le test" },
};

/** Events kept per team, the oldest dropped first. */
const TIMELINE_LIMIT = 600;
const PHASE_TEXT: Record<Team["phase"], string> = {
  planning: "le chef découpe la tâche",
  coding: "les codeurs travaillent",
  merging: "les parts sont fusionnées sur une seule branche",
  blocked: "l'équipe attend l'utilisateur",
  done: "terminée",
  failed: "échouée",
  stopped: "arrêtée",
};
const TASK_TEXT: Record<TeamTask["status"], string> = {
  waiting: "en attente d'un codeur libre",
  running: "le codeur travaille",
  reviewing: "en relecture",
  judging: "l'arbitre pèse les relectures",
  testing: "en tests",
  lead: "le chef réécrit sa consigne",
  blocked: "bloquée, attend l'utilisateur",
  done: "terminée",
  failed: "échouée",
  stopped: "arrêtée",
};
/** Characters of a coder's last words, and of a note, given to the lead. */
const STATUS_CUT = 400;
const tail = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > STATUS_CUT ? `…${flat.slice(-STATUS_CUT)}` : flat;
};
const minutes = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 1 ? "moins d'une minute" : `${min} min`;
};

/**
 * The team's real state, written for its lead: the server runs the pieces, so a lead the
 * user talks to would otherwise know nothing past its own plan.
 */
export function teamStatus(team: Team, now: number, lastReply: (id: string) => string): string {
  const started = team.timeline?.[0]?.at;
  const lines = [
    "[État réel de ton équipe, donné par MoonAgentic : c'est le serveur qui lance les codeurs, la relecture, les tests et la fusion d'après ton plan. L'utilisateur ne voit pas ce bloc ; sers-t'en pour lui répondre.]",
    `Phase : ${PHASE_TEXT[team.phase]}${started === undefined ? "" : `, depuis ${minutes(now - started)}`}.`,
  ];
  const steps = [
    team.reviewer && "relecture",
    team.tester && "tests",
    team.tasks.length > 1 && (team.merger ? "fusion vérifiée" : "fusion"),
  ].filter(Boolean);
  if (steps.length) lines.push(`Après le code de chaque part : ${steps.join(", ")}.`);
  if (team.error) lines.push(`Erreur : ${tail(team.error)}`);
  const done = team.tasks.filter((t) => t.status === "done").length;
  lines.push(`Parts : ${done} sur ${team.tasks.length} terminées.`);
  team.tasks.forEach((task, i) => {
    let line = `${i + 1}. « ${task.title} » : ${TASK_TEXT[task.status]}`;
    if (task.merged) line += ", fusionnée";
    if (task.tries)
      line += `, ${task.tries} correction${task.tries > 1 ? "s" : ""} demandée${task.tries > 1 ? "s" : ""}`;
    line += ".";
    if (task.note) line += ` Remarques : ${tail(task.note)}`;
    const said = task.threadId ? tail(lastReply(task.threadId)) : "";
    if (said) line += ` Dernier message du codeur : ${said}`;
    lines.push(line);
  });
  lines.push("[Fin de l'état. Message de l'utilisateur :]");
  return lines.join("\n");
}

export const LEAD_LANE = -1;
export const MERGE_LANE = -2;

/** What each lane of the team is doing now. */
function lanes(team: Team): Map<number, TeamLanePhase> {
  const now = new Map<number, TeamLanePhase>();
  now.set(
    LEAD_LANE,
    team.phase === "planning"
      ? "planning"
      : team.leadTask !== undefined || team.leadMission !== undefined
        ? "lead"
        : team.tasks.length === 0 && (team.phase === "failed" || team.phase === "stopped")
          ? team.phase
          : "idle",
  );
  team.tasks.forEach((t, i) => now.set(i, t.status));
  if (team.phase === "merging") {
    now.set(
      MERGE_LANE,
      team.mergeStep === -1 ? "checking" : team.mergeStep !== undefined ? "solving" : "merging",
    );
  } else if (team.mergeThreadId) {
    now.set(
      MERGE_LANE,
      team.phase === "done" ? "done" : team.phase === "blocked" ? "blocked" : "stopped",
    );
  }
  return now;
}

/** The team with a timeline event for each lane whose phase changed since the last one. */
export function recordTimeline(team: Team, at: number): Team {
  const timeline: TeamEvent[] = [...(team.timeline ?? [])];
  const last = new Map<number, TeamLanePhase>();
  for (const event of timeline) last.set(event.lane, event.phase);
  for (const [lane, phase] of lanes(team)) {
    if (last.get(lane) !== phase) timeline.push({ at, lane, phase });
  }
  return { ...team, timeline: timeline.slice(-TIMELINE_LIMIT) };
}

const withTask = (team: Team, index: number, task: TeamTask): Team => ({
  ...team,
  tasks: team.tasks.with(index, task),
});

/**
 * Runs teams: the lead's thread plans, then each piece of the plan gets a coder's thread on
 * its own branch, a few at a time. A reviewer then reads the piece and a tester runs its
 * tests; what they find goes back to the coder, three times at most, then to the lead, who
 * rewrites the brief once, then to the user. Everything is kept on the lead's thread, so the
 * sidebar, other devices and a restart all see the same state.
 */
export class Teams {
  private readonly host: TeamHost;
  private closed = false;
  /** Checks being started, which read the changes first. */
  private readonly starting = new Set<Promise<void>>();
  /** The push under way for each team, by its lead. */
  private readonly shipping = new Map<string, Promise<void>>();

  constructor(host: TeamHost) {
    this.host = host;
  }

  /** Keeps the team, and in its timeline what changed. */
  private save(leadId: string, team: Team): void {
    const before = this.host.thread(leadId)?.team?.phase;
    this.host.setTeam(leadId, recordTimeline(team, Date.now()));
    // Done, the team ends the way a cloud agent does: with its pull request open.
    if (team.phase === "done" && before !== "done" && team.autoShip !== false && shipTarget(team))
      this.ship(leadId).catch(() => {});
  }

  /**
   * Pushes the branch that holds the team's work, the merge's or its only piece's, and
   * opens its pull request with the user's `gh`. One push at a time per team: a second ask
   * meanwhile waits on the first. What went wrong is kept on the team.
   */
  ship(leadId: string): Promise<void> {
    const pending = this.shipping.get(leadId);
    if (pending) return pending;
    const team = this.host.thread(leadId)?.team;
    if (!team || team.phase !== "done") {
      return Promise.reject(new Error("L'équipe n'a pas fini : rien à envoyer pour l'instant."));
    }
    const target = shipTarget(team);
    if (!target) {
      return Promise.reject(
        new Error("Rien à envoyer : cette équipe n'a pas de branche qui réunit son travail."),
      );
    }
    const { shipError: _error, ...fresh } = team;
    this.host.setTeam(leadId, { ...fresh, shipping: true });
    const settle = (change: (team: Team) => Team) => {
      const now = this.host.thread(leadId)?.team;
      if (!now) return;
      const { shipping: _shipping, shipError: _old, ...rest } = now;
      this.host.setTeam(leadId, change(rest));
    };
    const work = this.host
      .ship(target, team.task, team.task, prBody(team))
      .then(
        (result) =>
          settle((rest) => ({
            ...rest,
            shipped: {
              ...(result.url ? { url: result.url } : {}),
              opened: result.prOpened,
              ...(result.prError ? { note: cut(result.prError) } : {}),
            },
          })),
        (error: unknown) => settle((rest) => ({ ...rest, shipError: cut(message(error)) })),
      )
      .finally(() => this.shipping.delete(leadId));
    this.shipping.set(leadId, work);
    this.track(work);
    return work;
  }

  /** The access the team's agents get from now on, set from its lead. */
  setPermissionMode(leadId: string, permissionMode: PermissionMode): void {
    const team = this.host.thread(leadId)?.team;
    if (team && team.permissionMode !== permissionMode)
      this.save(leadId, { ...team, permissionMode });
  }

  /**
   * A mission the user adds while the team plans or codes: the lead reads it once free, and
   * puts it in its plan as new pieces.
   */
  addMission(leadId: string, text: string): void {
    const lead = this.host.thread(leadId);
    const team = lead?.team;
    if (!lead || !team) throw new Error("Ce fil ne mène pas d'équipe.");
    if (team.phase !== "planning" && team.phase !== "coding") {
      throw new Error(
        team.phase === "merging"
          ? "L'équipe fusionne déjà son travail : lance une nouvelle équipe pour cette mission."
          : "L'équipe ne travaille plus : relance-la ou lance une nouvelle équipe.",
      );
    }
    const missions = team.missions ?? [];
    if (missions.length >= MAX_MISSIONS) throw new Error("Cette équipe a déjà assez de missions.");
    const next: Team = {
      ...team,
      missions: [...missions, { text: text.trim(), at: Date.now(), status: "waiting" }],
    };
    // While it plans, the lead reads the mission once its plan is made.
    if (team.phase === "planning") this.save(leadId, next);
    else this.settle(lead, next);
  }

  /** Starts the team; returns the lead's thread. */
  start(input: TeamInput): string {
    const team: Team = {
      phase: "planning",
      task: input.task,
      coder: input.coder,
      ...(input.reviewer ? { reviewer: input.reviewer } : {}),
      ...(input.reviewer && input.reviewer2 ? { reviewer2: input.reviewer2 } : {}),
      ...(input.reviewer && input.judge ? { judge: input.judge } : {}),
      ...(input.tester ? { tester: input.tester } : {}),
      ...(input.merger ? { merger: input.merger } : {}),
      coders: input.coders,
      permissionMode: input.permissionMode,
      ...(input.autoShip === false ? { autoShip: false } : {}),
      tasks: [],
      timeline: [{ at: Date.now(), lane: LEAD_LANE, phase: "planning" }],
    };
    // Planning only reads: the lead asks before touching anything.
    return this.host.createThread({
      projectId: input.projectId,
      agentId: input.lead.agentId,
      model: input.lead.model,
      permissionMode: "supervised",
      isolated: false,
      text: planPrompt(input.task, input.coders),
      title: `Équipe : ${input.task}`,
      role: "lead",
      team,
      ...(input.openedBy ? { openedBy: input.openedBy } : {}),
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    });
  }

  /**
   * Whether the thread leads a team still at work, or is one of its threads: it then cannot
   * be put away, as its reviewer or tester may be working in its folder.
   */
  isActive(threadId: string): boolean {
    const thread = this.host.thread(threadId);
    if (!thread) return false;
    return (
      active(thread.team) || (!!thread.parentId && active(this.host.thread(thread.parentId)?.team))
    );
  }

  /** Resolves once the checks being started have started. */
  async settled(): Promise<void> {
    while (this.starting.size) await Promise.all(this.starting);
  }

  /** Nothing new starts from here on: the server is stopping. */
  close(): void {
    this.closed = true;
  }

  async stop(leadId: string): Promise<void> {
    const lead = this.host.thread(leadId);
    const team = lead?.team;
    if (!lead || !team) throw new Error("Ce fil ne mène pas d'équipe.");
    if (!active(team)) return;
    const running = team.tasks.flatMap((t) => runningThread(t) ?? []);
    if (team.mergeStep !== undefined && team.mergeThreadId) running.push(team.mergeThreadId);
    this.save(leadId, { ...cutShort(team), phase: "stopped" });
    await Promise.all([this.host.cancel(leadId), ...running.map((id) => this.host.cancel(id))]);
  }

  /** A team cut short by a stop of the server is marked so, with what was done kept. */
  recover(): void {
    for (const thread of this.host.threads()) {
      // A push the stop cut off is said so, to be tried again.
      if (thread.team?.shipping) {
        const { shipping: _shipping, ...rest } = thread.team;
        this.host.setTeam(thread.id, {
          ...rest,
          shipError: "L'envoi a été coupé par l'arrêt de MoonAgentic : réessaie.",
        });
      }
      if (!thread.team || !active(thread.team)) continue;
      this.save(thread.id, {
        ...cutShort(thread.team),
        phase: "stopped",
        error: "Interrompue par l'arrêt de MoonAgentic.",
      });
    }
  }

  /**
   * Starts a piece again once the user has looked at it: its coder picks it up where it is,
   * then it is checked as usual, its tries counted from zero.
   */
  async retry(leadId: string, index: number | undefined): Promise<void> {
    const lead = this.host.thread(leadId);
    const team = lead?.team;
    if (!lead || !team) throw new Error("Ce fil ne mène pas d'équipe.");
    if (index === undefined) return this.retryMerge(lead, team);
    const task = team.tasks[index];
    if (!task) throw new Error("Cette sous-tâche n'existe pas.");
    if (task.status !== "blocked" && task.status !== "failed" && task.status !== "stopped") {
      throw new Error("Cette sous-tâche est déjà en cours ou terminée.");
    }
    if (team.phase === "planning") throw new Error("Le chef prépare encore le plan.");
    const { note: _note, reasked: _reasked, reasked2: _r2, verdicts: _v, ...rest } = task;
    let fresh: TeamTask = { ...rest, tries: 0, leadHelped: false, status: "waiting" };
    if (task.threadId && !this.host.thread(task.threadId)) {
      // Its coder's thread was deleted: the piece starts over with a new coder, and new
      // reviewer and tester, whose folder would have been the old coder's.
      const {
        threadId: _c,
        reviewThreadId: _r,
        review2ThreadId: _r2b,
        judgeThreadId: _j,
        testThreadId: _t,
        ...gone
      } = fresh;
      fresh = gone;
    }
    if (fresh.threadId) {
      // Throws while the user is still talking to the coder, and then nothing changes.
      this.host.send(fresh.threadId, RESUME_PROMPT);
      fresh.status = "running";
    }
    const { error: _error, ...kept } = team;
    this.settle(lead, withTask({ ...kept, phase: "coding" }, index, fresh));
  }

  /** Moves the team on when one of its threads ends a turn. */
  turnEnded(threadId: string, cancelled: boolean): void {
    const thread = this.host.thread(threadId);
    if (!thread) return;
    if (thread.role === "lead" && thread.team) {
      if (thread.team.phase === "planning") this.planned(thread, thread.team, cancelled);
      else if (thread.team.phase === "coding") this.leadAnswered(thread, thread.team, cancelled);
      return;
    }
    if (!thread.parentId || !thread.role) return;
    const lead = this.host.thread(thread.parentId);
    const team = lead?.team;
    if (lead && team?.phase === "merging" && thread.role === "merger") {
      this.mergerAnswered(lead, team, thread, cancelled);
      return;
    }
    if (!lead || !team || team.phase !== "coding") return;
    const role = thread.role;
    const index = team.tasks.findIndex(
      (t) =>
        (role === "coder" && t.threadId === threadId && t.status === "running") ||
        (role === "reviewer" && t.reviewThreadId === threadId && t.status === "reviewing") ||
        (role === "reviewer2" && t.review2ThreadId === threadId && t.status === "reviewing") ||
        (role === "judge" && t.judgeThreadId === threadId && t.status === "judging") ||
        (role === "tester" && t.testThreadId === threadId && t.status === "testing"),
    );
    const task = team.tasks[index];
    if (!task) return;
    const put = (next: TeamTask) => withTask(team, index, next);
    const failure = `s'est arrêté sur une erreur : ${thread.error ?? "erreur inconnue"}`;
    if (cancelled) {
      this.settle(lead, put({ ...task, status: "stopped" }));
    } else if (role === "coder") {
      this.settle(
        lead,
        thread.status === "error"
          ? this.problem(team, index, `Le codeur ${failure}`)
          : this.next(lead.id, team, index, "coder"),
      );
    } else {
      const who =
        role === "reviewer"
          ? team.reviewer2
            ? "Le premier relecteur"
            : "Le relecteur"
          : role === "reviewer2"
            ? "Le second relecteur"
            : role === "judge"
              ? "L'arbitre"
              : "Le testeur";
      this.settle(lead, this.verdict(lead.id, team, index, thread, who, failure));
    }
  }

  /** What the reviewer's or tester's answer makes of the piece. */
  private verdict(
    leadId: string,
    team: Team,
    index: number,
    thread: Thread,
    who: string,
    failure: string,
  ): Team {
    const task = team.tasks[index]!;
    const put = (next: TeamTask) => withTask(team, index, next);
    const role = thread.role!;
    if (thread.status === "error") {
      const { verdicts: _v, ...rest } = task;
      return put({ ...rest, status: "blocked", note: `${who} ${failure}` });
    }
    const reply = this.host.lastReply(thread.id);
    const second = role === "reviewer2";
    const { reasked: _reasked, reasked2: _reasked2, ...unasked } = task;
    // Only its own question asked again is forgotten: the other reviewer may still owe one.
    const checked: TeamTask = second
      ? { ...unasked, ...(task.reasked ? { reasked: true } : {}) }
      : { ...unasked, ...(task.reasked2 ? { reasked2: true } : {}) };
    const verdict = readVerdict(reply);
    if (!verdict) {
      if (second ? task.reasked2 : task.reasked) {
        const { verdicts: _v, ...rest } = task;
        return put({ ...rest, status: "blocked", note: `${who} n'a pas donné de verdict.` });
      }
      try {
        this.host.send(thread.id, VERDICT_AGAIN);
        return put(second ? { ...task, reasked2: true } : { ...task, reasked: true });
      } catch (error) {
        return put({ ...task, status: "blocked", note: message(error) });
      }
    }
    if (role !== "reviewer" && role !== "reviewer2") {
      return verdict === "ok"
        ? this.next(leadId, put(checked), index, role)
        : this.problem(put(checked), index, `${who} demande des corrections :\n\n${reply}`);
    }
    // A review: once every reviewer has given its verdict, the judge weighs any remark.
    const reviewers = reviewRoles(team);
    const verdicts = { ...checked.verdicts, [role]: verdict };
    if (reviewers.some((r) => !verdicts[r])) return put({ ...checked, verdicts });
    const { verdicts: _done, ...reviewed } = checked;
    const fixes = reviewers.filter((r) => verdicts[r] === "fix");
    if (!fixes.length) return this.next(leadId, put(reviewed), index, "reviewer");
    if (team.judge) {
      this.check(leadId, index, "judge");
      return put({ ...reviewed, status: "judging" });
    }
    const notes = fixes.map((r) => {
      const id = r === "reviewer" ? task.reviewThreadId : task.review2ThreadId;
      const name = r === role ? who : reviewers.length > 1 ? REVIEWER_NAME[r] : who;
      return `${name} demande des corrections :\n\n${r === role ? reply : id ? this.host.lastReply(id) : ""}`;
    });
    return this.problem(put(reviewed), index, notes.join("\n\n"));
  }

  private planned(lead: Thread, team: Team, cancelled: boolean): void {
    if (cancelled) {
      this.save(lead.id, { ...team, phase: "stopped" });
      return;
    }
    if (lead.status === "error") {
      this.save(lead.id, {
        ...team,
        phase: "failed",
        error: `Le chef n'a pas pu faire le plan : ${lead.error ?? "erreur inconnue"}`,
      });
      return;
    }
    const plan = readPlan(this.host.lastReply(lead.id));
    if (!plan) {
      const tries = (team.planTries ?? 0) + 1;
      if (tries > MAX_PLAN_TRIES) {
        this.save(lead.id, {
          ...team,
          phase: "failed",
          planTries: tries,
          error: "Le chef n'a pas donné de plan lisible.",
        });
        return;
      }
      try {
        this.host.send(
          lead.id,
          'Je n\'ai pas trouvé ton plan. Réponds seulement avec le bloc json demandé : {"tasks": [{"title": "…", "brief": "…"}]}',
        );
        this.save(lead.id, { ...team, planTries: tries });
      } catch (error) {
        this.save(lead.id, {
          ...team,
          phase: "failed",
          planTries: tries,
          error: message(error),
        });
      }
      return;
    }
    const tasks: TeamTask[] = plan.map((p) => ({ ...p, status: "waiting" }));
    this.settle(lead, { ...team, phase: "coding", tasks });
  }

  /** The lead's turn while the team codes: the brief it rewrote, or a turn of the user's. */
  private leadAnswered(lead: Thread, team: Team, cancelled: boolean): void {
    if (team.leadMission !== undefined) {
      this.missionAnswered(lead, team, cancelled);
      return;
    }
    const index = team.leadTask;
    const { leadTask: _done, ...free } = team;
    const task = index === undefined ? undefined : team.tasks[index];
    if (index === undefined || task?.status !== "lead") {
      // The user talked to the lead: it is free again for a piece waiting on it.
      this.settle(lead, free);
      return;
    }
    const put = (next: TeamTask) => withTask(free, index, next);
    if (cancelled) {
      this.settle(lead, put({ ...task, status: "stopped" }));
      return;
    }
    const brief = lead.status === "error" ? undefined : readBrief(this.host.lastReply(lead.id));
    if (!brief) {
      const note =
        lead.status === "error"
          ? `Le chef s'est arrêté sur une erreur : ${lead.error ?? "erreur inconnue"}`
          : "Le chef n'a pas donné de nouvelle consigne.";
      this.settle(lead, put({ ...task, status: "blocked", note }));
      return;
    }
    const helped: TeamTask = { ...task, brief, leadHelped: true };
    try {
      this.host.send(task.threadId!, briefPrompt(brief));
      this.settle(lead, put({ ...helped, status: "running" }));
    } catch (error) {
      this.settle(lead, put({ ...helped, status: "blocked", note: message(error) }));
    }
  }

  /** The lead's answer to a mission: its new pieces join the plan, waiting for a coder. */
  private missionAnswered(lead: Thread, team: Team, cancelled: boolean): void {
    const { leadMission: index, ...free } = team;
    const missions = team.missions ?? [];
    const mission = index === undefined ? undefined : missions[index];
    if (index === undefined || mission?.status !== "reading") {
      this.settle(lead, free);
      return;
    }
    const put = (next: TeamMission, tasks = free.tasks) =>
      this.settle(lead, { ...free, tasks, missions: missions.with(index, next) });
    if (cancelled) return put({ ...mission, status: "stopped" });
    if (lead.status === "error") {
      return put({
        ...mission,
        status: "failed",
        note: `Le chef s'est arrêté sur une erreur : ${lead.error ?? "erreur inconnue"}`,
      });
    }
    const plan = readPlan(this.host.lastReply(lead.id), true);
    if (!plan) {
      return put({ ...mission, status: "failed", note: "Le chef n'a pas donné de plan lisible." });
    }
    const room = Math.max(0, MAX_TEAM_TASKS - free.tasks.length);
    const added: TeamTask[] = plan.slice(0, room).map((p) => ({ ...p, status: "waiting" }));
    const { note: _note, ...read } = mission;
    put(
      {
        ...read,
        status: "planned",
        added: added.length,
        ...(plan.length > room ? { note: "L'équipe a déjà assez de sous-tâches." } : {}),
      },
      [...free.tasks, ...added],
    );
  }

  /** What follows a step of a piece that went well: the review, the tests, or done. */
  private next(leadId: string, team: Team, index: number, after: TeamRole): Team {
    const task = team.tasks[index]!;
    if (after === "coder" && team.reviewer) {
      for (const role of reviewRoles(team)) this.check(leadId, index, role);
      const { verdicts: _v, ...fresh } = task;
      return withTask(team, index, { ...fresh, status: "reviewing" });
    }
    if (after !== "tester" && team.tester) {
      this.check(leadId, index, "tester");
      return withTask(team, index, { ...task, status: "testing" });
    }
    const { note: _note, ...done } = task;
    return withTask(team, index, { ...done, status: "done" });
  }

  /** Something to fix: back to the coder, then to the lead once, then to the user. */
  private problem(team: Team, index: number, notes: string): Team {
    const task = team.tasks[index]!;
    const put = (next: TeamTask) => withTask(team, index, next);
    const note = cut(notes);
    const tries = (task.tries ?? 0) + 1;
    if (tries <= MAX_TRIES) {
      try {
        this.host.send(task.threadId!, fixPrompt(tries, note));
        return put({ ...task, status: "running", tries, note });
      } catch (error) {
        return put({ ...task, status: "blocked", note: `${note}\n\n${message(error)}` });
      }
    }
    return put({ ...task, status: task.leadHelped ? "blocked" : "lead", note });
  }

  /**
   * Has the reviewer or the tester look at the piece, in its coder's folder. Their thread
   * is made on the first check and reused for the next ones, so they remember the last.
   */
  private check(leadId: string, index: number, role: CheckRole): void {
    const how = CHECKS[role];
    const now = () => {
      const lead = this.host.thread(leadId);
      const task = lead?.team?.tasks[index];
      // The team may have moved on meanwhile: a stop, or the server stopping.
      return !this.closed && lead?.team?.phase === "coding" && task?.status === how.status
        ? { lead, team: lead.team, task }
        : undefined;
    };
    const work = (async () => {
      // After the caller has saved the piece's new status.
      await Promise.resolve();
      const before = now();
      if (!before?.task.threadId) return;
      const reviews = role === "reviewer" || role === "reviewer2";
      const diff = reviews ? diffText(await this.host.changes(before.task.threadId)) : "";
      const current = now();
      if (!current) return;
      const { lead, team, task } = current;
      const member = team[role];
      if (!member) throw new Error("ce rôle n'a pas d'agent.");
      const text = reviews
        ? reviewPrompt(team, task, diff)
        : role === "judge"
          ? judgePrompt(
              team,
              task,
              [task.reviewThreadId, task.review2ThreadId].flatMap((id) =>
                id ? [this.host.lastReply(id)] : [],
              ),
            )
          : testPrompt(team, task);
      const existing = task[how.field];
      // A thread the user deleted is made again.
      if (existing && this.host.thread(existing)) {
        this.host.send(existing, text);
        return;
      }
      const threadId = this.host.createThread({
        projectId: lead.projectId,
        agentId: member.agentId,
        model: member.model,
        // The team's access; a reviewer still asks before changing a file (see the hub).
        permissionMode: team.permissionMode,
        isolated: false,
        text,
        title: `${how.title} : ${task.title}`,
        parentId: lead.id,
        role,
        worksIn: task.threadId!,
      });
      const after = this.host.thread(leadId)?.team;
      const latest = after?.tasks[index];
      if (after && latest) {
        this.save(leadId, withTask(after, index, { ...latest, [how.field]: threadId }));
      }
    })().catch((error: unknown) => {
      const current = now();
      if (!current) return;
      const { verdicts: _v, ...task } = current.task;
      this.settle(
        current.lead,
        withTask(current.team, index, {
          ...task,
          status: "blocked",
          note: `${how.what} n'a pas pu commencer : ${message(error)}`,
        }),
      );
    });
    this.track(work);
  }

  /**
   * Starts coders on waiting pieces while places are free, hands the lead the next piece
   * that waits on it, and ends the team once nothing is left to do.
   */
  private settle(lead: Thread, team: Team): void {
    let tasks = team.tasks;
    let running = tasks.filter(working).length;
    for (const [i, piece] of tasks.entries()) {
      if (running >= team.coders) break;
      if (piece.status !== "waiting") continue;
      let threadId: string;
      try {
        threadId = this.host.createThread({
          projectId: lead.projectId,
          agentId: team.coder.agentId,
          model: team.coder.model,
          permissionMode: team.permissionMode,
          isolated: true,
          text: coderPrompt(team.task, piece),
          title: piece.title,
          parentId: lead.id,
          role: "coder",
        });
      } catch (error) {
        tasks = tasks.with(i, { ...piece, status: "failed", note: message(error) });
        team = { ...team, error: message(error) };
        continue;
      }
      tasks = tasks.with(i, { ...piece, status: "running", threadId });
      running += 1;
    }
    // The lead rewrites one brief at a time; the others wait their turn.
    let leadTask = team.leadTask;
    if (leadTask === undefined && team.leadMission === undefined) {
      const waiting = tasks.findIndex((t) => t.status === "lead");
      const task = tasks[waiting];
      if (task) {
        try {
          this.host.send(lead.id, leadHelpPrompt(task));
          leadTask = waiting;
        } catch (error) {
          // The user is talking to the lead: it gets the piece when that turn ends. Anything
          // else would leave it waiting forever, so it goes to the user.
          const status = this.host.thread(lead.id)?.status;
          if (status !== "running" && status !== "waiting") {
            tasks = tasks.with(waiting, {
              ...task,
              status: "blocked",
              note: `Le chef n'a pas pu revoir la consigne : ${message(error)}\n\n${task.note ?? ""}`.trim(),
            });
          }
        }
      }
    }
    // Then the missions the user added, one at a time too.
    let missions = team.missions;
    let leadMission = team.leadMission;
    if (leadTask === undefined && leadMission === undefined && missions) {
      const waiting = missions.findIndex((m) => m.status === "waiting");
      const mission = missions[waiting];
      if (mission) {
        try {
          this.host.send(lead.id, missionPrompt({ ...team, tasks }, mission));
          leadMission = waiting;
          missions = missions.with(waiting, { ...mission, status: "reading" });
        } catch (error) {
          // As above: busy with the user, the lead reads it once that turn ends.
          const status = this.host.thread(lead.id)?.status;
          if (status !== "running" && status !== "waiting") {
            missions = missions.with(waiting, {
              ...mission,
              status: "failed",
              note: `Le chef n'a pas pu lire la mission : ${message(error)}`,
            });
          }
        }
      }
    }
    const { leadTask: _old, leadMission: _oldMission, missions: _missions, ...rest } = team;
    const failed = tasks.filter((t) => t.status === "failed").length;
    this.save(lead.id, {
      ...rest,
      tasks,
      ...(missions ? { missions } : {}),
      ...(leadTask === undefined ? {} : { leadTask }),
      ...(leadMission === undefined ? {} : { leadMission }),
      ...(tasks.some(open) || missions?.some(unread)
        ? {}
        : tasks.some((t) => t.status === "blocked")
          ? { phase: "blocked" }
          : failed
            ? {
                phase: "failed",
                error:
                  team.error ??
                  `${failed} sous-tâche${failed > 1 ? "s ont" : " a"} échoué : ouvre ${failed > 1 ? "leurs fils" : "son fil"} pour voir pourquoi.`,
              }
            : tasks.some((t) => t.status === "stopped")
              ? { phase: "stopped" }
              : mergeable({ ...team, tasks })
                ? { phase: "merging" }
                : { phase: "done" }),
    });
    if (this.host.thread(lead.id)?.team?.phase === "merging") this.merge(lead.id);
  }

  /** Runs `work` in the background, kept until done so a server stopping waits for it. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work.finally(() => this.starting.delete(tracked));
    this.starting.add(tracked);
  }

  /**
   * Merges each done piece's branch onto one branch, in a thread of its own the user can
   * review and ship. A conflict goes to the merger, or to the user without one; once all
   * are merged, the merger checks that the pieces work together.
   */
  private merge(leadId: string): void {
    // The team as it is now, while it still merges.
    const now = () => {
      const lead = this.host.thread(leadId);
      return !this.closed && lead?.team?.phase === "merging"
        ? { lead, team: lead.team }
        : undefined;
    };
    const work = async () => {
      // After the caller has saved the team's new phase.
      await Promise.resolve();
      let state = now();
      if (!state) return;
      let into = state.team.mergeThreadId;
      if (!into || !this.host.thread(into)) {
        const member = state.team.merger ?? state.team.coder;
        into = this.host.createThread({
          projectId: state.lead.projectId,
          agentId: member.agentId,
          model: member.model,
          permissionMode: state.team.permissionMode,
          isolated: true,
          text: "",
          title: `Fusion : ${state.team.task}`,
          parentId: leadId,
          role: "merger",
        });
        // A new branch has none of the pieces, even those merged on one since deleted.
        this.save(leadId, {
          ...state.team,
          mergeThreadId: into,
          tasks: state.team.tasks.map(({ merged: _merged, ...t }) => t),
        });
      }
      for (;;) {
        state = now();
        if (!state) return;
        const index = state.team.tasks.findIndex((t) => !t.merged);
        const task = state.team.tasks[index];
        if (!task) break;
        const conflicts = await this.host.mergeInto(into, task.threadId!, task.title);
        state = now();
        if (!state) return;
        const { team } = state;
        if (!conflicts.length) {
          this.save(leadId, withTask(team, index, { ...team.tasks[index]!, merged: true }));
          continue;
        }
        if (team.merger) {
          this.host.send(into, conflictPrompt(task, conflicts));
          this.save(leadId, { ...team, mergeStep: index });
        } else {
          this.save(leadId, {
            ...team,
            phase: "blocked",
            error: `Conflit en fusionnant « ${task.title} » (${conflicts.join(", ")}) : règle-le dans le fil de fusion et fais le commit, puis relance la fusion.`,
          });
        }
        return;
      }
      if (state.team.merger) {
        this.host.send(into, mergeCheckPrompt(state.team));
        this.save(leadId, { ...state.team, mergeStep: -1 });
        return;
      }
      const { error: _error, ...done } = state.team;
      this.save(leadId, { ...done, phase: "done" });
    };
    this.track(
      work().catch((error: unknown) => {
        const state = now();
        if (!state) return;
        const { mergeStep: _step, ...rest } = state.team;
        this.save(leadId, {
          ...rest,
          phase: "blocked",
          error: `La fusion s'est arrêtée : ${message(error)}`,
        });
      }),
    );
  }

  /** The merger's turn: a conflict it settled, or its check of the pieces together. */
  private mergerAnswered(lead: Thread, team: Team, merger: Thread, cancelled: boolean): void {
    const step = team.mergeStep;
    // A turn of the user's in the merge thread moves nothing.
    if (step === undefined || team.mergeThreadId !== merger.id) return;
    const { mergeStep: _step, mergeReasked: _reasked, ...rest } = team;
    if (cancelled) {
      this.save(lead.id, { ...rest, phase: "stopped" });
      return;
    }
    const block = (error: string) =>
      this.save(lead.id, { ...rest, phase: "blocked", error: cut(error) });
    if (merger.status === "error") {
      block(`Le fusionneur s'est arrêté sur une erreur : ${merger.error ?? "erreur inconnue"}`);
      return;
    }
    if (step === -1) {
      const reply = this.host.lastReply(merger.id);
      const verdict = readVerdict(reply);
      if (verdict === "ok") this.save(lead.id, { ...rest, phase: "done" });
      else if (verdict === undefined && !team.mergeReasked) {
        // Asked once again, as the reviewer and the tester are.
        try {
          this.host.send(merger.id, VERDICT_AGAIN);
          this.save(lead.id, { ...team, mergeReasked: true });
        } catch (error) {
          block(message(error));
        }
      } else if (verdict === undefined) block("Le fusionneur n'a pas donné de verdict.");
      else block(`Le fusionneur signale un problème : ouvre le fil de fusion.\n\n${reply}`);
      return;
    }
    // Still merging, without a step: a stop meanwhile is not undone.
    this.save(lead.id, rest);
    const piece = team.tasks[step];
    this.track(
      (async () => {
        const left = await this.host.unfinishedMerge(merger.id);
        // A merge given up (`git merge --abort`) leaves no merge under way either: the
        // piece counts only once its branch is really part of the merge's.
        const merged =
          !left && !!piece?.threadId && (await this.host.contains(merger.id, piece.threadId));
        return { left, merged };
      })().then(
        ({ left, merged }) => {
          const now = this.host.thread(lead.id)?.team;
          if (this.closed || now?.phase !== "merging") return;
          const task = now.tasks[step];
          if (!merged || !task) {
            this.save(lead.id, {
              ...now,
              phase: "blocked",
              error: left
                ? `Le fusionneur n'a pas fini de fusionner « ${task?.title ?? "?"} » : règle la fusion dans son fil, puis relance-la.`
                : `La branche de « ${task?.title ?? "?"} » n'a pas été fusionnée (fusion abandonnée ?) : relance la fusion.`,
            });
            return;
          }
          this.save(lead.id, withTask(now, step, { ...task, merged: true }));
          this.merge(lead.id);
        },
        (error: unknown) => block(`La fusion s'est arrêtée : ${message(error)}`),
      ),
    );
  }

  /** Starts the merge again once the user has settled what stopped it. */
  private async retryMerge(lead: Thread, team: Team): Promise<void> {
    if (!mergeable(team)) {
      throw new Error("Il n'y a rien à fusionner : chaque sous-tâche doit d'abord être terminée.");
    }
    if (active(team) || team.phase === "done")
      throw new Error("La fusion est déjà en cours ou faite.");
    const into = team.mergeThreadId;
    const left = into && this.host.thread(into) ? await this.host.unfinishedMerge(into) : undefined;
    if (left?.length) {
      throw new Error(
        `Il reste des conflits dans ${left.join(", ")} : règle-les dans le fil de fusion.`,
      );
    }
    if (left)
      throw new Error("La fusion en cours attend son commit : fais-le dans le fil de fusion.");
    const fresh = this.host.thread(lead.id)?.team;
    if (!fresh || active(fresh)) return;
    const { error: _error, mergeStep: _step, mergeReasked: _reasked, ...rest } = fresh;
    this.save(lead.id, { ...rest, phase: "merging" });
    this.merge(lead.id);
  }
}
