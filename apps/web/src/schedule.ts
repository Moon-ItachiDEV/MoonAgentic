// What a planned task shows: how it repeats, and when it next starts. Pure functions.
import type { Schedule, ScheduleRepeat } from "@moonagentic/protocol";

export const REPEATS: { repeat: ScheduleRepeat; label: string }[] = [
  { repeat: "once", label: "Une seule fois" },
  { repeat: "hourly", label: "Toutes les heures" },
  { repeat: "daily", label: "Tous les jours" },
  { repeat: "weekdays", label: "Du lundi au vendredi" },
  { repeat: "weekly", label: "Toutes les semaines" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** A moment as a `datetime-local` field writes it, on this device's clock. */
export function toField(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The moment a `datetime-local` field holds; null while it is not one yet. */
export function fromField(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match || Number(match[1]) < 1970) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** What a new task is offered: the next full hour. */
export function nextHour(now: number): number {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

const hourOf = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A moment in words: « aujourd'hui à 09:00 », « demain à 09:00 », « lun. 30 nov. à 09:00 ». */
export function momentLabel(at: number, now: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  const date =
    days === 0
      ? "aujourd'hui"
      : days === 1
        ? "demain"
        : days === -1
          ? "hier"
          : new Date(at).toLocaleDateString("fr-FR", {
              weekday: "short",
              day: "numeric",
              month: "short",
              ...(new Date(at).getFullYear() !== new Date(now).getFullYear()
                ? { year: "numeric" }
                : {}),
            });
  return `${date} à ${hourOf(at)}`;
}

/** How the task repeats: « Tous les jours à 09:00 », « Tous les lundis à 09:00 ». */
export function repeatLabel(schedule: Pick<Schedule, "repeat" | "nextAt">): string {
  const at = schedule.nextAt;
  switch (schedule.repeat) {
    case "once":
      return "Une seule fois";
    case "hourly":
      return `Toutes les heures, à la minute ${pad(new Date(at).getMinutes())}`;
    case "daily":
      return `Tous les jours à ${hourOf(at)}`;
    case "weekdays":
      return `Du lundi au vendredi à ${hourOf(at)}`;
    case "weekly":
      return `Tous les ${new Date(at).toLocaleDateString("fr-FR", { weekday: "long" })}s à ${hourOf(at)}`;
  }
}

/** Where the task stands: waiting for its time, paused, or done. */
export function scheduleState(
  schedule: Schedule,
  now: number,
): { tone: "on" | "off" | "done"; label: string } {
  if (schedule.enabled) {
    return { tone: "on", label: `Prochain lancement ${momentLabel(schedule.nextAt, now)}` };
  }
  if (schedule.repeat === "once" && schedule.lastAt) {
    return { tone: "done", label: `Lancée ${momentLabel(schedule.lastAt, now)}` };
  }
  return { tone: "off", label: "En pause" };
}
