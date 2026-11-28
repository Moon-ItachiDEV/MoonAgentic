import {
  reviewAtWork,
  type AgentInfo,
  type PrJudge,
  type PrReview,
  type PrReviewer,
  type ReviewPoint,
  type ReviewSeverity,
  type Thread,
} from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { modelNameOf } from "../model-label.ts";
import { Glyph, I } from "../v2/I.tsx";
import { Masc } from "../v2/Masc.tsx";
import type { FrostMoonPhase, FrostMoonState } from "./FrostMoon.tsx";
import { clock } from "../team-rows.ts";

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
    case "debating": {
      const weighed = review.reviewers.filter((r) => r.debate && r.debate !== "running").length;
      const all = review.reviewers.filter((r) => r.debate).length;
      return `Confrontation · ${weighed} sur ${all}`;
    }
    case "judging":
      return "L'arbitre tranche…";
    case "done":
      return done === n ? "Relue par les " + n : `Relue par ${done} sur ${n}`;
    case "failed":
      return "Revue en échec";
    case "stopped":
      return "Revue arrêtée";
  }
}

export function reviewerState(
  r: PrReviewer,
  thread: Thread | undefined,
  review: PrReview,
): { text: string; tone: string } {
  if (r.debate === "running") {
    if (thread?.status === "waiting") return { text: "T'attend", tone: "warn" };
    if (thread?.inLine) return { text: "Attend une place", tone: "muted" };
    return { text: "Confronte", tone: "work" };
  }
  if (r.debate === "failed") return { text: "Confrontation en échec", tone: "err" };
  switch (r.status) {
    case "waiting":
      // A review that failed or was stopped before them never starts them.
      return reviewAtWork(review)
        ? { text: "Démarre", tone: "work" }
        : { text: "Pas lancé", tone: "muted" };
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

function judgeState(
  judge: PrJudge,
  review: PrReview,
  thread: Thread | undefined,
): { text: string; tone: string } {
  switch (judge.status) {
    case undefined:
      return reviewAtWork(review)
        ? { text: "Tranche s'il reste un désaccord", tone: "muted" }
        : { text: "Aucun désaccord à trancher", tone: "muted" };
    case "running":
      if (thread?.status === "waiting") return { text: "T'attend", tone: "warn" };
      if (thread?.inLine) return { text: "Attend une place", tone: "muted" };
      return { text: "Tranche", tone: "work" };
    case "done": {
      const n = judge.rulings?.length ?? 0;
      return { text: `${plural(n, "point tranché", "points tranchés")}`, tone: "ok" };
    }
    case "failed":
      return { text: "Échec", tone: "err" };
    case "stopped":
      return { text: "Arrêté", tone: "muted" };
  }
}

const VERDICT: Record<string, string> = {
  agree: "d'accord",
  disagree: "pas d'accord",
  withdraw: "retire son constat",
};

/** Points that still stand: neither taken back by who found them nor rejected by the judge. */
const stands = (p: ReviewPoint) => p.outcome !== "withdrawn" && p.outcome !== "rejected";

const where = (p: Pick<ReviewPoint, "file" | "line">) =>
  p.file ? `${p.file}${p.line ? `:${p.line}` : ""}` : undefined;

/** The synthesis as a message for the thread that owns the pull request, to have it fixed. */
export function fixMessage(review: PrReview, name: (i: number) => string): string {
  const lines = [
    `Voici la synthèse de la relecture de la PR #${review.number} par ${review.reviewers.length} agents. Vérifie chaque point dans le code, corrige ceux qui sont réels, lance les tests, puis committe. Dis-moi ceux que tu écartes et pourquoi.`,
    "",
  ];
  for (const p of (review.points ?? []).filter(stands)) {
    const at = where(p);
    lines.push(
      `- [${SEVERITY[p.severity]}]${at ? ` ${at}` : ""} : ${p.title} (vu par ${p.by.map(name).join(", ")})`,
    );
    for (const note of p.notes)
      if (note.detail) lines.push(`  - ${name(note.by)} : ${note.detail}`);
    if (p.ruling?.reason) lines.push(`  - Arbitre : ${p.ruling.reason}`);
  }
  return lines.join("\n");
}

/** What a reviewer's mascot shows: the three are told apart by their shape. */
const SHAPES: FrostMoonPhase[] = ["star", "crescent", "planet"];

/** The line's look and its mascot's eyes, from a reviewer's or the judge's real state. */
const rowLook = (tone: string, found: boolean): { state: string; face: FrostMoonState } =>
  tone === "work"
    ? { state: "run", face: "lit" }
    : tone === "warn"
      ? { state: "run", face: "attend" }
      : tone === "ok"
        ? // Red eyes once it found something to correct.
          { state: "ok", face: found ? "erreur" : "termine" }
        : tone === "err"
          ? { state: "stop", face: "erreur" }
          : { state: "idle", face: "file" };

function Point({
  point,
  name,
  open,
  onToggle,
}: {
  point: ReviewPoint;
  name: (i: number) => string;
  open: boolean;
  onToggle: () => void;
}) {
  const at = where(point);
  const notes = point.notes.filter((n) => n.detail || n.title !== point.title);
  // A finder agreeing with its own point says nothing new.
  const votes = (point.votes ?? []).filter(
    (v) => !point.by.includes(v.by) || v.verdict !== "agree" || v.severity,
  );
  const off = !stands(point);
  const said = notes.length > 0 || votes.length > 0 || !!point.ruling?.reason || point.divergent;
  const seen = point.ruling
    ? `Tranché : ${point.ruling.real ? "réel" : "écarté"}`
    : off
      ? "Retiré"
      : `${SEVERITY[point.severity]} · vu par ${point.by.length}`;
  return (
    <button
      type="button"
      className={`rvf${open ? " on" : ""}${off ? " off" : ""}`}
      aria-expanded={said ? open : undefined}
      aria-label={`${SEVERITY[point.severity]} : ${point.title}, vu par ${point.by.map(name).join(", ")}`}
      onClick={() => said && onToggle()}
    >
      <i className={`sv${!off && point.severity !== "minor" ? " b" : ""}`} />
      <span className="tx">
        <span className="t">{point.title}</span>
        <span className="m">
          {at && <span className="mono">{at}</span>}
          <span>{seen}</span>
        </span>
        {open && (
          <span className="w">
            {point.divergent && (
              <span className="wl">
                Gravité discutée :{" "}
                {point.notes
                  .map((n) => `${name(n.by)} ${SEVERITY[n.severity].toLowerCase()}`)
                  .join(" · ")}
              </span>
            )}
            {notes.map((n) => (
              <span key={n.by} className="wl">
                <b>{name(n.by)}</b>
                {n.title !== point.title && ` · ${n.title}`}
                {n.detail && ` : ${n.detail}`}
              </span>
            ))}
            {votes.map((v) => (
              <span key={`v${v.by}`} className="wl">
                <b>
                  {name(v.by)}, {VERDICT[v.verdict]}
                  {v.severity && ` (${SEVERITY[v.severity].toLowerCase()})`}
                </b>
                {v.reason && ` : ${v.reason}`}
              </span>
            ))}
            {point.ruling?.reason && (
              <span className="wl">
                <b>Arbitre</b> : {point.ruling.reason}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * « /revue » on its own thread, as the mockup draws it: where the review is, each reviewer
 * with its mascot and its real state, then what they found, as soon as one of them is done.
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
  const [openPoint, setOpenPoint] = useState<number | null>(null);
  const [showOff, setShowOff] = useState(false);
  const modelName = (r: { agentId: string; model?: string | undefined }) => {
    const agent = agents.find((a) => a.id === r.agentId);
    return modelNameOf(agent?.models, r.model) ?? "Modèle par défaut";
  };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  // A reviewer goes by its agent's name, or by its model when two share an agent.
  const name = (i: number) => {
    const r = review.reviewers[i];
    if (!r) return "";
    const shared = review.reviewers.filter((x) => x.agentId === r.agentId).length > 1;
    return shared ? modelName(r) : agentName(r.agentId);
  };
  const atWork = reviewAtWork(review);
  // The present moves on, once a second, only while the review runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!atWork) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [atWork]);
  const points = review.points ?? [];
  const standing = points.filter(stands);
  const gone = points.filter((p) => !stands(p));
  const judge = review.judge;
  const judgeThread = judge?.threadId ? threads.find((t) => t.id === judge.threadId) : undefined;
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
  // The four steps of a review, and the one it is at.
  const step = {
    preparing: 0,
    reviewing: 0,
    debating: 1,
    judging: 2,
    done: 4,
    failed: -1,
    stopped: -1,
  }[review.phase];
  const steps = ["Lecture", "Confrontation", "Arbitrage", "Verdict"];
  const confirmed = standing.filter((p) => p.outcome === "confirmed" && !p.ruling).length;
  const ruled = points.filter((p) => p.ruling).length;
  const debated = review.phase !== "debating" && points.some((p) => p.outcome);
  const fixable = !atWork && standing.length > 0 && !!owner;
  // Failed before any reviewer started: the pull request could not be read, say.
  const restartable = review.phase === "failed" && !thread.workspace;

  return (
    <section className="tmc" aria-label={`Revue de la PR #${review.number}`}>
      <div className="tmh">
        <span className="ppill">
          {atWork ? <Glyph /> : review.phase === "done" ? <I n="check" s={13} /> : null}
          {review.phase === "done" && anyDone
            ? `Verdict · ${standing.length} ${standing.length > 1 ? "points" : "point"}`
            : reviewHeadline(review)}
        </span>
        {review.title && <span className="tmo">{review.title}</span>}
        <span className="tmt" role="timer">
          {clock((review.endedAt ?? now) - review.startedAt)}
        </span>
      </div>
      {step >= 0 && (
        <div className="rvph" aria-hidden>
          {steps.map((label, i) => (
            <span key={label} className={i < step ? "ok" : i === step ? "run" : ""}>
              {label}
            </span>
          ))}
        </div>
      )}
      {review.error && <p className="pcw t-err">{review.error}</p>}

      <div className="tml">
        {review.reviewers.map((r, i) => {
          const own = r.threadId ? threads.find((t) => t.id === r.threadId) : undefined;
          const state = reviewerState(r, own, review);
          const look = rowLook(state.tone, !!r.findings?.length);
          const failed = (r.status === "failed" || r.status === "stopped") && !!own;
          return (
            <div key={i} className={`tmr ${look.state}`}>
              <button
                type="button"
                className="tmrb"
                disabled={!own}
                aria-label={`${agentName(r.agentId)}, ${modelName(r)} : ${state.text}`}
                onClick={() => own && onOpenThread(own.id)}
              >
                <span className="tmb mb">
                  <Masc job="rev" state={look.face} phase={SHAPES[i % SHAPES.length]!} />
                  <i />
                </span>
                <span className="tx">
                  <span className="nm">
                    {agentName(r.agentId)}
                    <small>{modelName(r)}</small>
                  </span>
                  <small className={`ds${state.tone === "err" ? " mer" : ""}`}>
                    {state.tone === "work" ? (
                      <span className="shimmer">{state.text}</span>
                    ) : (
                      state.text
                    )}
                    {r.error && ` · ${r.error}`}
                  </small>
                </span>
              </button>
              {failed && (
                <button
                  type="button"
                  className="mini press"
                  aria-label={`Relancer ${agentName(r.agentId)}`}
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
            </div>
          );
        })}
        {judge &&
          (() => {
            const state = judgeState(judge, review, judgeThread);
            const look = rowLook(state.tone, false);
            return (
              <div className={`tmr ${look.state}`}>
                <button
                  type="button"
                  className="tmrb"
                  disabled={!judgeThread}
                  aria-label={`Arbitre, ${modelName(judge)} : ${state.text}`}
                  onClick={() => judgeThread && onOpenThread(judgeThread.id)}
                >
                  <span className="tmb mb">
                    <Masc job="arb" state={look.face} />
                    <i />
                  </span>
                  <span className="tx">
                    <span className="nm">
                      Arbitre
                      <small>{modelName(judge)}</small>
                    </span>
                    <small className={`ds${state.tone === "err" ? " mer" : ""}`}>
                      {state.tone === "work" ? (
                        <span className="shimmer">{state.text}</span>
                      ) : (
                        state.text
                      )}
                      {judge.error && ` · ${judge.error}`}
                    </small>
                  </span>
                </button>
              </div>
            );
          })()}
      </div>

      {anyDone && points.length === 0 && (
        <div className="rvc">
          <span>Aucun problème relevé</span>
        </div>
      )}
      {anyDone && points.length > 0 && (
        <>
          <div className="rvc">
            {debated ? (
              <>
                <span>
                  <b>{confirmed}</b> {confirmed > 1 ? "confirmés" : "confirmé"}
                </span>
                {ruled > 0 && (
                  <span>
                    <b>{ruled}</b> {ruled > 1 ? "tranchés" : "tranché"}
                  </span>
                )}
                <span>
                  <b>{gone.length}</b> {gone.length > 1 ? "retirés" : "retiré"}
                </span>
              </>
            ) : (
              <>
                <span>
                  <b>{points.filter((p) => p.by.length > 1).length}</b> vus par plusieurs
                </span>
                <span>
                  <b>{points.filter((p) => p.by.length === 1).length}</b> vus par un seul
                </span>
              </>
            )}
          </div>
          <div className="rvl">
            {standing.map((p) => {
              const index = points.indexOf(p);
              return (
                <Point
                  key={index}
                  point={p}
                  name={name}
                  open={openPoint === index}
                  onToggle={() => setOpenPoint(openPoint === index ? null : index)}
                />
              );
            })}
            {gone.length > 0 && (
              <button
                type="button"
                className="rvw"
                aria-expanded={showOff}
                onClick={() => setShowOff(!showOff)}
              >
                <I n={showOff ? "down" : "right"} s={14} />
                {gone.length} {gone.length > 1 ? "retirés" : "retiré"}
              </button>
            )}
            {showOff &&
              gone.map((p) => {
                const index = points.indexOf(p);
                return (
                  <Point
                    key={index}
                    point={p}
                    name={name}
                    open={openPoint === index}
                    onToggle={() => setOpenPoint(openPoint === index ? null : index)}
                  />
                );
              })}
          </div>
        </>
      )}

      {error && <p className="pcw t-err">{error}</p>}
      {atWork ? (
        <div className="pra">
          <button
            type="button"
            className="b2 soft press"
            onClick={() => connection.send({ type: "review.stop", threadId: thread.id })}
          >
            Arrêter la revue
          </button>
        </div>
      ) : restartable ? (
        <div className="pra">
          <button
            type="button"
            className="b2 ink press"
            onClick={() =>
              act(
                connection.request({
                  type: "review.restart",
                  requestId: newId(),
                  threadId: thread.id,
                }),
              )
            }
          >
            Relancer la revue
          </button>
        </div>
      ) : (
        (review.url || fixable) && (
          <div className={`rva${review.url && fixable ? "" : " one"}`}>
            {review.url && (
              <a className="b2 soft press" href={review.url} target="_blank" rel="noreferrer">
                Voir la PR
              </a>
            )}
            {fixable && owner && (
              <button
                type="button"
                className="b2 ink press"
                disabled={sent}
                aria-label={`Faire corriger dans « ${owner.title} »`}
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
                {sent ? (
                  <>
                    <I n="check" s={16} />
                    Envoyé
                  </>
                ) : (
                  "Faire corriger"
                )}
              </button>
            )}
          </div>
        )
      )}
    </section>
  );
}
