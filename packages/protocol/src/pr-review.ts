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
  /**
   * Its part in the confrontation, once every reviewer is done: it reads the points of the
   * others and says what it makes of each one.
   */
  debate?: "running" | "done" | "failed" | "stopped";
  /** True once it was asked again for the verdicts block it left out. */
  debateReasked?: true;
  /** What it said of each point, by the point's index. */
  verdicts?: ReviewVerdict[];
}

/** What a reviewer makes of a point in the confrontation. */
export interface ReviewVerdict {
  /** The point's index in the synthesis. */
  point: number;
  /** `withdraw` only counts from a reviewer who found the point itself. */
  verdict: "agree" | "disagree" | "withdraw";
  /** The severity it would give, when it differs. */
  severity?: ReviewSeverity;
  reason?: string;
}

/** A reviewer's verdict on a point, kept on the point. */
export interface ReviewVote extends Omit<ReviewVerdict, "point"> {
  by: number;
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
  /** What the reviewers said of it in the confrontation. */
  votes?: ReviewVote[];
  /**
   * After the confrontation: `confirmed` when found by several, or agreed with and contested
   * by none; `disputed` when one disagrees; `withdrawn` when all who found it took it back;
   * `open` when nobody weighed in. Once the judge rules on a disputed point, `confirmed` or
   * `rejected`.
   */
  outcome?: "confirmed" | "disputed" | "withdrawn" | "open" | "rejected";
  /** The judge's ruling, on a point the reviewers did not agree on. */
  ruling?: Omit<ReviewRuling, "point">;
}

/** The judge's ruling on a disputed point. */
export interface ReviewRuling {
  point: number;
  /** Whether the problem is real. */
  real: boolean;
  /** The severity it settles on, when real. */
  severity?: ReviewSeverity;
  reason?: string;
}

/** Who settles the points the reviewers still disagree on once they have weighed them. */
export interface PrJudge extends TeamMember {
  threadId?: string;
  status?: "running" | "done" | "failed" | "stopped";
  reasked?: true;
  rulings?: ReviewRuling[];
  error?: string;
}

/** Where a review is, as a whole. */
export type PrReviewPhase =
  "preparing" | "reviewing" | "debating" | "judging" | "done" | "failed" | "stopped";

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
  /** Settles the points still disputed after the confrontation; none, and they stay so. */
  judge?: PrJudge;
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

/**
 * The judge by default: Claude Fable 5.2, the strongest at reasoning about code (1st on
 * SWE-Bench Pro, 93 %), and none of the three reviewers. Opus next.
 */
export const REVIEW_JUDGE: ReviewSlot = {
  vendor: "anthropic",
  label: "Arbitre",
  agentId: "claude",
  prefer: [/fable/i, /opus/i],
};

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
  review?.phase === "preparing" ||
  review?.phase === "reviewing" ||
  review?.phase === "debating" ||
  review?.phase === "judging";

/**
 * The points once the judge has ruled: a disputed point it finds real is confirmed at the
 * severity it settles on; one it finds unfounded is rejected.
 */
export function applyRulings(
  points: readonly ReviewPoint[],
  rulings: readonly ReviewRuling[] | undefined,
): ReviewPoint[] {
  if (!rulings?.length) return [...points];
  return points.map((point, index) => {
    const ruling = rulings.find((r) => r.point === index);
    if (!ruling || point.outcome !== "disputed") return point;
    const { point: _index, ...kept } = ruling;
    return {
      ...point,
      ruling: kept,
      outcome: ruling.real ? "confirmed" : "rejected",
      ...(ruling.real && ruling.severity ? { severity: ruling.severity } : {}),
    };
  });
}

/** What a reviewer wrote as its verdict, whatever the words. */
export function verdictOf(raw: unknown): ReviewVerdict["verdict"] {
  const text = typeof raw === "string" ? raw.toLowerCase() : "";
  if (/retir|withdr|abandon/.test(text)) return "withdraw";
  if (/d[ée]saccord|disagree|conteste|faux|invalid|non\b|reject/.test(text)) return "disagree";
  return "agree";
}

/**
 * The points with what each reviewer said of them in the confrontation, and where each one
 * ends up. A finder's own `disagree` counts as taking it back; a `withdraw` from someone
 * who did not find it counts as disagreeing. A severity a voter proposes that differs from
 * the point's marks it as discussed.
 */
export function applyVotes(
  points: readonly ReviewPoint[],
  reviewers: readonly Pick<PrReviewer, "verdicts" | "debate">[],
): ReviewPoint[] {
  const debated = reviewers.some((r) => r.debate !== undefined);
  return points.map((point, index) => {
    const votes: ReviewVote[] = [];
    reviewers.forEach((r, by) => {
      const said = r.verdicts?.find((v) => v.point === index);
      if (!said) return;
      const finder = point.by.includes(by);
      const verdict = said.verdict === "agree" ? "agree" : finder ? "withdraw" : "disagree";
      votes.push({
        by,
        verdict,
        ...(said.severity ? { severity: said.severity } : {}),
        ...(said.reason ? { reason: said.reason } : {}),
      });
    });
    if (!debated) return point;
    const withdrawn = votes.filter((v) => v.verdict === "withdraw").map((v) => v.by);
    const kept = point.by.filter((b) => !withdrawn.includes(b));
    const outcome: ReviewPoint["outcome"] =
      kept.length === 0
        ? "withdrawn"
        : votes.some((v) => v.verdict === "disagree")
          ? "disputed"
          : kept.length > 1 || votes.some((v) => v.verdict === "agree" && !point.by.includes(v.by))
            ? "confirmed"
            : "open";
    const regraded = votes.some((v) => v.severity && v.severity !== point.severity);
    return {
      ...point,
      ...(votes.length ? { votes } : {}),
      outcome,
      ...(regraded ? { divergent: true as const } : {}),
    };
  });
}
