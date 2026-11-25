import type { Thread } from "@moonagentic/protocol";
import { useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import { type PrLink, prKey, repoOfUrl } from "../pr-links.ts";
import { I } from "../v2/I.tsx";

/** What the app knows of a pull request from its threads: its state, read from GitHub. */
function known(threads: Thread[], link: PrLink) {
  const key = prKey(link);
  const repos = new Set<string>();
  let pr: Thread["pr"];
  for (const t of threads) {
    if (!t.pr) continue;
    const repo = repoOfUrl(t.pr.url);
    if (repo) repos.add(repo);
    if (repo && prKey({ ...splitRepo(repo), number: t.pr.number }) === key) pr = t.pr;
  }
  const own = `${link.owner}/${link.repo}`.toLowerCase();
  return { pr, other: repos.size > 0 && !repos.has(own) };
}

const splitRepo = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, repo: name };
};

/** The tint of the chip's icon: the pull request's real state, when the app knows it. */
function toneOf(pr: Thread["pr"]): string {
  if (!pr) return "";
  if (pr.state === "merged") return " merged";
  if (pr.state === "closed") return " closed";
  if (pr.checks === "failed" || pr.conflicts) return " failed";
  if (pr.state === "draft") return " draft";
  return " open";
}

/** « PR 155 », with the repository's name first when it is not the project's own. */
export function PrChip(props: { link: PrLink; onRemove?: () => void }) {
  const threads = useSyncExternalStore(connection.subscribe, () => connection.getState().threads);
  const { link } = props;
  const { pr, other } = known(threads, link);
  const label = `PR ${link.number}`;
  const body = (
    <>
      <I n={pr?.state === "merged" ? "merge" : "branch"} s={13} />
      {other && <span className="rp">{link.repo}</span>}
      {label}
    </>
  );
  if (props.onRemove)
    return (
      <span className={`prl${toneOf(pr)}`} title={`${link.owner}/${link.repo} #${link.number}`}>
        {body}
        <button
          type="button"
          className="x"
          aria-label={`Retirer ${label}`}
          onClick={props.onRemove}
        >
          <I n="x" s={11} />
        </button>
      </span>
    );
  return (
    <a
      className={`prl${toneOf(pr)}`}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${link.owner}/${link.repo} #${link.number}`}
    >
      {body}
    </a>
  );
}
