import {
  REVIEW_JUDGE,
  REVIEW_SLOTS,
  slotReviewer,
  type AgentInfo,
  type Favorites,
  type Project,
  type TeamMember,
  type Thread,
} from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { I } from "../v2/I.tsx";
import { ModelPill } from "../v2/ModelPill.tsx";
import { Sheet } from "../v2/Sheet.tsx";

/** What was typed after « /revue », as the number the server reads: 113, #113 or its address. */
export const prRef = (typed: string) => typed.trim().split(/\s+/)[0] ?? "";

/**
 * « /revue » : a pull request read by three agents at once, one per model maker. Each slot
 * starts on the maker's best model for code review, or on the last ones picked here.
 */
export function ReviewDialog({
  open,
  project,
  agents,
  favorites,
  threads,
  saved,
  savedJudge,
  pr: initialPr,
  onClose,
  onStarted,
}: {
  open: boolean;
  /** The project whose pull request is read; none while the sheet is closed on a page without one. */
  project: Project | undefined;
  agents: AgentInfo[];
  favorites: Favorites;
  /** The threads, for the open pull requests of the project: one tap picks one. */
  threads: Thread[];
  /** The menus of the last review started, one per maker, kept by the server. */
  saved: (TeamMember | null)[] | undefined;
  /** Its judge; `null` when the user chose none. */
  savedJudge: TeamMember | null | undefined;
  pr: string;
  onClose: () => void;
  onStarted: (threadId: string) => void;
}) {
  const [pr, setPr] = useState(prRef(initialPr));
  // Until the user picks, a slot follows its default as the agents' models arrive; `null`
  // once the user said nobody.
  const [choices, setChoices] = useState<(TeamMember | null | undefined)[]>([]);
  const [supervised, setSupervised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [judgeChoice, setJudgeChoice] = useState<TeamMember | null | undefined>(undefined);

  // Each opening starts from the pull request given and from the reviewers as kept.
  useEffect(() => {
    if (!open) return;
    setPr(prRef(initialPr));
    setChoices([]);
    setJudgeChoice(undefined);
    setSupervised(false);
    setBusy(false);
    setError(null);
  }, [open, initialPr]);

  const reviewer = (i: number): TeamMember | undefined => {
    const chosen = choices[i];
    if (chosen !== undefined) return chosen ?? undefined;
    // Kept one per maker; an older list, only of those picked, says nothing of which slot.
    const kept = saved?.length === REVIEW_SLOTS.length ? saved[i] : undefined;
    if (kept === null) return undefined;
    if (kept && agents.some((a) => a.id === kept.agentId && a.available)) return kept;
    return slotReviewer(REVIEW_SLOTS[i]!, agents, favorites);
  };
  const reviewers = REVIEW_SLOTS.map((_, i) => reviewer(i));
  const judge: TeamMember | undefined =
    judgeChoice !== undefined
      ? (judgeChoice ?? undefined)
      : savedJudge === null
        ? undefined
        : savedJudge && agents.some((a) => a.id === savedJudge.agentId && a.available)
          ? savedJudge
          : slotReviewer(REVIEW_JUDGE, agents, favorites);
  const picked = reviewers.filter((r): r is TeamMember => !!r);
  const valid = /^#?\d{1,9}$/.test(pr) || /^https:\/\/github\.com\/[^\s]+\/pull\/\d+/.test(pr);
  const noGit = !!project && !project.git;
  // The project's pull requests still open, newest first: what a review is most often for.
  const known = threads
    .filter(
      (t) =>
        t.projectId === project?.id &&
        !t.archived &&
        t.pr &&
        (t.pr.state === "open" || t.pr.state === "draft"),
    )
    .sort((a, b) => (b.pr?.number ?? 0) - (a.pr?.number ?? 0))
    .slice(0, 6);
  const number = pr.replace(/^#/, "");

  // The models come from the agents themselves: each is asked once, as the model picker does.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!open || !project) return;
    for (const agent of agents) {
      if (!agent.available || agent.models || agent.modelsError) continue;
      if (asked.current.has(agent.id)) continue;
      asked.current.add(agent.id);
      connection.send({ type: "agent.discover", agentId: agent.id, projectId: project.id });
    }
  }, [open, agents, project]);

  const ready = !!project && valid && picked.length > 0 && !noGit;
  const submit = async () => {
    if (!ready || busy || !project) return;
    setBusy(true);
    setError(null);
    try {
      const id = await connection.request({
        type: "review.start",
        requestId: newId(),
        projectId: project.id,
        pr: number,
        reviewers: picked,
        slots: reviewers.map((r) => r ?? null),
        ...(supervised ? { supervised: true } : {}),
        ...(judge && picked.length > 1 ? { judge } : {}),
      });
      onStarted(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title="Relire une PR"
      tall
      className="rvsh"
    >
      <form
        className="sbody"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="gl2">PR</div>
        <label className="fld">
          <input
            // Focused when the sheet opens with no pull request yet.
            ref={(el) => {
              if (el && open && !pr && !known.length && document.activeElement !== el) el.focus();
            }}
            required
            value={pr}
            inputMode="url"
            placeholder="Numéro ou adresse"
            aria-label="Numéro ou adresse de la PR"
            onChange={(e) => setPr(e.target.value.trim())}
          />
        </label>
        {known.length > 0 && (
          <div className="ins" role="radiogroup" aria-label="Pull requests ouvertes">
            {known.map((t) => {
              const on = number === String(t.pr!.number);
              return (
                <button
                  key={t.id}
                  type="button"
                  className="it fva"
                  role="radio"
                  aria-checked={on}
                  aria-pressed={on}
                  onClick={() => setPr(String(t.pr!.number))}
                >
                  <span className="prn mono">#{t.pr!.number}</span>
                  <span className="tx">{t.title}</span>
                  <span className="fvc">
                    <I n="check" s={14} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="gl2">Relecteurs</div>
        <div className="ins">
          {REVIEW_SLOTS.map((slot, i) => (
            <div key={slot.vendor} className={`it ro tmrow${reviewers[i] ? "" : " off"}`}>
              <span className="tx">{slot.label}</span>
              <ModelPill
                label={`Relecteur ${slot.label}`}
                agents={agents}
                favorites={favorites}
                value={reviewers[i]}
                none="Personne"
                onChange={(m) =>
                  setChoices((c) => {
                    const next = [...c];
                    next[i] = m ?? null;
                    return next;
                  })
                }
              />
            </div>
          ))}
        </div>
        {picked.length > 1 && (
          <>
            <div className="gl2">Arbitre</div>
            <div className="ins">
              <div className={`it ro tmrow${judge ? "" : " off"}`}>
                <span className="tx">Désaccords</span>
                <ModelPill
                  label="Arbitre"
                  agents={agents}
                  favorites={favorites}
                  value={judge}
                  none="Personne"
                  onChange={(m) => setJudgeChoice(m ?? null)}
                />
              </div>
            </div>
          </>
        )}
        <div className="ins">
          <div className="it ro">
            <span className="tx">Accès supervisé</span>
            <button
              type="button"
              className="tog"
              role="switch"
              aria-checked={supervised}
              aria-label="Accès supervisé : chaque commande des relecteurs attend ton accord"
              onClick={() => setSupervised(!supervised)}
            />
          </div>
        </div>
        {noGit && project && (
          <p className="pcw t-err" role="alert">
            « {project.name} » n'est pas un dépôt git relié à GitHub
          </p>
        )}
        {error && (
          <p className="pcw t-err" role="alert">
            {error}
          </p>
        )}
        <div className="mga stk">
          <button className="b2 ink press" disabled={!ready || busy}>
            {busy ? "Lancement…" : "Lancer la revue"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
