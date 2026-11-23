import {
  REVIEW_JUDGE,
  REVIEW_SLOTS,
  slotReviewer,
  type AgentInfo,
  type Favorites,
  type Project,
  type TeamMember,
} from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection, newId } from "../connection.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { AgentBadge } from "./AgentBadge.tsx";

/** What was typed after « /revue », as the number the server reads: 113, #113 or its address. */
export const prRef = (typed: string) => typed.trim().split(/\s+/)[0] ?? "";

/**
 * « /revue » : a pull request read by three agents at once, one per model maker. Each slot
 * starts on the maker's best model for code review, or on the last ones picked here.
 */
export function ReviewDialog({
  project,
  agents,
  favorites,
  saved,
  savedJudge,
  pr: initialPr,
  onClose,
  onStarted,
}: {
  project: Project;
  agents: AgentInfo[];
  favorites: Favorites;
  /** The reviewers of the last review started, kept by the server. */
  saved: TeamMember[] | undefined;
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
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reviewer = (i: number): TeamMember | undefined => {
    const chosen = choices[i];
    if (chosen !== undefined) return chosen ?? undefined;
    const kept = saved?.[i];
    if (kept && agents.some((a) => a.id === kept.agentId && a.available)) return kept;
    return slotReviewer(REVIEW_SLOTS[i]!, agents, favorites);
  };
  const reviewers = REVIEW_SLOTS.map((_, i) => reviewer(i));
  const [judgeChoice, setJudgeChoice] = useState<TeamMember | null | undefined>(undefined);
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

  // The models come from the agents themselves: each is asked once, as the model picker does.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const agent of agents) {
      if (!agent.available || agent.models || agent.modelsError) continue;
      if (asked.current.has(agent.id)) continue;
      asked.current.add(agent.id);
      connection.send({ type: "agent.discover", agentId: agent.id, projectId: project.id });
    }
  }, [agents, project.id]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, busy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !picked.length || !project.git) return;
    setBusy(true);
    setError(null);
    try {
      const id = await connection.request({
        type: "review.start",
        requestId: newId(),
        projectId: project.id,
        pr: pr.replace(/^#/, ""),
        reviewers: picked,
        ...(judge && picked.length > 1 ? { judge } : {}),
      });
      onStarted(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog prr-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="prr-title"
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="prr-title">Relire une PR à {picked.length || 3}</h2>
        <p>
          Chaque agent lit la PR dans son fil, sans rien modifier, puis juge les constats des
          autres. L'arbitre tranche ce qui reste contesté.
        </p>
        <label className="field">
          Pull request
          <input
            autoFocus={!pr}
            required
            inputMode="numeric"
            value={pr}
            placeholder="113"
            aria-label="Numéro ou adresse de la PR"
            onChange={(e) => setPr(e.target.value.trim())}
          />
        </label>
        <div className="prr-slots">
          {REVIEW_SLOTS.map((slot, i) => (
            <div key={slot.vendor} className="prr-slot">
              <span className="prr-maker">{slot.label}</span>
              <SlotSelect
                className="prr-pick"
                label={`Relecteur ${slot.label}`}
                agents={agents}
                favorites={favorites}
                value={reviewers[i]}
                showAll={showAll}
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
          {picked.length > 1 && (
            <div className="prr-slot">
              <span className="prr-maker">Arbitre</span>
              <SlotSelect
                className="prr-pick"
                label="Arbitre"
                agents={agents}
                favorites={favorites}
                value={judge}
                showAll={showAll}
                none="Personne"
                onChange={(m) => setJudgeChoice(m ?? null)}
              />
            </div>
          )}
          <button type="button" className="prr-all" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Seulement mes favoris" : "Afficher tous les modèles"}
          </button>
        </div>
        {!project.git && (
          <p className="error">« {project.name} » n'est pas un dépôt git relié à GitHub.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn quiet" disabled={busy} onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn pri"
            autoFocus={!!pr}
            disabled={busy || !valid || !picked.length || !project.git}
          >
            {busy ? "Lancement…" : "Lancer la revue"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * One slot's menu: the favorite models, grouped by agent, or every model with `showAll`
 * (one switch for the whole dialog). The chosen agent's badge sits beside it.
 */
function SlotSelect(props: {
  label: string;
  agents: AgentInfo[];
  favorites: Favorites;
  value: TeamMember | undefined;
  showAll: boolean;
  none: string;
  onChange: (member: TeamMember | undefined) => void;
  className: string;
}) {
  const { value } = props;
  const { groups } = routeChoices(props.agents, props.favorites, value, props.showAll);
  const agent = value && props.agents.find((a) => a.id === value.agentId);
  return (
    <label className={props.className}>
      {value && <AgentBadge agent={agent ?? { id: value.agentId, short: "?" }} small />}
      <select
        aria-label={props.label}
        value={value ? routeValue(value.agentId, value.model) : ""}
        onChange={(e) => props.onChange(parseRouteValue(e.target.value))}
      >
        <option value="">{props.none}</option>
        {groups.map((g) => (
          <optgroup key={g.agent.id} label={g.agent.name}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
