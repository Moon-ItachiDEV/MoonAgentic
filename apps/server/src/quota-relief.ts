// How a turn that a subscription quota stopped is told apart from any other failure, when the
// quota is back, and which fallback model takes over. Kept apart from the hub to be tested.
import type { AgentQuota, FavoriteRef, ProjectQuotaRules } from "@moonagentic/protocol";
import { spentUntil } from "@moonagentic/protocol";

/**
 * What agents say when a subscription quota (not a short burst of requests) stops them:
 * Claude Code (« You've hit your limit », « Claude AI usage limit reached »), Codex (« You've
 * hit your usage limit »), Antigravity and Gemini (« RESOURCE_EXHAUSTED », « exhausted your
 * capacity », « quota exceeded »), and an OpenAI key out of credit (« insufficient_quota »).
 */
const QUOTA_WORDS = [
  /\bhit your (?:usage |session |weekly |5-hour )?limit\b/i,
  /\busage limit (?:reached|exceeded)\b/i,
  /\b(?:5-hour|five-hour|session|weekly|opus|sonnet|fable) limit reached\b/i,
  /\busage_limit_reached\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\bexhausted (?:your|the) (?:capacity|quota)\b/i,
  /\bquota (?:exceeded|exhausted|reached)\b/i,
  /\binsufficient_quota\b/i,
  /\bout of (?:usage|credits)\b/i,
];

/** An agent's answer this long is work, not a note that the quota stopped it. */
const NOTE_LIMIT = 600;

/**
 * Whether what ended the turn says a quota stopped it: the turn's error, or else the agent's
 * whole answer when it is no more than a short note (some agents say it as an answer).
 */
export function quotaStopped(error: string | undefined, answer?: string): boolean {
  const said = [error, answer && answer.length <= NOTE_LIMIT ? answer : undefined];
  return said.some((text) => !!text && QUOTA_WORDS.some((w) => w.test(text)));
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * When the quota is back, as the agent's own words give it: « resets 3pm », « resets at
 * 15:30 », « try again in 2 hours 3 minutes », « reset after 2h3m », or the epoch after a
 * bar (« Claude AI usage limit reached|1764166800 »). Undefined when they say nothing usable.
 */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const epoch = text.match(/limit reached\|(\d{10,13})\b/i);
  if (epoch) {
    const n = Number(epoch[1]);
    const at = n < 1e12 ? n * 1000 : n;
    return at > now ? at : undefined;
  }
  const after = text.match(
    /(?:try again|again|resets?|available)\s+(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i,
  );
  if (after) {
    let ms = 0;
    for (const [, n, unit] of after[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit!.toLowerCase();
      const k = u.startsWith("d")
        ? 24 * HOUR
        : u.startsWith("h")
          ? HOUR
          : u.startsWith("m")
            ? MINUTE
            : 1000;
      ms += Number(n) * k;
    }
    return ms > 0 ? now + ms : undefined;
  }
  // A time of day: the next one to come, in this computer's time zone.
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (half === "pm" && hours < 12) hours += 12;
    if (half === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return undefined;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  return undefined;
}

/** The words a model goes by: its id and its name, for the quota windows to match. */
export type ModelNames = (agentId: string, model: string) => (string | undefined)[];

/**
 * The first fallback of the project's list that may run now: not the model that just ran
 * out, nor one already tried for this thread, its agent installed, and its figures not saying
 * it has run out too. Undefined when there is none.
 */
export function nextFallback(
  rules: ProjectQuotaRules | undefined,
  spent: FavoriteRef,
  options: {
    tried?: FavoriteRef[];
    installed: (agentId: string) => boolean;
    quota: (agentId: string) => AgentQuota | undefined;
    names: ModelNames;
    now?: number;
  },
): FavoriteRef | undefined {
  const fallback = rules?.fallback;
  if (!fallback?.on) return undefined;
  const same = (a: FavoriteRef, b: FavoriteRef) => a.agentId === b.agentId && a.model === b.model;
  const skip = [spent, ...(options.tried ?? [])];
  return fallback.models.find((m) => {
    if (skip.some((s) => same(s, m)) || !options.installed(m.agentId)) return false;
    const left = spentUntil(
      options.quota(m.agentId),
      options.names(m.agentId, m.model),
      options.now,
    );
    return !left;
  });
}

/** How long a thread waits between tries when nothing says when its quota is back. */
export const UNKNOWN_RESET_RETRY_MS = 30 * MINUTE;
/** A little after the announced reset, so the agent's service agrees it has passed. */
export const RESET_MARGIN_MS = MINUTE;
/** A thread that has waited this long for its quota stops waiting. */
export const GIVE_UP_AFTER_MS = 8 * 24 * HOUR;
