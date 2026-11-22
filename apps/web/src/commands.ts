// The `/` commands the composer offers, and the `@` / `$` / `/` word being typed.
// Pure functions, so the priority rule between same-named commands is easy to test.
import type { AgentCommand, AgentInfo, AgentSetting, ProjectCommand } from "@moonagentic/protocol";

/** Things MoonAgentic does itself rather than send to the agent. */
export type AppAction =
  | "plan"
  | "agent"
  | "models"
  | "pin"
  | "export"
  | "search"
  | "requests"
  | "connections"
  | "settings"
  | "archive"
  | "delete"
  | "team"
  | "schedule";

/**
 * Where a command comes from, in priority order when two share a name: MoonAgentic's own
 * actions, then the project's commands, then the agent's, then MoonAgentic's ready-made
 * messages.
 */
export type CommandSource = "app" | "project" | "agent" | "template";

const PRIORITY: CommandSource[] = ["app", "project", "agent", "template"];

export interface ComposerCommand {
  name: string;
  description: string;
  source: CommandSource;
  /** Who offers it, shown beside it: MoonAgentic, the project, or the agent's name. */
  by: string;
  /** What to type after it. */
  hint?: string;
  /** The message a project command or a ready-made message stands for. */
  template?: string;
  action?: AppAction;
  /** Who else offers a command of that name, which this one takes the place of. */
  hides?: string[];
}

const TEMPLATES: { name: string; description: string; template: string }[] = [
  {
    name: "review",
    description: "Faire relire les changements de ce fil",
    template:
      "Relis les changements faits dans ce fil et signale les problèmes, du plus grave au moins grave. Ne modifie rien.",
  },
  {
    name: "test",
    description: "Lancer les tests et corriger ce qui échoue",
    template: "Lance la suite de tests du projet et corrige ce qui échoue.",
  },
  {
    name: "init",
    description: "Écrire AGENTS.md pour ce dépôt",
    template:
      "Analyse le dépôt et rédige un fichier AGENTS.md qui explique aux agents comment y travailler : structure, commandes, conventions.",
  },
];

/** The agent's plan mode, when it has one, and the mode it goes back to. */
export function planModes(
  settings: AgentSetting[] | undefined,
): { setting: AgentSetting; plan: string; normal: string } | undefined {
  const setting = settings?.find((s) => s.kind === "mode");
  if (!setting) return undefined;
  const plan = setting.choices.find((c) => /plan/i.test(c.id) || /plan/i.test(c.name));
  if (!plan) return undefined;
  // Back to the agent's usual mode, or to the first one that is not planning.
  const normal =
    setting.current !== plan.id
      ? setting.current
      : setting.choices.find((c) => c.id !== plan.id)?.id;
  return normal ? { setting, plan: plan.id, normal } : undefined;
}

/** Every command on offer, one per name, the winner of each name keeping who it hides. */
export function composerCommands(options: {
  agent: AgentInfo | undefined;
  /** The thread's own list, which beats the agent's last known one. */
  agentCommands: AgentCommand[] | undefined;
  projectCommands: ProjectCommand[];
  inThread: boolean;
}): ComposerCommand[] {
  const { agent, inThread } = options;
  const app: ComposerCommand[] = [];
  const add = (name: string, description: string, action: AppAction) =>
    app.push({ name, description, source: "app", by: "MoonAgentic", action });
  if (planModes(agent?.settings)) {
    add("plan", "Mode plan : l'agent propose avant de modifier", "plan");
    add("agent", "Revenir au mode habituel de l'agent", "agent");
  }
  add("modeles", "Choisir l'agent, le modèle et ses réglages", "models");
  add(
    "equipe",
    "Confier la tâche à une équipe : un chef découpe, des codeurs en parallèle",
    "team",
  );
  add("planifier", "Lancer une tâche plus tard, une fois ou à intervalles réguliers", "schedule");
  if (inThread) {
    add("epingler", "Épingler ou désépingler cette discussion", "pin");
    add("exporter", "Exporter cette discussion en Markdown", "export");
    add("archiver", "Archiver cette discussion et ranger sa copie de travail", "archive");
    add("supprimer", "Supprimer cette discussion (sa branche reste)", "delete");
  }
  add("chercher", "Chercher dans les fils et les messages (Ctrl K)", "search");
  add("demandes", "Voir ce que les agents attendent de toi", "requests");
  add("connexions", "Voir l'état des agents et les serveurs MCP", "connections");
  add("reglages", "Ouvrir les réglages de MoonAgentic", "settings");

  const all: ComposerCommand[] = [
    ...app,
    ...options.projectCommands.map((c): ComposerCommand => ({
      name: c.name,
      description: c.description,
      source: "project",
      by: "Projet",
      template: c.template,
      ...(c.template.includes("$ARGUMENTS") ? { hint: "arguments" } : {}),
    })),
    ...(options.agentCommands ?? agent?.commands ?? []).map((c): ComposerCommand => ({
      name: c.name,
      description: c.description,
      source: "agent",
      by: agent?.name ?? "Agent",
      ...(c.hint ? { hint: c.hint } : {}),
    })),
    ...TEMPLATES.map((t): ComposerCommand => ({ ...t, source: "template", by: "MoonAgentic" })),
  ];
  const byName = new Map<string, ComposerCommand>();
  for (const command of all.sort(
    (a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source),
  )) {
    const key = command.name.toLowerCase();
    const winner = byName.get(key);
    if (!winner) byName.set(key, command);
    else if (!winner.hides?.includes(command.by)) {
      byName.set(key, { ...winner, hides: [...(winner.hides ?? []), command.by] });
    }
  }
  return [...byName.values()];
}

