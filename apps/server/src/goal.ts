// A goal the agent works toward over several turns: what it is told, and how its answer
// says where the goal stands. Pure, so it is easy to test.
import type { ThreadGoal } from "@moonagentic/protocol";

/** What the agent writes on a line of its own once the goal is reached. */
export const REACHED = "OBJECTIF ATTEINT";
/** What it writes, with the reason, when it cannot go on without the user. */
export const BLOCKED = "OBJECTIF BLOQUÉ";

const RULES =
  `Travaille jusqu'à l'atteindre, en plusieurs tours si besoin : à la fin de chaque tour, ` +
  `je te relance pour la suite. Termine chaque réponse par une ligne à part :\n` +
  `- « ${REACHED} » quand il est atteint et vérifié ;\n` +
  `- « ${BLOCKED} : <la raison> » si tu ne peux pas avancer sans moi ;\n` +
  `- rien de tout ça s'il reste du travail.`;

/**
 * What the agent is told before the goal's turn: the goal and how to say where it stands.
 * The user sees only the short line of `goalMessage`; this goes with it, unseen.
 */
export function goalContext(goal: Pick<ThreadGoal, "text" | "turns" | "maxTurns">): string {
  return [
    `Objectif fixé par l'utilisateur (tour ${goal.turns} sur ${goal.maxTurns} au plus) :`,
    goal.text,
    "",
    RULES,
  ].join("\n");
}

/** The line the thread shows for a goal's turn after the first. */
export const goalMessage = (goal: Pick<ThreadGoal, "turns" | "maxTurns">): string =>
  `Continue vers l'objectif (tour ${goal.turns} sur ${goal.maxTurns}).`;

/**
 * Where the agent's answer says the goal stands, from its last lines: reached, blocked with
 * its reason, or still under way. Only a line of its own counts, so a goal quoted in the
 * middle of the answer is not taken for it.
 */
export function goalVerdict(reply: string): { reached: true } | { blocked: string } | undefined {
  const lines = reply
    .split("\n")
    .map((l) => l.replace(/[*_`>#]/g, "").trim())
    .filter(Boolean)
    .slice(-3)
    .reverse();
  for (const line of lines) {
    const upper = line.toLocaleUpperCase("fr");
    if (upper.replace(/[.!\s]+$/, "") === REACHED) return { reached: true };
    const blocked = /^OBJECTIF BLOQU[ÉE]\s*[:：-]?\s*(.*)$/u.exec(upper);
    if (blocked) {
      // The reason as the agent wrote it, not upper-cased.
      const reason = line.slice(line.length - (blocked[1]?.length ?? 0)).trim();
      return { blocked: reason || "L'agent ne peut pas avancer sans toi." };
    }
  }
  return undefined;
}
