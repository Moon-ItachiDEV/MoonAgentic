import { execFile } from "node:child_process";
import type { PullRequestCheck, PullRequestInfo, PullRequestRemark } from "@moonagentic/protocol";
import { githubAccount } from "./github-account.ts";
import { findGh } from "./github.ts";

const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };
const ASK_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 2 * 60_000;

const FIELDS =
  "number,url,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,author,createdAt,additions,deletions,changedFiles";

/**
 * Where pull requests are read and merged. Today the user's own `gh`; a client holding a
 * GitHub token would be another one of these.
 */
export interface PullRequests {
  /** The pull request `ref` names in `repo`: its number, or its branch. None: undefined. */
  find(repo: string, ref: string): Promise<PullRequestInfo | undefined>;
  /** Merges it if its last commit is still `head`, the way the repository allows. */
  merge(repo: string, number: number, head: string): Promise<void>;
  /**
   * Its review remarks: conversations, the resolved ones marked `settled`, and reviews with
   * words of their own.
   */
  remarks?(repo: string, number: number): Promise<PullRequestRemark[]>;
  /** Resolves a conversation of a pull request, by GitHub's id for it. */
  resolveRemark?(threadId: string): Promise<void>;
}

/** Runs `gh` with these arguments and resolves with what it printed. */
export type GhRun = (args: string[], timeout: number) => Promise<string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

function checkOf(raw: unknown): (PullRequestCheck & { key: string; at: string }) | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.__typename === "StatusContext") {
    const name = text(raw.context);
    if (!name) return undefined;
    const state = text(raw.state);
    const url = text(raw.targetUrl);
    return {
      key: `status/${name}`,
      // A commit status has no start: it is dated by when it was posted.
      at: text(raw.startedAt) || text(raw.createdAt),
      name,
      state:
        state === "SUCCESS"
          ? "passed"
          : state === "PENDING" || state === "EXPECTED"
            ? "pending"
            : "failed",
      ...(url ? { url } : {}),
    };
  }
  const name = text(raw.name);
  if (!name) return undefined;
  const conclusion = text(raw.conclusion);
  const url = text(raw.detailsUrl);
  return {
    key: `${text(raw.workflowName)}/${name}`,
    at: text(raw.startedAt),
    name,
    state:
      text(raw.status) !== "COMPLETED"
        ? "pending"
        : conclusion === "SUCCESS"
          ? "passed"
          : conclusion === "NEUTRAL" || conclusion === "SKIPPED"
            ? "skipped"
            : "failed",
    ...(url ? { url } : {}),
  };
}

/** Reads what `gh pr view --json` printed. A check run again counts once, as its last run. */
export function parsePullRequest(json: string, repo: string): PullRequestInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.number !== "number" || !text(raw.url)) return undefined;
  const latest = new Map<string, PullRequestCheck & { key: string; at: string }>();
  for (const one of Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []) {
    const check = checkOf(one);
    if (!check) continue;
    const seen = latest.get(check.key);
    if (!seen || check.at >= seen.at) latest.set(check.key, check);
  }
  const state = text(raw.state);
  return {
    repo,
    number: raw.number,
    url: text(raw.url),
    title: text(raw.title),
    state:
      state === "MERGED"
        ? "merged"
        : state === "CLOSED"
          ? "closed"
          : raw.isDraft === true
            ? "draft"
            : "open",
    head: text(raw.headRefOid),
    base: text(raw.baseRefName),
    conflicts:
      raw.mergeable === "CONFLICTING" ? true : raw.mergeable === "MERGEABLE" ? false : null,
    blocked: raw.mergeStateStatus === "BLOCKED",
    checks: [...latest.values()].map(({ key: _key, at: _at, ...check }) => check),
    ...(isRecord(raw.author) && text(raw.author.login) ? { author: text(raw.author.login) } : {}),
    ...(text(raw.createdAt) && !Number.isNaN(Date.parse(text(raw.createdAt)))
      ? { createdAt: Date.parse(text(raw.createdAt)) }
      : {}),
    ...(typeof raw.additions === "number" ? { additions: raw.additions } : {}),
    ...(typeof raw.deletions === "number" ? { deletions: raw.deletions } : {}),
    ...(typeof raw.changedFiles === "number" ? { files: raw.changedFiles } : {}),
  };
}

/** At most this much of one remark: a pasted log says what it needs in far less. */
export const REMARK_MAX = 4000;
const MAX_REPLIES = 20;

