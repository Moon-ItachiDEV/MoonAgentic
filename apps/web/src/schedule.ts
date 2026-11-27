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

/** The name a task takes from its text when it is given none: its first line. */
export function titleFromText(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * The moment the dialog opens on: the next full hour for a new task, or for a one-time
 * task that is over; a task that repeats keeps its own time, paused or not.
 */
export function firstMoment(schedule: Schedule | undefined, now: number): number {
  return !schedule || (!schedule.enabled && schedule.repeat === "once")
    ? nextHour(now)
    : schedule.nextAt;
}

/**
 * What an edit of the task changes in its time: a new time or a new repetition. A new
 * repetition alone keeps the time the task was set for: the one shown may be its next run
 * moved by the clocks, which would then stay moved. A one-time task that ran is planned again.
 */
export function timeChange(
  schedule: Pick<Schedule, "repeat" | "enabled">,
  edit: { timeChanged: boolean; repeat: Schedule["repeat"]; at: number },
): { at?: number; repeat?: Schedule["repeat"] } {
  if (edit.timeChanged || (!schedule.enabled && schedule.repeat === "once"))
    return { at: edit.at, repeat: edit.repeat };
  return edit.repeat !== schedule.repeat ? { repeat: edit.repeat } : {};
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
export function repeatLabel(schedule: Pick<Schedule, "repeat" | "nextAt" | "at">): string {
  // The time it was set for: its next one is an hour later the night the clocks go forward.
  const at = schedule.at ?? schedule.nextAt;
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
    // Its only time came and it did not start: never shown as done.
    return schedule.lastError
      ? { tone: "off", label: `Non lancée ${momentLabel(schedule.lastAt, now)}` }
      : { tone: "done", label: `Lancée ${momentLabel(schedule.lastAt, now)}` };
  }
  return { tone: "off", label: "En pause" };
}
