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
}
