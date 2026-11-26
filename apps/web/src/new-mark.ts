/** How long what arrived stays « Nouveau » before the line tells when it came. */
export const NEW_FOR = 60 * 60 * 1000;

/**
 * The words on the line above what arrived since the user last wrote: « Nouveau » for an
 * hour, then when it came (« Aujourd'hui à 0h35 », « Hier à 18h02 », « Lundi 23 nov. à 9h10 »).
 */
export function newMarkLabel(at: number, now = Date.now()): string {
  if (now - at < NEW_FOR) return "Nouveau";
  const d = new Date(at);
  const time = `${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `Aujourd'hui à ${time}`;
  if (days === 1) return `Hier à ${time}`;
  const date = d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date.charAt(0).toUpperCase()}${date.slice(1)} à ${time}`;
}