/** Review conversations and reviews of one pull request, in one GraphQL request. */
const REMARKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved path line comments(first: ${MAX_REPLIES}) { nodes { author { login } body url } } }
      }
      reviews(last: 50) { nodes { id state body url author { login } } }
    }
  }
}`;

/** A link kept only when it leads to github.com: the page shows it, the agent may read it. */
const githubLink = (url: string) => (/^https:\/\/github\.com\/[^\s]*$/.test(url) ? url : "");

const cut = (body: string) =>
  body.length > REMARK_MAX ? `${body.slice(0, REMARK_MAX - 1)}…` : body;
const login = (author: unknown) => (isRecord(author) ? text(author.login) : "") || "inconnu";
const nodes = (value: unknown): unknown[] =>
  isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];

/**
 * Reads what `gh api graphql` printed for {@link REMARKS_QUERY}: the conversations (resolved ones marked settled),
 * oldest first, then the reviews that ask for changes or comment with words of their own.
 */
export function parseRemarks(json: string): PullRequestRemark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const pull =
    isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.repository)
      ? raw.data.repository.pullRequest
      : undefined;
  if (!isRecord(pull)) return [];
  const remarks: PullRequestRemark[] = [];
  for (const thread of nodes(pull.reviewThreads)) {
    if (!isRecord(thread) || !text(thread.id)) continue;
    const comments = nodes(thread.comments).filter(isRecord);
    const first = comments[0];
    if (!first || !text(first.body).trim()) continue;
    const replies = comments
      .slice(1)
      .filter((c) => text(c.body).trim())
      .map((c) => `@${login(c.author)} : ${text(c.body).trim()}`);
    const path = text(thread.path);
    const line = typeof thread.line === "number" ? thread.line : undefined;
    const url = githubLink(text(first.url));
    remarks.push({
      id: text(thread.id),
      kind: "thread",
      author: login(first.author),
      ...(path ? { path } : {}),
      ...(line ? { line } : {}),
      body: cut([text(first.body).trim(), ...replies].join("\n\n")),
      ...(url ? { url } : {}),
      ...(thread.isResolved === true ? { settled: true as const } : {}),
    });
  }
  for (const review of nodes(pull.reviews)) {
    if (!isRecord(review) || !text(review.id) || !text(review.body).trim()) continue;
    const state = text(review.state);
    if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") continue;
    const url = githubLink(text(review.url));
    remarks.push({
      id: text(review.id),
      kind: "review",
      author: login(review.author),
      ...(state === "CHANGES_REQUESTED" ? { changes: true as const } : {}),
      body: cut(text(review.body).trim()),
      ...(url ? { url } : {}),
    });
  }
  return remarks;
}

/** `owner/name` and number of a pull request's address on github.com, and nothing else. */
export function parsePullRequestUrl(url: string): { repo: string; number: number } | undefined {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(
      url.trim(),
    );
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

/** The first line of what `gh` said went wrong, which is the one written for people. */
const ghError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** Pull requests through the user's own `gh` sign-in. */
export function ghPullRequests(run: GhRun): PullRequests {
  return {
    async find(repo, ref) {
      let out: string;
      try {
        out = await run(["pr", "view", ref, "--repo", repo, "--json", FIELDS], ASK_TIMEOUT_MS);
      } catch (error) {
        if (/no pull requests found/i.test(ghError(error))) return undefined;
        throw new Error(ghError(error), { cause: error });
      }
      return parsePullRequest(out, repo);
    },
    async remarks(repo, number) {
      const [owner, name] = repo.split("/");
      let out: string;
      try {
        out = await run(
          [
            "api",
            "graphql",
            "-f",
            `query=${REMARKS_QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${number}`,
          ],
          ASK_TIMEOUT_MS,
        );
      } catch (error) {
        throw new Error(ghError(error), { cause: error });
      }
      return parseRemarks(out);
    },
    async resolveRemark(threadId) {
      try {
        await run(
          [
            "api",
            "graphql",
            "-f",
            "query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
            "-f",
            `id=${threadId}`,
          ],
          ASK_TIMEOUT_MS,
        );
      } catch (error) {
        throw new Error(ghError(error), { cause: error });
      }
    },
    async merge(repo, number, head) {
      let allowed: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(
          await run(
            [
              "repo",
              "view",
              repo,
              "--json",
              "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
            ],
            ASK_TIMEOUT_MS,
          ),
        );
        if (isRecord(raw)) allowed = raw;
      } catch {
        // not told: a merge commit is tried, and GitHub says no if the repository forbids it
      }
      const method =
        allowed.mergeCommitAllowed === false
          ? allowed.squashMergeAllowed === false
            ? "--rebase"
            : "--squash"
          : "--merge";
      try {
        // The branch is left alone: the thread still works on it.
        await run(
          ["pr", "merge", String(number), "--repo", repo, method, "--match-head-commit", head],
          MERGE_TIMEOUT_MS,
        );
      } catch (error) {
        throw new Error(ghError(error), { cause: error });
      }
    },
  };
}

/** The user's `gh`, when it is installed, as MoonAgentic's own GitHub account when signed in. */
export function localPullRequests(): PullRequests | undefined {
  const gh = findGh();
  if (!gh) return undefined;
  return ghPullRequests(
    (args, timeout) =>
      new Promise((resolve, reject) => {
        execFile(
          gh,
          args,
          {
            env: { ...process.env, ...NO_PROMPT, ...githubAccount()?.ghEnv() },
            timeout,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error?.killed) reject(new Error("GitHub n'a pas répondu à temps."));
            else if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
            else resolve(stdout);
          },
        );
      }),
  );
}
