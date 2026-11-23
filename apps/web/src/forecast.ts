// How the review tells where the thread's branch stands against the one it started from.
import type { ServerMessage } from "@moonagentic/protocol";

export type Forecast = Pick<
  Extract<ServerMessage, { type: "forecast" }>,
  "target" | "behind" | "conflicts"
>;

const commits = (n: number) => `${n} ${n > 1 ? "commits" : "commit"}`;
const files = (n: number) => `${n} ${n > 1 ? "fichiers" : "fichier"}`;

/** The line under the branch's name: up to date, behind and clean, or behind with conflicts. */
export function forecastLine(forecast: Forecast): string {
  if (!forecast.behind) return `À jour avec ${forecast.target}`;
  const behind = `${forecast.target} a avancé de ${commits(forecast.behind)}`;
  return forecast.conflicts.length
    ? `${behind} · conflit sur ${files(forecast.conflicts.length)}`
    : `${behind} · fusion sans conflit`;
}

/** The message that asks the agent to make a merge that would conflict. */
export function conflictRequest(forecast: Forecast): string {
  const shown = forecast.conflicts.slice(0, 20).map((f) => `- ${f}`);
  const rest = forecast.conflicts.length - shown.length;
  if (rest > 0) shown.push(`- et ${files(rest)} de plus`);
  return [
    `La branche ${forecast.target} a avancé de ${commits(forecast.behind)}, et sa fusion dans ta branche entre en conflit sur :`,
    ...shown,
    "",
    `Fusionne ${forecast.target} dans ta branche (git merge ${forecast.target}), résous ces conflits en gardant ce que chaque côté voulait faire, vérifie que tout marche encore, puis fais le commit de la fusion.`,
  ].join("\n");
}
