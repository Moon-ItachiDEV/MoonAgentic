import type { FoundSkill } from "@moonagentic/protocol";

/**
 * The skills picked in a repository that the place chosen does not hold yet: picked, then
 * another project chosen, a skill that project already has is left out.
 */
export function stillToInstall(
  picked: string[],
  found: FoundSkill[],
  /** The names already installed where it goes, in lower case. */
  here: ReadonlySet<string>,
): string[] {
  return picked.filter((p) => {
    const skill = found.find((f) => f.path === p);
    return !!skill && !here.has(skill.name.toLowerCase());
  });
}
