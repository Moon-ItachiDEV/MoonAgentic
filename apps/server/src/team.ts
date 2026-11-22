import type {
  PermissionMode,
  ReviewFile,
  Team,
  TeamMember,
  TeamRole,
  TeamTask,
  Thread,
} from "@moonagentic/protocol";

/** Pieces of work a lead may hand out, so a plan never floods the machine with agents. */
const MAX_TASKS = 8;
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
  }): string;
  send(threadId: string, text: string): void;
  cancel(threadId: string): Promise<void>;
  setTeam(threadId: string, team: Team): void;
  /** Everything the agent said in the thread's last turn. */
  lastReply(threadId: string): string;
  /** What changed on the thread's branch since it started. */
  changes(threadId: string): Promise<{ files: ReviewFile[]; omitted?: number }>;
}

export interface TeamInput {
  projectId: string;
  task: string;
  lead: TeamMember;
  coder: TeamMember;
  reviewer?: TeamMember | undefined;
  tester?: TeamMember | undefined;
  coders: number;
  permissionMode: PermissionMode;
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

const briefPrompt = (brief: string) =>
  `Le chef a revu ta consigne. Reprends ta sous-tâche avec celle-ci :

${brief}

Quand tu as fini, résume ce que tu as changé.`;

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

/** Reads the lead's plan from the last JSON block of its reply, or undefined. */
export function readPlan(reply: string): { title: string; brief: string }[] | undefined {
  for (const parsed of jsonObjects(reply, "tasks")) {
    if (!Array.isArray(parsed.tasks)) continue;
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
  const last = [...reply.matchAll(/VERDICT\s*:?[\s*_]*(OK|[ÀA]\s+CORRIGER)/giu)].at(-1);
  if (!last) return undefined;
  return /^ok$/i.test(last[1] ?? "") ? "ok" : "fix";
}

/** The changes as one unified diff, cut down to what a reviewer can read at once. */
export function diffText(changes: { files: ReviewFile[]; omitted?: number }): string {
  let text = "";
  for (const file of changes.files) {
    const name = file.from ? `${file.from} → ${file.path}` : file.path;
    const head = `--- ${name} (${file.status}, +${file.added ?? "?"} -${file.removed ?? "?"})\n`;
    const body = file.patch ? file.patch.replace(/\n?$/, "\n") : "";
    if (file.truncated || text.length + head.length + body.length > DIFF_LIMIT) {
      text += `${head}(diff coupé : ouvre le fichier)\n`;
      continue;
    }
    text += head + body;
  }
  if (changes.omitted) text += `(${changes.omitted} autres fichiers changés, non montrés)\n`;
  return text.trimEnd();
}

const active = (team: Team | undefined) => team?.phase === "planning" || team?.phase === "coding";
/** A piece someone is working on, which takes one of the team's places. */
const working = (t: TeamTask) =>
  t.status === "running" ||
  t.status === "reviewing" ||
  t.status === "testing" ||
  t.status === "lead";
const open = (t: TeamTask) => t.status === "waiting" || working(t);
const cut = (text: string) => (text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}…` : text);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The thread a piece's agent works in at this point, if any. */
const runningThread = (t: TeamTask) =>
  t.status === "running"
    ? t.threadId
    : t.status === "reviewing"
      ? t.reviewThreadId
      : t.status === "testing"
        ? t.testThreadId
        : undefined;

/** The team with every piece at work cut short, what was done kept: a stop or a restart. */
const cutShort = (team: Team): Team => {
  const { leadTask: _lead, ...rest } = team;
  return { ...rest, tasks: team.tasks.map((t) => (open(t) ? { ...t, status: "stopped" } : t)) };
};

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

  constructor(host: TeamHost) {
    this.host = host;
  }

  /** Starts the team; returns the lead's thread. */
  start(input: TeamInput): string {
    const team: Team = {
      phase: "planning",
      task: input.task,
      coder: input.coder,
      ...(input.reviewer ? { reviewer: input.reviewer } : {}),
      ...(input.tester ? { tester: input.tester } : {}),
      coders: input.coders,
      permissionMode: input.permissionMode,
      tasks: [],
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
    });
  }

  /** Whether the thread leads a team still at work, which then cannot be put away. */
  isActive(threadId: string): boolean {
    return active(this.host.thread(threadId)?.team);
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
    this.host.setTeam(leadId, { ...cutShort(team), phase: "stopped" });
    await Promise.all([this.host.cancel(leadId), ...running.map((id) => this.host.cancel(id))]);
  }

  /** A team cut short by a stop of the server is marked so, with what was done kept. */
  recover(): void {
    for (const thread of this.host.threads()) {
      if (!thread.team || !active(thread.team)) continue;
      this.host.setTeam(thread.id, {
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
  retry(leadId: string, index: number): void {
    const lead = this.host.thread(leadId);
    const team = lead?.team;
    if (!lead || !team) throw new Error("Ce fil ne mène pas d'équipe.");
    const task = team.tasks[index];
    if (!task) throw new Error("Cette sous-tâche n'existe pas.");
    if (task.status !== "blocked" && task.status !== "failed" && task.status !== "stopped") {
      throw new Error("Cette sous-tâche est déjà en cours ou terminée.");
    }
    if (team.phase === "planning") throw new Error("Le chef prépare encore le plan.");
    const { note: _note, reasked: _reasked, ...rest } = task;
    const fresh: TeamTask = { ...rest, tries: 0, leadHelped: false, status: "waiting" };
    if (task.threadId) {
      // Throws while the user is still talking to the coder, and then nothing changes.
      this.host.send(task.threadId, RESUME_PROMPT);
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
    if (!lead || !team || team.phase !== "coding") return;
    const role = thread.role;
    const index = team.tasks.findIndex(
      (t) =>
        (role === "coder" && t.threadId === threadId && t.status === "running") ||
        (role === "reviewer" && t.reviewThreadId === threadId && t.status === "reviewing") ||
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
      const who = role === "reviewer" ? "Le relecteur" : "Le testeur";
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
    if (thread.status === "error")
      return put({ ...task, status: "blocked", note: `${who} ${failure}` });
    const reply = this.host.lastReply(thread.id);
    const { reasked: _reasked, ...checked } = task;
    switch (readVerdict(reply)) {
      case "ok":
        return this.next(leadId, put(checked), index, thread.role!);
      case "fix":
        return this.problem(put(checked), index, `${who} demande des corrections :\n\n${reply}`);
      default:
        if (task.reasked) {
          return put({ ...task, status: "blocked", note: `${who} n'a pas donné de verdict.` });
        }
        try {
          this.host.send(thread.id, VERDICT_AGAIN);
          return put({ ...task, reasked: true });
        } catch (error) {
          return put({ ...task, status: "blocked", note: message(error) });
        }
    }
  }

  private planned(lead: Thread, team: Team, cancelled: boolean): void {
    if (cancelled) {
      this.host.setTeam(lead.id, { ...team, phase: "stopped" });
      return;
    }
    if (lead.status === "error") {
      this.host.setTeam(lead.id, {
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
        this.host.setTeam(lead.id, {
          ...team,
          phase: "failed",
          planTries: tries,
          error: "Le chef n'a pas donné de plan lisible.",
        });
        return;
      }
      this.host.setTeam(lead.id, { ...team, planTries: tries });
      this.host.send(
        lead.id,
        'Je n\'ai pas trouvé ton plan. Réponds seulement avec le bloc json demandé : {"tasks": [{"title": "…", "brief": "…"}]}',
      );
      return;
    }
    const tasks: TeamTask[] = plan.map((p) => ({ ...p, status: "waiting" }));
    this.settle(lead, { ...team, phase: "coding", tasks });
  }

  /** The lead's turn while the team codes: the brief it rewrote, or a turn of the user's. */
  private leadAnswered(lead: Thread, team: Team, cancelled: boolean): void {
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

  /** What follows a step of a piece that went well: the review, the tests, or done. */
  private next(leadId: string, team: Team, index: number, after: TeamRole): Team {
    const task = team.tasks[index]!;
    if (after === "coder" && team.reviewer) {
      this.check(leadId, index, "reviewer");
      return withTask(team, index, { ...task, status: "reviewing" });
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
  private check(leadId: string, index: number, role: "reviewer" | "tester"): void {
    const status = role === "reviewer" ? "reviewing" : "testing";
    const now = () => {
      const lead = this.host.thread(leadId);
      const task = lead?.team?.tasks[index];
      // The team may have moved on meanwhile: a stop, or the server stopping.
      return !this.closed && lead?.team?.phase === "coding" && task?.status === status
        ? { lead, team: lead.team, task }
        : undefined;
    };
    const work = (async () => {
      // After the caller has saved the piece's new status.
      await Promise.resolve();
      const before = now();
      if (!before?.task.threadId) return;
      const diff =
        role === "reviewer" ? diffText(await this.host.changes(before.task.threadId)) : "";
      const current = now();
      if (!current) return;
      const { lead, team, task } = current;
      const member = role === "reviewer" ? team.reviewer : team.tester;
      if (!member) throw new Error("ce rôle n'a pas d'agent.");
      const text = role === "reviewer" ? reviewPrompt(team, task, diff) : testPrompt(team, task);
      const existing = role === "reviewer" ? task.reviewThreadId : task.testThreadId;
      if (existing) {
        this.host.send(existing, text);
        return;
      }
      const threadId = this.host.createThread({
        projectId: lead.projectId,
        agentId: member.agentId,
        model: member.model,
        // The reviewer only reads; the tester writes tests, with the coders' access.
        permissionMode: role === "reviewer" ? "supervised" : team.permissionMode,
        isolated: false,
        text,
        title: `${role === "reviewer" ? "Relecture" : "Tests"} : ${task.title}`,
        parentId: lead.id,
        role,
        worksIn: task.threadId!,
      });
      const after = this.host.thread(leadId)?.team;
      const latest = after?.tasks[index];
      if (after && latest) {
        this.host.setTeam(
          leadId,
          withTask(
            after,
            index,
            role === "reviewer"
              ? { ...latest, reviewThreadId: threadId }
              : { ...latest, testThreadId: threadId },
          ),
        );
      }
    })().catch((error: unknown) => {
      const current = now();
      if (!current) return;
      const what = role === "reviewer" ? "La relecture" : "Les tests";
      this.settle(
        current.lead,
        withTask(current.team, index, {
          ...current.task,
          status: "blocked",
          note: `${what} n'ont pas pu commencer : ${message(error)}`,
        }),
      );
    });
    const tracked: Promise<void> = work.finally(() => this.starting.delete(tracked));
    this.starting.add(tracked);
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
    if (leadTask === undefined) {
      const waiting = tasks.findIndex((t) => t.status === "lead");
      const task = tasks[waiting];
      if (task) {
        try {
          this.host.send(lead.id, leadHelpPrompt(task));
          leadTask = waiting;
        } catch {
          // The user is talking to the lead: it gets the piece when that turn ends.
        }
      }
    }
    const { leadTask: _old, ...rest } = team;
    const failed = tasks.filter((t) => t.status === "failed").length;
    this.host.setTeam(lead.id, {
      ...rest,
      tasks,
      ...(leadTask === undefined ? {} : { leadTask }),
      ...(tasks.some(open)
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
            : { phase: tasks.some((t) => t.status === "stopped") ? "stopped" : "done" }),
    });
  }
}
