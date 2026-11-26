// What a project does when a model's subscription quota runs out, and what a thread is doing
// about it. Kept apart from index.ts so the server and the web app read windows the same way.
import type { AgentQuota, FavoriteRef, QuotaWindow } from "./index.ts";

/** At most this many models in a project's list of fallback models. */
export const MAX_FALLBACK_MODELS = 8;

/**
 * A project's rules for a quota that runs out, set in its settings (« Coordinateur »).
 * `resume`: a thread stopped by a quota starts again by itself once the quota is reset.
 * `fallback`: the thread goes on at once with the first model of `models` that still has
 * quota; `back` puts it back on its own model once that one's quota is reset.
 * A thread on a fallback is never resumed as well: the two never run for the same thread.
 */
export interface ProjectQuotaRules {
  resume?: boolean;
  fallback?: { on: boolean; back: boolean; models: FavoriteRef[] };
}

/**
 * What a thread does about a quota that ran out.
 * `wait`: its agent stopped on its quota, and the thread starts again by itself at `until`
 * (unknown: checked from time to time), on the same agent and model.
 * `relief`: it goes on with a fallback model; `back` is when it goes back to its own.
 */
export type ThreadQuota =
  | { state: "wait"; agentId: string; model?: string; since: number; until?: number }
  | { state: "relief"; from: FavoriteRef; to: FavoriteRef; since: number; back?: number };

/** Lowercase words of a model's id or name: « claude-fable-5-2 » gives « claude fable 5 2 ». */
const modelWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a window limits the model in use. A window of one model (« Opus », « Fable 5.2 »)
 * counts only when the model's id or name holds all its words, in order: « Fable 5.2 » is not
 * « Fable 5.3 », and a leading « Claude » names no model on its own. A window of a group of
 * models counts for each of them.
 */
export function limitsModel(window: QuotaWindow, model?: (string | undefined)[]): boolean {
  if (!window.model && !window.models?.length) return true;
  const names = window.models?.length ? window.models : [window.model!];
  return names.some((name) => {
    const words = modelWords(name);
    if (words[0] === "claude") words.shift();
    if (!words.length) return false;
    const wanted = ` ${words.join(" ")} `;
    return !!model?.some((m) => !!m && ` ${modelWords(m).join(" ")} `.includes(wanted));
  });
}

/**
 * The window closest to its limit, the one that stops the agent first. A window of one model
 * counts only for that model: without one, only the agent's own windows count. An agent whose
 * every window is a model's (Antigravity) has no window of its own: where no model is in use,
 * its fullest one stands for it.
 */
export function tightest(
  quota: AgentQuota | undefined,
  model?: (string | undefined)[],
): QuotaWindow | undefined {
  if (!quota || quota.state !== "ok") return undefined;
  const any = model === undefined && quota.windows.every((w) => !limitsModel(w));
  let worst: QuotaWindow | undefined;
  for (const w of quota.windows) {
    if (!any && !limitsModel(w, model)) continue;
    if (!worst || w.usedPercent > worst.usedPercent) worst = w;
  }
  return worst;
}

/**
 * Whether the figures say this model has no quota left, and until when: `false` when they say
 * it has some, `undefined` when they cannot tell (no figures, or not readable).
 */
export function spentUntil(
  quota: AgentQuota | undefined,
  model: (string | undefined)[],
  now = Date.now(),
): { until?: number } | false | undefined {
  if (!quota || quota.state !== "ok") return undefined;
  const window = tightest(quota, model);
  if (!window) return undefined;
  // Figures read before the reset they announced say nothing of now.
  if (window.resetsAt !== undefined && window.resetsAt <= now) return false;
  if (window.usedPercent < 100) return false;
  return window.resetsAt !== undefined ? { until: window.resetsAt } : {};
}
