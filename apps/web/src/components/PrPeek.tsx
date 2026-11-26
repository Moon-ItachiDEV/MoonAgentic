import type { PullRequestInfo } from "@moonagentic/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { prStates } from "../pr-states.ts";
import { I } from "../v2/I.tsx";

/** What GitHub said of each pull request lately, by address: a card shown again asks once. */
const seen = new Map<string, { at: number; pr: PullRequestInfo }>();
const FRESH_MS = 60_000;
/** A pointer passing over does not open the card: it waits this long first. */
const OPEN_MS = 350;

const STATE: Record<PullRequestInfo["state"], string> = {
  open: "Ouverte",
  draft: "Brouillon",
  merged: "Fusionnée",
  closed: "Fermée",
};

/** « il y a 10 min », « il y a 3 h », « il y a 2 j ». */
export function agoText(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function usePr(url: string, open: boolean) {
  const [pr, setPr] = useState<PullRequestInfo | undefined>(() => seen.get(url)?.pr);
  useEffect(() => {
    if (!open) return;
    const known = seen.get(url);
    if (known) setPr(known.pr);
    if (known && Date.now() - known.at < FRESH_MS) return;
    let live = true;
    connection.ask({ type: "github.pr", requestId: newId(), url }).then(
      (reply) => {
        if (reply.type !== "pullRequest" || !reply.pr) return;
        seen.delete(url);
        seen.set(url, { at: Date.now(), pr: reply.pr });
        if (seen.size > 100) seen.delete(seen.keys().next().value!);
        prStates.learn(reply.pr.url, reply.pr.state);
        if (live) setPr(reply.pr);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, open]);
  return pr;
}

/** The card itself: title, repository and number, who opened it, its size, its state. */
function PeekCard({ url }: { url: string }) {
  const pr = usePr(url, true);
  if (!pr) return <span className="prpk wait" aria-hidden="true" />;
  const size = [
    pr.additions !== undefined ? (
      <b key="a" className="ad">
        +{pr.additions}
      </b>
    ) : null,
    pr.deletions !== undefined ? (
      <b key="d" className="dl">
        −{pr.deletions}
      </b>
    ) : null,
  ].filter(Boolean);
  const facts: ReactNode[] = [];
  if (pr.author)
    facts.push(
      <span key="w" className="au">
        {pr.author}
      </span>,
    );
  if (pr.createdAt) facts.push(<span key="t">{agoText(pr.createdAt)}</span>);
  if (size.length) facts.push(<span key="s">{size}</span>);
  if (pr.files !== undefined)
    facts.push(<span key="f">{`${pr.files} fichier${pr.files > 1 ? "s" : ""}`}</span>);
  return (
    <span className="prpk" role="tooltip">
      <span className="tt">{pr.title}</span>
      <span className="rp">
        {pr.repo} #{pr.number}
      </span>
      {facts.length > 0 && (
        <span className="fx">
          {facts.map((f, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {f}
            </span>
          ))}
        </span>
      )}
      <span className={`st ${pr.state}`}>
        <I n={pr.state === "merged" ? "merge" : "branch"} s={13} />
        {STATE[pr.state]}
      </span>
    </span>
  );
}

/**
 * Shows, under the pointer, a card of the pull request: what GitHub says of it now. Only
 * with a mouse; on a phone the link itself opens it.
 */
export function PrPeek({ url, children }: { url: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number>(undefined);
  const fine =
    typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!fine) return <>{children}</>;
  return (
    <span
      className="prpw"
      onMouseEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(true), OPEN_MS);
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current);
        setOpen(false);
      }}
    >
      {children}
      {open && <PeekCard url={url} />}
    </span>
  );
}
