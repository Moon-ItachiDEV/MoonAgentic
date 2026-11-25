import type { MoonBranch, Project } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { branchNote, branches, deletedLine } from "../branch-cleanup.ts";
import { connection, newId } from "../connection.ts";
import { shortAgo } from "../project-threads.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { type Confirmation, ConfirmDialog } from "./ConfirmDialog.tsx";

type Listing = { targets: string[]; branches: MoonBranch[] };
type Result = { deleted: string[]; kept: { name: string; reason: string }[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * « Branches »: the project's `moon/*` branches whose work is already merged, to delete those
 * the user keeps ticked, after a confirmation. The others are only shown, with why they stay.
 * The server looks at each one again before it goes.
 */
function Body({ project, onBusy }: { project: Project; onBusy: (busy: boolean) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [now] = useState(() => Date.now());

  // Once the sheet is closed, a late answer changes nothing.
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const load = useCallback(() => {
    setError(null);
    return connection
      .ask({ type: "project.branches", requestId: newId(), projectId: project.id })
      .then(
        (reply) => {
          if (!live.current) return;
          setListing({ targets: reply.targets, branches: reply.branches });
          setPicked(new Set(reply.branches.filter((b) => b.state === "merged").map((b) => b.name)));
        },
        (e: unknown) => live.current && setError(message(e)),
      );
  }, [project.id]);
  useEffect(() => void load(), [load]);

  const remove = async () => {
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const reply = await connection.ask({
        type: "project.deleteBranches",
        requestId: newId(),
        projectId: project.id,
        branches: [...picked],
      });
      if (!live.current) return;
      setResult({ deleted: reply.deleted, kept: reply.kept });
      await load();
    } finally {
      onBusy(false);
      if (live.current) setBusy(false);
    }
  };

  const merged = listing?.branches.filter((b) => b.state === "merged") ?? [];
  const others = listing?.branches.filter((b) => b.state !== "merged") ?? [];
  const count = merged.filter((b) => picked.has(b.name)).length;
  const all = count === merged.length;
  const pick = (name: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div className="sbody">
      {!listing && !error && (
        <div className="fvn">
          <span className="t2-spin" />
        </div>
      )}
      {listing && !listing.branches.length && !result && (
        <div className="fvn">Aucune branche moon/*</div>
      )}
      {result && (
        <div role="status">
          <div className="gl2">{deletedLine(result.deleted.length, result.kept.length)}</div>
          {result.kept.length > 0 && (
            <div className="ins">
              {result.kept.map((k) => (
                <div key={k.name} className="it ro brr off">
                  <span className="tx">
                    <span className="mono">{k.name}</span>
                    <small>{k.reason}</small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {merged.length > 0 && (
        <>
          <div className="gl2">
            Fusionnées
            <span className="gcn">{merged.length}</span>
            <span className="sp" />
            <button
              className="lk"
              disabled={busy}
              onClick={() => setPicked(all ? new Set() : new Set(merged.map((b) => b.name)))}
            >
              {all ? "Aucune" : "Toutes"}
            </button>
          </div>
          <div className="ins">
            {merged.map((b) => (
              <button
                key={b.name}
                className="it fva brr"
                aria-pressed={picked.has(b.name)}
                disabled={busy}
                onClick={() => pick(b.name)}
              >
                <span className="tx">
                  <span className="mono" title={b.name}>
                    {b.name}
                  </span>
                  <small>
                    {branchNote(b)} · {shortAgo(b.at, now)}
                  </small>
                </span>
                <span className="fvc">
                  <I n="check" s={14} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="gl2">
            Gardées
            <span className="gcn">{others.length}</span>
          </div>
          <div className="ins">
            {others.map((b) => (
              <div key={b.name} className="it ro brr off">
                <span className="tx">
                  <span className="mono" title={b.name}>
                    {b.name}
                  </span>
                  <small>
                    {branchNote(b)} · {shortAgo(b.at, now)}
                  </small>
                </span>
                {b.state === "inUse" && (
                  <span className="rt">
                    <span className="dvon">Au travail</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {error && (
        <p className="pcw t-err" role="alert">
          {error}
        </p>
      )}
      {merged.length > 0 && (
        <div className="mga stk">
          <button
            className="b2 red press"
            disabled={busy || !count}
            onClick={() =>
              setConfirm({
                title: `Supprimer ${branches(count)} ?`,
                text: "Ne peut pas être annulé. GitHub n'est pas touché.",
                action: "Supprimer",
                run: remove,
              })
            }
          >
            {busy && <span className="t2-spin" />}
            {count ? `Supprimer ${branches(count)}` : "Supprimer"}
          </button>
        </div>
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function BranchCleanup(props: { open: boolean; project: Project; onClose: () => void }) {
  // While branches are deleted, the sheet stays: closing it would hide whether it worked.
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={props.open} onClose={() => !busy && props.onClose()} title="Branches" modal={busy}>
      {props.open && <Body project={props.project} onBusy={setBusy} />}
    </Sheet>
  );
}
