// « /revue » : a pull request read by three agents at once, one per model maker, and what
// they found put together. Types, the default reviewers, and the pure grouping of findings.
import type { AgentInfo, Favorites, TeamMember } from "./index.ts";

/** How bad a finding is, worst first. */
export const REVIEW_SEVERITIES = ["critical", "major", "minor"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** One problem one reviewer found, as it wrote it. */
export interface ReviewFinding {
  severity: ReviewSeverity;
  /** The file, from the repository's root. */
  file?: string;
  /** A line of the file in the pull request's version. */
  line?: number;
  title: string;
  detail?: string;
}

/** One reviewer of the pull request: its agent and model, and what it is at. */
export interface PrReviewer extends TeamMember {
  /** Its own thread, once started. */
  threadId?: string;
  /**
   * `waiting` before its thread starts, `running` while it reads, `done` once its findings
   * were read, `failed` when its turn ended on an error or without findings to read.
   */
  status: "waiting" | "running" | "done" | "failed" | "stopped";
  /** True once it was asked again for the findings block it left out. */
  reasked?: true;
  findings?: ReviewFinding[];
  error?: string;
}

/** What one reviewer said of a point, in its own words. */
export interface ReviewNote {
  /** The reviewer's index. */
  by: number;
  severity: ReviewSeverity;
  title: string;
  detail?: string;
}

/**
 * One point of the synthesis: findings of several reviewers on the same place of the same
 * file, or of one reviewer alone. Its severity is the worst any of them gave.
 */
export interface ReviewPoint {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  title: string;
  /** The reviewers who found it, by index, in order. */
  by: number[];
  /** Each reviewer's own words. */
  notes: ReviewNote[];
  /** The reviewers who found it gave it different severities. */
  divergent?: true;
}

/** Where a review is, as a whole. */
export type PrReviewPhase = "preparing" | "reviewing" | "done" | "failed" | "stopped";

/** A review of a pull request by several agents, kept on its own thread by the server. */
export interface PrReview {
  phase: PrReviewPhase;
  /** `owner/name`. */
  repo: string;
  number: number;
  title?: string;
  url?: string;
  /** The commit reviewed. */
  head?: string;
  base?: string;
  reviewers: PrReviewer[];
  /** Put together from the reviewers done so far. */
  points?: ReviewPoint[];
  /** Why it could not start, or what stopped it. */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** A maker of models, and the slot of the review it gets by default. */
export interface ReviewSlot {
  vendor: "openai" | "anthropic" | "google";
  label: string;
  /** The agent its models are reached through. */
  agentId: string;
  /** Its models best at reviewing code first, from public benchmarks. */
  prefer: RegExp[];
}

/**
 * The three reviewers by default, picked from public code review benchmarks of Oct.–Nov.
 * 2026: OpenAI's Astra (MacroscopeBench), Anthropic's Opus 5.5 (Qodo, IronBee, ReviewBench),
 * Google's Gemini 4 Argon (IronBee). Each falls back on the maker's next best.
 */
export const REVIEW_SLOTS: readonly ReviewSlot[] = [
  { vendor: "openai", label: "OpenAI", agentId: "codex", prefer: [/astra/i, /\bsol\b/i] },
  {
    vendor: "anthropic",
    label: "Anthropic",
    agentId: "claude",
    prefer: [/opus/i, /sonnet/i, /fable/i],
  },
  { vendor: "google", label: "Google", agentId: "antigravity", prefer: [/argon/i, /neon/i] },
];

/** Models picked from a list ordered as they come: newest last is not assumed. */
const firstMatching = (agent: AgentInfo, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const found = agent.models?.find((m) => pattern.test(m.name) || pattern.test(m.id));
    if (found) return found.id;
  }
  return undefined;
};

/**
 * The reviewer a slot starts on: the maker's best model for reviews when its agent offers
 * it, else that agent's first favorite, else its default model. None when the agent cannot
 * run here.
 */
export function slotReviewer(
  slot: ReviewSlot,
  agents: AgentInfo[],
  favorites: Favorites,
): TeamMember | undefined {
  const agent = agents.find((a) => a.id === slot.agentId);
  if (!agent?.available || agent.modelsError) return undefined;
  const model =
    firstMatching(agent, slot.prefer) ??
    (favorites[agent.id] ?? []).find(
      (m) => !agent.models || agent.models.some((x) => x.id === m),
    ) ??
    agent.defaultModel;
  return { agentId: agent.id, ...(model ? { model } : {}) };
}

/** What a reviewer's finding becomes once read: a severity whatever the words used. */
export function severityOf(raw: unknown): ReviewSeverity {
  const text = typeof raw === "string" ? raw.toLowerCase() : "";
  if (/crit|bloqu|block|grave|high|élev|elev|sévère|severe/.test(text)) return "critical";
  if (/maj|moy|med|import|moder/.test(text)) return "major";
  return "minor";
}

const rank = (s: ReviewSeverity) => REVIEW_SEVERITIES.indexOf(s);

/** A path as reviewers may write it: `./src/a.ts`, `b/src/a.ts` or `src/a.ts:12` alike. */
export function normalPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const flat = file
    .trim()
    .replace(/\\/g, "/")
    .replace(/:\d+(?:[-:]\d+)?$/, "")
    .replace(/^\.\//, "")
    .replace(/^[ab]\//, "")
    .replace(/^\/+/, "");
  return flat || undefined;
}

/** Lines this close on the same file are the same place. */
const NEAR_LINES = 4;

const words = (text: string) =>
  new Set(
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 3),
  );

/** How much two titles share, 0 to 1. */
function likeness(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

/** Whether a finding speaks of the same thing as a point already made. */
function samePlace(point: ReviewPoint, finding: ReviewFinding): boolean {
  const file = normalPath(finding.file);
  if (point.file !== file) return false;
  if (point.line !== undefined && finding.line !== undefined)
    return Math.abs(point.line - finding.line) <= NEAR_LINES;
  // Without lines to compare, the same file and words close enough.
  return likeness(point.title, finding.title) >= 0.5;
}

/**
 * Puts the reviewers' findings together: those on the same place of the same file (a few
 * lines apart) are one point, found by all of them; a point keeps its worst severity and
 * says when they disagree on it. Worst first, then the ones most reviewers found.
 */
export function synthesize(reviewers: readonly Pick<PrReviewer, "findings">[]): ReviewPoint[] {
  const points: ReviewPoint[] = [];
  reviewers.forEach((reviewer, by) => {
    for (const finding of reviewer.findings ?? []) {
      const note: ReviewNote = {
        by,
        severity: finding.severity,
        title: finding.title,
        ...(finding.detail ? { detail: finding.detail } : {}),
      };
      // One reviewer's two findings stay two points, even close together.
      const point = points.find((p) => !p.by.includes(by) && samePlace(p, finding));
      if (!point) {
        const file = normalPath(finding.file);
        points.push({
          severity: finding.severity,
          ...(file ? { file } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          title: finding.title,
          by: [by],
          notes: [note],
        });
        continue;
      }
      point.by.push(by);
      point.notes.push(note);
      if (rank(finding.severity) < rank(point.severity)) {
        // Told in the words of whoever saw it as worst.
        point.severity = finding.severity;
        point.title = finding.title;
      }
      if (point.line === undefined && finding.line !== undefined) point.line = finding.line;
      if (point.notes.some((n) => n.severity !== point.severity)) point.divergent = true;
    }
  });
  return points
    .map((p) => ({ ...p, by: [...p.by].sort((a, b) => a - b) }))
    .sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        b.by.length - a.by.length ||
        (a.file ?? "￿").localeCompare(b.file ?? "￿") ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/** Phases in which one of the review's agents works, or is about to. */
export const reviewAtWork = (review: PrReview | undefined): boolean =>
  review?.phase === "preparing" || review?.phase === "reviewing";
