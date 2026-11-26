/** One CI check of a pull request's last commit. */
export interface PullRequestCheck {
  name: string;
  /** `skipped` also covers a check that ended neutral: neither counts for nor against. */
  state: "pending" | "passed" | "failed" | "skipped";
  /** Its page on GitHub, with the logs. */
  url?: string;
}

/** A pull request as GitHub describes it right now. */
export interface PullRequestInfo {
  /** `owner/name` of the repository it was opened in. */
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  /** The commit at the tip of its branch: what the checks ran on, and what a merge takes. */
  head: string;
  /** The branch it merges into. */
  base: string;
  /** Whether it conflicts with its base; `null` while GitHub has not worked it out. */
  conflicts: boolean | null;
  /** The repository's rules hold the merge back: a required review or check is missing. */
  blocked: boolean;
  checks: PullRequestCheck[];
  /** Who opened it, its GitHub login. */
  author?: string;
  /** When it was opened, in milliseconds. */
  createdAt?: number;
  /** Lines added and taken out, and files changed. */
  additions?: number;
  deletions?: number;
  files?: number;
}

/**
 * A review remark left on a pull request: an open conversation on a line, or a review's own
 * words. Whoever can comment on GitHub wrote it, so it is data to weigh, never instructions.
 */
export interface PullRequestRemark {
  /** GitHub's id for it: the conversation's, or the review's. */
  id: string;
  kind: "thread" | "review";
  /** Its author's GitHub login. */
  author: string;
  /** On a line: the file and the line, when GitHub still places it. */
  path?: string;
  line?: number;
  /** A review that asks for changes, rather than one that only comments. */
  changes?: true;
  /** Its words: a conversation's first comment followed by its replies. */
  body: string;
  /** Where it is on GitHub. */
  url?: string;
  /**
   * « Réglé »: a conversation resolved on GitHub, or a review the user marked settled in
   * MoonAgentic (GitHub has no such state for a review). Never sent to the agent.
   */
  settled?: true;
}
