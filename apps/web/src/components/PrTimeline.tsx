import type { PullRequestInfo } from "@moonagentic/protocol";
import { prSteps, type PrStep } from "../pr-board.ts";
import { IconErrCircle, IconExternal, IconGithub, IconOkCircle } from "./icons.tsx";

function Mark({ state }: { state: PrStep["state"] }) {
  if (state === "done")
    return (
      <span className="t2-m ok">
        <IconOkCircle size={18} />
      </span>
    );
  if (state === "failed")
    return (
      <span className="t2-m err">
        <IconErrCircle size={18} />
      </span>
    );
  if (state === "running")
    return (
      <span className="t2-m">
        <i className="t2-spin" />
      </span>
    );
  return (
    <span className="t2-m">
      <i className="t2-ring" />
    </span>
  );
}

/** The head of a pull request's card: its number, which opens it on GitHub, and its branch. */
export function PrBadge({
  pr,
  branch,
}: {
  pr: Pick<PullRequestInfo, "url" | "number">;
  branch?: string | undefined;
}) {
  return (
    <div className="prc-id">
      <a
        className="prc-n"
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        title="Ouvrir sur GitHub"
      >
        <IconGithub size={14} />#{pr.number}
        <IconExternal size={12} />
      </a>
      {branch && <span className="prc-br">{branch}</span>}
    </div>
  );
}

/**
 * A pull request as a line of steps: its checks, its conflicts, then the merge that waits for
 * the user. Green for what passed, red for what failed, a grey ring for what is to come, an
 * amber ring for the step that needs the user. Only what GitHub said: no step is made up.
 */
export function PrTimeline({ pr }: { pr: PullRequestInfo }) {
  const steps = prSteps(pr);
  return (
    <ol className="tl2" aria-label="Étapes de la pull request">
      {steps.map((s) => (
        <li key={s.key} className={`t2 t2-${s.state}`}>
          <Mark state={s.state} />
          {s.url ? (
            <a className="t2-l" href={s.url} target="_blank" rel="noopener noreferrer">
              {s.label}
            </a>
          ) : (
            <span className="t2-l">{s.label}</span>
          )}
          {s.tag ? <span className={`tag ${s.tag.tone}`}>{s.tag.text}</span> : <span />}
        </li>
      ))}
    </ol>
  );
}
