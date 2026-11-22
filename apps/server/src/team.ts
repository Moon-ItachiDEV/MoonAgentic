import type { PermissionMode, Team, TeamMember, TeamTask, Thread } from "@moonagentic/protocol";

/** Pieces of work a lead may hand out, so a plan never floods the machine with agents. */
const MAX_TASKS = 8;
/** Times the lead is asked again for a plan that could not be read. */
const MAX_PLAN_TRIES = 2;

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
    role: "lead" | "coder";
    /** Given at creation, so the thread is never seen without its team. */
    team?: Team;
  }): string;
  send(threadId: string, text: string): void;
  cancel(threadId: string): Promise<void>;
  setTeam(threadId: string, team: Team): void;
  /** Everything the agent said in the thread's last turn. */
  lastReply(threadId: string): string;
}

export interface TeamInput {
  projectId: string;
  task: string;
  lead: TeamMember;
  coder: TeamMember;
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

/** Reads the lead's plan from the last JSON block of its reply, or undefined. */
export function readPlan(reply: string): { title: string; brief: string }[] | undefined {
  const blocks = [...reply.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map(
    (m) => m[1] ?? "",
  );
  // A bare object works too, for an agent that left the fence out, however it is laid out
  // and whatever it wrote after it.
  const bare = [...reply.matchAll(/\{\s*"tasks"\s*:/g)]
    .map((m) => objectAt(reply, m.index))
    .filter((raw): raw is string => raw !== undefined);
  for (const raw of [...blocks.reverse(), ...bare.reverse()]) {
    try {
      const parsed = JSON.parse(raw.trim()) as { tasks?: unknown };
      if (!Array.isArray(parsed.tasks)) continue;
      const tasks = parsed.tasks.flatMap((t: unknown) => {
        if (typeof t !== "object" || t === null) return [];
        const { title, brief } = t as { title?: unknown; brief?: unknown };
        if (typeof title !== "string" || typeof brief !== "string") return [];
        if (!title.trim() || !brief.trim()) return [];
        return [{ title: title.trim().slice(0, 120), brief: brief.trim().slice(0, 20_000) }];
      });
      if (tasks.length) return tasks.slice(0, MAX_TASKS);
    } catch {
      // Not this block.
    }
  }
  return undefined;
}

const active = (team: Team | undefined) => team?.phase === "planning" || team?.phase === "coding";

/**
 * Runs teams: the lead's thread plans, then each piece of the plan gets a coder's thread on
 * its own branch, a few at a time. Everything is kept on the lead's thread, so the sidebar,
 * other devices and a restart all see the same state.
 */
export class Teams {
  private readonly host: TeamHost;

  constructor(host: TeamHost) {
    this.host = host;
  }

  /** Starts the team; returns the lead's thread. */
  start(input: TeamInput): string {
    const team: Team = {
      phase: "planning",
      task: input.task,
      coder: input.coder,
      coders: input.coders,
      permissionMode: input.permissionMode,
      tasks: [],
    };
    // Planning only reads: the lead asks before touching anything.
    const leadId = this.host.createThread({
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
    return leadId;
  }

  /** Whether the thread leads a team still at work, which then cannot be put away. */
  isActive(threadId: string): boolean {
    return active(this.host.thread(threadId)?.team);
  }

  async stop(leadId: string): Promise<void> {
    const lead = this.host.thread(leadId);
    const team = lead?.team;
    if (!lead || !team) throw new Error("Ce fil ne mène pas d'équipe.");
    if (!active(team)) return;
    const running = team.tasks.filter((t) => t.status === "running" && t.threadId);
    this.host.setTeam(leadId, {
      ...team,
      phase: "stopped",
      tasks: team.tasks.map((t) =>
        t.status === "running" || t.status === "waiting" ? { ...t, status: "stopped" } : t,
      ),
    });
    await Promise.all([
      this.host.cancel(leadId),
      ...running.map((t) => this.host.cancel(t.threadId!)),
    ]);
  }

  /** A team cut short by a stop of the server is marked so, with what was done kept. */
  recover(): void {
    for (const thread of this.host.threads()) {
      if (!thread.team || !active(thread.team)) continue;
      this.host.setTeam(thread.id, {
        ...thread.team,
        phase: "stopped",
        error: "Interrompue par l'arrêt de MoonAgentic.",
        tasks: thread.team.tasks.map((t) =>
          t.status === "running" || t.status === "waiting" ? { ...t, status: "stopped" } : t,
        ),
      });
    }
  }

  /** Moves the team on when one of its threads ends a turn. */
  turnEnded(threadId: string, cancelled: boolean): void {
    const thread = this.host.thread(threadId);
    if (!thread) return;
    if (thread.role === "lead" && thread.team?.phase === "planning") {
      this.planned(thread, thread.team, cancelled);
    } else if (thread.role === "coder" && thread.parentId) {
      this.coded(thread, cancelled);
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
    this.launch(lead, { ...team, phase: "coding", tasks });
  }

  private coded(coder: Thread, cancelled: boolean): void {
    const lead = this.host.thread(coder.parentId!);
    const team = lead?.team;
    if (!lead || !team || team.phase !== "coding") return;
    const tasks = team.tasks.map((t): TeamTask => {
      if (t.threadId !== coder.id || t.status !== "running") return t;
      if (cancelled) return { ...t, status: "stopped" };
      return { ...t, status: coder.status === "error" ? "failed" : "done" };
    });
    this.launch(lead, { ...team, tasks });
  }

  /** Starts coders on waiting pieces while fewer than allowed work; ends the team when all are done. */
  private launch(lead: Thread, team: Team): void {
    let tasks = team.tasks;
    let running = tasks.filter((t) => t.status === "running").length;
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
        tasks = tasks.with(i, { ...piece, status: "failed" });
        team = { ...team, error: error instanceof Error ? error.message : String(error) };
        continue;
      }
      tasks = tasks.with(i, { ...piece, status: "running", threadId });
      running += 1;
    }
    const open = tasks.some((t) => t.status === "running" || t.status === "waiting");
    const failed = tasks.filter((t) => t.status === "failed").length;
    const stopped = tasks.some((t) => t.status === "stopped");
    this.host.setTeam(lead.id, {
      ...team,
      tasks,
      ...(open
        ? {}
        : failed
          ? {
              phase: "failed",
              error:
                team.error ??
                `${failed} sous-tâche${failed > 1 ? "s ont" : " a"} échoué : ouvre ${failed > 1 ? "leurs fils" : "son fil"} pour voir pourquoi.`,
            }
          : { phase: stopped ? "stopped" : "done" }),
    });
  }
}