/** The commands whose name starts with what was typed, then those containing it. */
export function matchCommands(commands: ComposerCommand[], typed: string): ComposerCommand[] {
  const q = typed.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = q
    ? commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q))
    : [];
  return [...starts, ...contains];
}

/** The message a command and what follows it stand for. */
export function fillTemplate(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", args).trim();
  return args ? `${template}\n\n${args}` : template;
}

export type Submission =
  { kind: "action"; action: AppAction; rest: string } | { kind: "send"; text: string };

/** What sending this text does: run one of MoonAgentic's actions, or send a message. */
export function resolveSubmission(text: string, commands: ComposerCommand[]): Submission {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command =
    match?.[1] && commands.find((c) => c.name.toLowerCase() === match[1]!.toLowerCase());
  if (!command) return { kind: "send", text };
  const args = (match[2] ?? "").trim();
  if (command.action) return { kind: "action", action: command.action, rest: args };
  if (command.template) return { kind: "send", text: fillTemplate(command.template, args) };
  return { kind: "send", text };
}

/** The `/`, `@` or `$` word the caret is in, with where it starts and ends. */
export interface Trigger {
  kind: "/" | "@" | "$";
  query: string;
  start: number;
  end: number;
}

export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const start =
    Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  const word = before.slice(start);
  const kind = word[0];
  if (kind !== "/" && kind !== "@" && kind !== "$") return null;
  // A command is the message's first word; a mention or a skill can be anywhere.
  if (kind === "/" && text.slice(0, start).trim()) return null;
  const query = word.slice(1);
  if (kind === "/" && query.includes("/")) return null;
  const after = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
  return { kind, query, start, end: caret + after.length };
}

/** Puts `value` in place of the trigger's word, followed by a space; returns the new caret. */
export function replaceTrigger(
  text: string,
  trigger: Trigger,
  value: string,
): { text: string; caret: number } {
  const rest = text.slice(trigger.end).replace(/^ /, "");
  const next = `${text.slice(0, trigger.start)}${value} ${rest}`;
  return { text: next, caret: trigger.start + value.length + 1 };
}

/** How a file is written after `@`: between quotes when its path holds a space. */
export const mention = (file: string): string =>
  /\s/.test(file) && !file.includes('"') ? `@"${file}"` : `@${file}`;

/** Splits a message into plain text and the `@file` and `$skill` words it holds. */
export function messageTokens(text: string): { text: string; kind?: "file" | "skill" }[] {
  const parts: { text: string; kind?: "file" | "skill" }[] = [];
  const pattern = /(?<=^|[\s(])([@$])("[^"\n]+"|[^\s@$]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (match[1] === "$" && !/^[A-Za-z]/.test(match[2] ?? "")) continue;
    // A sentence may end right after the word, unless it is between quotes.
    const quoted = match[2]?.startsWith('"');
    const word = quoted ? match[0] : match[0].replace(/[.,;:!?)\]'"»]+$/, "");
    if (word.length < 2) continue;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: word, kind: match[1] === "@" ? "file" : "skill" });
    last = at + word.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
