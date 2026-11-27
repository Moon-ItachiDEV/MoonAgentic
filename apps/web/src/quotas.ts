// Kept apart from the views, so it is easy to test.
import type { AgentInfo, AgentQuota } from "@moonagentic/protocol";
import { tightest } from "@moonagentic/protocol";

/** From this share used, a window is shown as nearly spent. */
export const WARN_PERCENT = 80;

export type QuotaLevel = "ok" | "warn" | "full";

export function quotaLevel(usedPercent: number): QuotaLevel {
  return usedPercent >= 100 ? "full" : usedPercent >= WARN_PERCENT ? "warn" : "ok";
}

export { limitsModel, tightest } from "@moonagentic/protocol";

export function formatPercent(value: number): string {
  return `${Math.min(999, Math.round(value))} %`;
}

const time = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];

/** When a window frees up, in the user's own time: « à 14:20 », « lundi à 09:00 ». */
export function formatReset(resetsAt: number, now = Date.now()): string {
  if (resetsAt <= now) return "bientôt";
  const at = new Date(resetsAt);
  const today = new Date(now);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(at) - dayStart(today)) / 86_400_000);
  if (days <= 0) return `à ${time(at)}`;
  if (days === 1) return `demain à ${time(at)}`;
  if (days < 7) return `${DAYS[at.getDay()]} à ${time(at)}`;
  return `le ${at.getDate()} ${MONTHS[at.getMonth()]} à ${time(at)}`;
}

/** How long ago the figures were read. */
export function readAgo(readAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - readAt) / 60_000);
  if (minutes < 1) return "Lu à l'instant";
  if (minutes < 60) return `Lu il y a ${minutes} min`;
  return `Lu il y a ${Math.floor(minutes / 60)} h`;
}

/**
 * Another installed agent with room left, the one with the most: what a nearly spent
 * agent's warning offers to hand over to.
 */
export function roomiest(
  quotas: AgentQuota[],
  agents: AgentInfo[],
  exceptId: string,
): AgentInfo | undefined {
  let best: { agent: AgentInfo; used: number } | undefined;
  for (const quota of quotas) {
    if (quota.agentId === exceptId) continue;
    const agent = agents.find((a) => a.id === quota.agentId && a.available);
    const worst = tightest(quota);
    if (!agent || !worst || quotaLevel(worst.usedPercent) !== "ok") continue;
    if (!best || worst.usedPercent < best.used) best = { agent, used: worst.usedPercent };
  }
  return best?.agent;
}

/** Bucket size for `resetsAt` inside dismissal keys, absorbing ±1 s API jitter between reads. */
const RESET_KEY_BUCKET_MS = 5 * 60_000;

/** Parses the per-agent map of dismissed quota warning keys kept in preferences. */
export function parseSeenQuotas(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** What the warning over the composer says about an agent, when it says anything. */
export function quotaWarning(
  quota: AgentQuota | undefined,
  agentName: string,
  now = Date.now(),
  model?: (string | undefined)[],
): { key: string; level: "warn" | "full"; text: string; brief: string; when?: string } | undefined {
  const worst = tightest(quota, model);
  if (!worst) return undefined;
  const level = quotaLevel(worst.usedPercent);
  if (level === "ok") return undefined;
  const when = worst.resetsAt ? `Se libère ${formatReset(worst.resetsAt, now)}.` : undefined;
  const resetBucket =
    worst.resetsAt !== undefined ? Math.round(worst.resetsAt / RESET_KEY_BUCKET_MS) : "";
  return {
    key: `${quota!.agentId}:${worst.label}:${resetBucket}:${level}`,
    level,
    text:
      level === "full"
        ? `${agentName} a atteint sa limite (${worst.short}).`
        : `${agentName} a utilisé ${formatPercent(worst.usedPercent)} (${worst.short}).`,
    // On a phone the line holds no more than this (audit N29).
    brief:
      level === "full"
        ? `Limite atteinte (${worst.short})`
        : `${formatPercent(worst.usedPercent)} (${worst.short})`,
    ...(when ? { when } : {}),
  };
}
