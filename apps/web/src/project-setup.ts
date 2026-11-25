// What the project settings check before they send, the same rules as the server's, so a
// mistake shows under the field rather than as a refusal.
import {
  MAX_PROJECT_ICON,
  MAX_PROJECT_MEMORY,
  MAX_SETUP_FILE,
  type ProjectCommand,
  type ProjectSetup,
  type ProjectSkill,
  utf8Bytes,
} from "@moonagentic/protocol";

/** A few icons to pick from at once; any emoji or letters can be typed too. */
export const ICON_PICKS = ["🌙", "🚀", "🛠️", "📦", "🎨", "🧪", "📚", "⚡"];

/** Why this icon cannot be kept, or nothing when it can (empty puts the folder back). */
export function iconProblem(icon: string): string | undefined {
  const value = icon.trim();
  if (!value) return undefined;
  if (value.length > MAX_PROJECT_ICON) return "Un emoji ou deux lettres suffisent.";
  if (!/^[^\s\p{Cc}]+$/u.test(value)) return "Sans espace.";
  return undefined;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Why a command cannot be saved under this name, or nothing. */
export function commandProblem(
  name: string,
  commands: ProjectCommand[],
  previous: string | undefined,
): string | undefined {
  if (!name) return "Donne-lui un nom.";
  if (!NAME.test(name)) return "En minuscules, chiffres, - ou _, sans espace.";
  if (name !== previous && commands.some((c) => c.name === name)) {
    return `Une commande /${name} existe déjà.`;
  }
  return undefined;
}

/** Why a skill cannot be saved under this name, or nothing. */
export function skillProblem(
  name: string,
  skills: ProjectSkill[],
  editing: ProjectSkill | undefined,
): string | undefined {
  if (!name) return "Donne-lui un nom.";
  // A new one is named after its folder; one found in the project keeps its own.
  if (!editing && !NAME.test(name)) return "En minuscules, chiffres, - ou _, sans espace.";
  if (editing && !/^[A-Za-z0-9][\w.:-]{0,63}$/.test(name)) return "Un nom sans espace.";
  const same = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (same && same.path !== editing?.path) return `Une skill ${name} existe déjà.`;
  return undefined;
}

/** Whether a text fits in a setup file. */
export const fits = (text: string) => utf8Bytes(text) <= MAX_SETUP_FILE;

/** Whether a text fits in a project's shared memory. */
export const memoryFits = (text: string) => utf8Bytes(text) <= MAX_PROJECT_MEMORY;

/** A description: one line. */
export const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

/** What `CLAUDE.md` linking would do, said before it is done; nothing once it is linked. */
export function claudeAction(claude: ProjectSetup["claude"]): string | undefined {
  if (claude === "missing") return "Crée CLAUDE.md, qui importe AGENTS.md.";
  if (claude === "separate") return "Ajoute @AGENTS.md en tête de ton CLAUDE.md.";
  return undefined;
}
