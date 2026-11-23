import type { MoonBranch, Project } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { branchNote, branches, deletedLine, targetsLabel } from "../branch-cleanup.ts";
import { connection, newId } from "../connection.ts";
import { shortAgo } from "../project-threads.ts";

type Listing = { targets: string[]; branches: MoonBranch[] };
type Result = { deleted: string[]; kept: { name: string; reason: string }[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Row({
  branch,
  now,
  picked,
  onPick,
}: {
  branch: MoonBranch;
  now: number;
  picked?: boolean;
  onPick?: (on: boolean) => void;
}) {
  const body = (
    <span className="bc-tx">
      <code title={branch.name}>{branch.name}</code>
      <small>
        {branchNote(branch)} · {shortAgo(branch.at, now)}
      </small>
    </span>
  );
  return (
    <li className="bc-row" data-state={branch.state}>
      {onPick ? (
        <label>
          <input type="checkbox" checked={!!picked} onChange={(e) => onPick(e.target.checked)} />
          {body}
        </label>
      ) : (
        body
      )}
    </li>
  );
}

/**
 * « Nettoyer les branches »: the project's `moon/*` branches whose work is already merged,
 * to delete those the user keeps ticked, after a second click. The others are only shown,
 * with why they stay. The server looks at each one again before it goes.
 */
export function BranchCleanup({ project, onClose }: { project: Project; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [now] = useState(() => Date.now());

  // Once the box is closed, a late answer changes nothing.
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

  // While branches are deleted, the box stays: closing it would hide whether it worked.
  const close = () => !busy && onClose();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const reply = await connection.ask({
        type: "project.deleteBranches",
        requestId: newId(),
        projectId: project.id,
        branches: [...picked],
      });
      setResult({ deleted: reply.deleted, kept: reply.kept });
      setSure(false);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const merged = listing?.branches.filter((b) => b.state === "merged") ?? [];
  const others = listing?.branches.filter((b) => b.state !== "merged") ?? [];
  const count = merged.filter((b) => picked.has(b.name)).length;
  const pick = (name: string, on: boolean) => {
    setSure(false);
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog branch-cleanup" role="dialog" aria-modal aria-labelledby="bc-title">
        <h2 id="bc-title">Nettoyer les branches</h2>
        {!listing && !error && <p>Je compare les branches moon/* du projet…</p>}
        {listing && (
          <p>
            {merged.length > 1
              ? `${branches(merged.length)} moon/* ont tout leur travail dans ${targetsLabel(listing.targets)} : les supprimer ne perd rien.`
              : merged.length
                ? `1 branche moon/* a tout son travail dans ${targetsLabel(listing.targets)} : la supprimer ne perd rien.`
                : listing.branches.length
                  ? "Aucune branche moon/* ne peut partir pour l'instant : vois ci-dessous pourquoi."
                  : "Ce projet n'a aucune branche moon/*."}
          </p>
        )}
        {result && (
          <div className="bc-result" role="status">
            {deletedLine(result.deleted.length, result.kept.length)}
            {result.kept.length > 0 && (
              <ul>
                {result.kept.map((k) => (
                  <li key={k.name}>
                    <code>{k.name}</code> : {k.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {merged.length > 0 && (
          <>
            <div className="bc-head">
              <h3>Fusionnées</h3>
              <button
                className="btn quiet sm"
                disabled={busy}
                onClick={() => {
                  setSure(false);
                  setPicked(
                    count === merged.length ? new Set() : new Set(merged.map((b) => b.name)),
                  );
                }}
              >
                {count === merged.length ? "Tout décocher" : "Tout cocher"}
              </button>
            </div>
            <ul className="bc-list">
              {merged.map((b) => (
                <Row
                  key={b.name}
                  branch={b}
                  now={now}
                  picked={picked.has(b.name)}
                  onPick={busy ? undefined : (on) => pick(b.name, on)}
                />
              ))}
            </ul>
          </>
        )}
        {others.length > 0 && (
          <details className="bc-others" open={merged.length === 0 || undefined}>
            <summary>
              {branches(others.length)} {others.length > 1 ? "gardées" : "gardée"}
            </summary>
            <ul className="bc-list">
              {others.map((b) => (
                <Row key={b.name} branch={b} now={now} />
              ))}
            </ul>
          </details>
        )}
        {error && <p className="error">{error}</p>}
        {sure && (
          <p className="bc-warn" role="alert">
            {`Supprimer ${branches(count)} de ce dépôt ne peut pas être annulé. Les branches sur GitHub ne sont pas touchées.`}
          </p>
        )}
        <div className="row">
          <button
            className="btn quiet"
            disabled={busy}
            onClick={sure ? () => setSure(false) : close}
          >
            {sure ? "Retour" : "Fermer"}
          </button>
          {count > 0 &&
            (sure ? (
              <button
                className="btn danger"
                autoFocus
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "Suppression…" : `Oui, supprimer ${branches(count)}`}
              </button>
            ) : (
              <button className="btn danger" disabled={busy} onClick={() => setSure(true)}>
                {`Supprimer ${branches(count)}…`}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
