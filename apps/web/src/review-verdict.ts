import { VERDICT_FENCE } from "@moonagentic/protocol";

/** One point of a review as an agent wrote it: what is wrong, and where. */
export interface VerdictPoint {
  text: string;
  where?: string;
}

/** A review an agent ended its answer with, shown as a card. */
export interface Verdict {
  ready: boolean;
  blocking: VerdictPoint[];
  important: VerdictPoint[];
  notes: VerdictPoint[];
  checks: { text: string; ok: boolean }[];
}

const FENCE = new RegExp("```" + VERDICT_FENCE + "[^\\n]*\\n([\\s\\S]*?)(?:```|$)", "g");

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

function points(list: unknown): VerdictPoint[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).flatMap((p): VerdictPoint[] => {
    const raw = p as { texte?: unknown; text?: unknown; ou?: unknown; where?: unknown } | null;
    const text = typeof p === "string" ? str(p, 300) : str(raw?.texte ?? raw?.text, 300);
    if (!text) return [];
    const where = typeof p === "string" ? undefined : str(raw?.ou ?? raw?.where, 120);
    return [where ? { text, where } : { text }];
  });
}

/** Reads the block's JSON: undefined when it is not a review. */
export function readVerdict(json: string): Verdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const word = typeof o.verdict === "string" ? o.verdict.toLowerCase() : "";
  if (!word) return undefined;
  const blocking = points(o.bloquants ?? o.blocking);
  const checks = Array.isArray(o.verifs ?? o.checks)
    ? ((o.verifs ?? o.checks) as unknown[]).slice(0, 20).flatMap((c) => {
        const raw = c as { texte?: unknown; text?: unknown; ok?: unknown } | null;
        const text = str(raw?.texte ?? raw?.text, 200);
        return text ? [{ text, ok: raw?.ok !== false }] : [];
      })
    : [];
  return {
    // A review that names a blocking point is never ready, whatever word it says.
    ready: /^pr[eê]te?|^ready|^ok/.test(word) && blocking.length === 0,
    blocking,
    important: points(o.importants ?? o.important),
    notes: points(o.remarques ?? o.notes),
    checks,
  };
}

/**
 * An answer and the review it ends with: the text without the block, and the review read
 * from it. While the block is still being written, it is kept out of the text.
 */
export function splitVerdict(text: string): { text: string; verdict?: Verdict } {
  if (!text.includes("```" + VERDICT_FENCE)) return { text };
  let verdict: Verdict | undefined;
  const rest = text.replace(FENCE, (_, json: string) => {
    verdict = readVerdict(json) ?? verdict;
    return "";
  });
  return verdict ? { text: rest.trimEnd(), verdict } : { text: rest.trimEnd() };
}
