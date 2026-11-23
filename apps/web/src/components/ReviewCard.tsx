import type {
  AgentInfo,
  PrReview,
  PrReviewer,
  ReviewPoint,
  ReviewSeverity,
  Thread,
} from "@moonagentic/protocol";
import { useState } from "react";
import { connection, newId } from "../connection.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

const MAKER: Record<string, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  antigravity: "Google",
};

const SEVERITY: Record<ReviewSeverity, string> = {
  critical: "Critique",
  major: "Majeur",
  minor: "Mineur",
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** The review's state in a few words, from what its reviewers are really doing. */
export function reviewHeadline(review: PrReview): string {
  const done = review.reviewers.filter((r) => r.status === "done").length;
  const n = review.reviewers.length;
  switch (review.phase) {
    case "preparing":
      return "Récupération de la PR…";
    case "reviewing":
      return `Relecture en cours · ${done} sur ${n}`;
    case "done":
      return done === n ? "Relue par les " + n : `Relue par ${done} sur ${n}`;
    case "failed":
      return "Revue en échec";
    case "stopped":
      return "Revue arrêtée";
  }
}

function reviewerState(r: PrReviewer, thread: Thread | undefined): { text: string; tone: string } {
  switch (r.status) {
    case "waiting":
      return { text: "Démarre", tone: "work" };
    case "running":
      if (thread?.status === "waiting") return { text: "T'attend", tone: "warn" };
      if (thread?.inLine) return { text: "Attend une place", tone: "muted" };
      return { text: "Relit", tone: "work" };
    case "done":
      return {
        text: r.findings?.length ? plural(r.findings.length, "constat", "constats") : "Rien relevé",
        tone: "ok",
      };
    case "failed":
      return { text: "Échec", tone: "err" };
    case "stopped":
      return { text: "Arrêté", tone: "muted" };
  }
}

const where = (p: Pick<ReviewPoint, "file" | "line">) =>
  p.file ? `${p.file}${p.line ? `:${p.line}` : ""}` : undefined;

/** The synthesis as a message for the thread that owns the pull request, to have it fixed. */
export function fixMessage(review: PrReview, name: (i: number) => string): string {
  const lines = [
    `Voici la synthèse de la relecture de la PR #${review.number} par ${review.reviewers.length} agents. Vérifie chaque point dans le code, corrige ceux qui sont réels, lance les tests, puis committe. Dis-moi ceux que tu écartes et pourquoi.`,
    "",
  ];
  for (const p of review.points ?? []) {
    const at = where(p);
    lines.push(
      `- [${SEVERITY[p.severity]}]${at ? ` ${at}` : ""} : ${p.title} (vu par ${p.by.map(name).join(", ")})`,
    );
    for (const note of p.notes)
      if (note.detail) lines.push(`  - ${name(note.by)} : ${note.detail}`);
  }
  return lines.join("\n");
}

function Point({
  point,
  name,
  agentOf,
}: {
  point: ReviewPoint;
  name: (i: number) => string;
  agentOf: (i: number) => Pick<AgentInfo, "id" | "short"> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const at = where(point);
  const said = point.notes.some((n) => n.detail || n.title !== point.title);
  return (
    <li className={`prr-pt${open ? " open" : ""}`}>
      <button
        type="button"
        className="prr-pt-h"
        aria-expanded={said ? open : undefined}
        onClick={() => said && setOpen((o) => !o)}
      >
        <span className={`prr-sev ${point.severity}`}>
          <i aria-hidden />
          {SEVERITY[point.severity]}
        </span>
        <span className="prr-pt-t">
          <span className="prr-pt-title">{point.title}</span>
          {at && <code className="prr-at">{at}</code>}
        </span>
        <span className="prr-by" aria-label={`Vu par ${point.by.map(name).join(", ")}`}>
          {point.by.map((i) => (
            <AgentBadge key={i} agent={agentOf(i)} small />
          ))}
        </span>
      </button>
      {point.divergent && (
        <span className="prr-div">
          Gravité discutée :{" "}
          {point.notes
            .map((n) => `${name(n.by)} ${SEVERITY[n.severity].toLowerCase()}`)
            .join(" · ")}
        </span>
      )}
      {open && (
        <ul className="prr-notes">
          {point.notes.map((n) => (
            <li key={n.by}>
              <b>{name(n.by)}</b>
              {n.title !== point.title && <span>{n.title}</span>}
              {n.detail && <p>{n.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * « /revue » on its own thread: each reviewer with its real state, then what they found put
 * together, common points first, as soon as one of them is done.
 */
export function ReviewCard({
  thread,
  review,
  threads,
  agents,
  onOpenThread,
}: {
  thread: Thread;
  review: PrReview;
  threads: Thread[];
  agents: AgentInfo[];
  onOpenThread: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const agentOf = (i: number) => {
    const r = review.reviewers[i];
    return r && (agents.find((a) => a.id === r.agentId) ?? { id: r.agentId, short: "?" });
  };
  const modelName = (r: PrReviewer) => {
    const agent = agents.find((a) => a.id === r.agentId);
    return r.model
      ? (agent?.models?.find((m) => m.id === r.model)?.name ?? r.model)
      : "Modèle par défaut";
  };
  const name = (i: number) => {
    const r = review.reviewers[i];
    return r ? (MAKER[r.agentId] ?? agents.find((a) => a.id === r.agentId)?.name ?? r.agentId) : "";
  };
  const atWork = review.phase === "preparing" || review.phase === "reviewing";
  const points = review.points ?? [];
  const common = points.filter((p) => p.by.length > 1);
  const single = points.filter((p) => p.by.length === 1);
  const anyDone = review.reviewers.some((r) => r.status === "done");
  // The thread whose branch is this pull request, to have the points fixed there.
  const owner = threads.find(
    (t) =>
      t.id !== thread.id &&
      t.projectId === thread.projectId &&
      !t.archived &&
      t.pr?.number === review.number &&
      (!review.repo || t.pr.url.includes(`/${review.repo}/pull/`)),
  );
  const act = (work: Promise<unknown>) => {
    setError(null);
    work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="prr" aria-label={`Revue de la PR #${review.number}`}>
      <header className="prr-h">
        {review.url ? (
          <a className="prr-num" href={review.url} target="_blank" rel="noreferrer">
            #{review.number} ↗
          </a>
        ) : (
          <span className="prr-num">#{review.number}</span>
        )}
        <span className={`prr-phase ${review.phase}`}>
          {atWork ? <StateGlyph kind="lit" size={13} /> : <i aria-hidden />}
          {reviewHeadline(review)}
        </span>
      </header>
      {review.title && <h3 className="prr-title">{review.title}</h3>}
      {review.error && <p className="prr-err">{review.error}</p>}

      <ul className="prr-rev">
        {review.reviewers.map((r, i) => {
          const own = r.threadId ? threads.find((t) => t.id === r.threadId) : undefined;
          const state = reviewerState(r, own);
          return (
            <li key={i}>
              <AgentBadge agent={agentOf(i)} small />
              <span className="prr-rev-n">
                <b>{name(i)}</b>
                <span>{modelName(r)}</span>
              </span>
              <span className={`prr-state ${state.tone}`}>
                {state.tone === "work" ? <StateGlyph kind="lit" size={13} /> : <i aria-hidden />}
                {state.text}
              </span>
              {(r.status === "failed" || r.status === "stopped") && own && (
                <button
                  type="button"
                  className="btn prr-btn"
                  onClick={() =>
                    act(
                      connection.request({
                        type: "review.retry",
                        requestId: newId(),
                        threadId: thread.id,
                        index: i,
                      }),
                    )
                  }
                >
                  Relancer
                </button>
              )}
              {own && (
                <button
                  type="button"
                  className="btn prr-btn ghost"
                  onClick={() => onOpenThread(own.id)}
                >
                  Ouvrir
                </button>
              )}
              {r.error && <span className="prr-rev-err">{r.error}</span>}
            </li>
          );
        })}
      </ul>

      {anyDone && (
        <div className="prr-syn">
          {points.length === 0 ? (
            <p className="prr-none">Aucun problème relevé.</p>
          ) : (
            <>
              {common.length > 0 && (
                <>
                  <h4>
                    Vus par plusieurs <span>{common.length}</span>
                  </h4>
                  <ul className="prr-pts">
                    {common.map((p, k) => (
                      <Point key={`c${k}`} point={p} name={name} agentOf={agentOf} />
                    ))}
                  </ul>
                </>
              )}
              {single.length > 0 && (
                <>
                  <h4>
                    Vus par un seul <span>{single.length}</span>
                  </h4>
                  <ul className="prr-pts">
                    {single.map((p, k) => (
                      <Point key={`s${k}`} point={p} name={name} agentOf={agentOf} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="prr-err">{error}</p>}
      <div className="prr-act">
        {atWork && (
          <button
            type="button"
            className="btn prr-btn stop"
            onClick={() => connection.send({ type: "review.stop", threadId: thread.id })}
          >
            Arrêter la revue
          </button>
        )}
        {!atWork && points.length > 0 && owner && !sent && (
          <button
            type="button"
            className="btn prr-btn acc"
            onClick={() =>
              act(
                connection
                  .request({
                    type: "thread.queue",
                    requestId: newId(),
                    threadId: owner.id,
                    text: fixMessage(review, name),
                  })
                  .then(() => {
                    setSent(true);
                    onOpenThread(owner.id);
                  }),
              )
            }
          >
            Faire corriger dans « {owner.title} »
          </button>
        )}
      </div>
    </section>
  );
}
