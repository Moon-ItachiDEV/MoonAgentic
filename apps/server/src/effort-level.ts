import type { AgentSetting, ModelChoice } from "@moonagentic/protocol";

/** The same level in the other language: the agent's French name for an English one, or back. */
const SAME_LEVEL: RegExp[] = [/^(low|bas|faible)$/, /^(medium|moyen)$/, /^(high|haut|eleve)$/];

/** A level's name as compared: lower case, no accents, spaces, dashes or dots. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");

/** The level's name as the user sees it: the agent's own, the highest also « UltraMoon ». */
export function effortLabel(setting: AgentSetting, choice: ModelChoice): string {
  const highest = setting.choices.length > 1 && setting.choices.at(-1)?.id === choice.id;
  const name = choice.name.trim() || choice.id;
  return highest && plain(name) !== "ultramoon" ? `${name} (UltraMoon)` : name;
}

/** The levels `settings` offer, by name, to say which exist. */
export const effortLevels = (settings: AgentSetting[]): string[] => {
  const setting = settings.find((s) => s.kind === "effort");
  return setting ? setting.choices.map((c) => effortLabel(setting, c)) : [];
};

/**
 * The effort level `asked` names among those the agent offers: its id or its name (« xhigh »,
 * « x high », « Élevé »), the same level in the other language (« high » for « Haut »), or
 * « UltraMoon » for its highest. Never a nearby level: none is an error that says which exist.
 */
export function pickEffort(
  settings: AgentSetting[],
  asked: string,
  who: string,
): { setting: AgentSetting; choice: ModelChoice } {
  const setting = settings.find((s) => s.kind === "effort");
  if (!settings.length) {
    throw new Error(
      `Les niveaux d'effort de ${who} ne sont pas encore connus : il doit avoir démarré une fois dans MoonAgentic. Dis-le à l'utilisateur sans ouvrir le fil.`,
    );
  }
  if (!setting || !setting.choices.length) {
    throw new Error(
      `${who} ne propose pas de niveau d'effort. Dis-le à l'utilisateur sans ouvrir le fil.`,
    );
  }
  const wanted = plain(asked);
  const named = (c: ModelChoice) => plain(c.id) === wanted || plain(c.name) === wanted;
  const same = SAME_LEVEL.find((level) => level.test(wanted));
  const choice =
    setting.choices.find(named) ??
    (same
      ? setting.choices.find((c) => same.test(plain(c.id)) || same.test(plain(c.name)))
      : undefined) ??
    (wanted === "ultramoon" && setting.choices.length > 1 ? setting.choices.at(-1) : undefined);
  if (!choice) {
    throw new Error(
      `${who} ne propose pas l'effort « ${asked} ». Niveaux disponibles : ${effortLevels(settings).join(", ")}. Dis-le à l'utilisateur sans ouvrir le fil ni choisir un autre niveau à sa place.`,
    );
  }
  return { setting, choice };
}

/** The effort level `values` set, by name, among the levels `settings` offer. */
export function effortOfValues(
  settings: AgentSetting[],
  values: Record<string, string> | undefined,
): string | undefined {
  const setting = settings.find((s) => s.kind === "effort");
  if (!setting) return undefined;
  const value = values && Object.hasOwn(values, setting.id) ? values[setting.id] : undefined;
  if (value === undefined) return undefined;
  const choice = setting.choices.find((c) => c.id === value);
  return choice ? effortLabel(setting, choice) : value;
}
