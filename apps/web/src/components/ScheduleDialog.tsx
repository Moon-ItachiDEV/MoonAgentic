import type {
  AgentInfo,
  Favorites,
  PermissionMode,
  Project,
  Schedule,
  ScheduleRepeat,
} from "@moonagentic/protocol";
import { useEffect, useState } from "react";
import { connection, newId } from "../connection.ts";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import {
  firstMoment,
  fromField,
  REPEATS,
  timeChange,
  titleFromText,
  toField,
} from "../schedule.ts";
import { type Choice, ChoiceRow } from "../v2/ChoiceRow.tsx";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { firstPick, type ModelPick } from "../model-pick.ts";

/**
 * Plans a task for later, or changes one already planned. At its time the server starts a
 * new thread of the project with the task's text; the agent is chosen here, once.
 */
export function ScheduleDialog({
  open,
  projects,
  projectId: firstProjectId,
  agents,
  favorites,
  text: initialText,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The projects a new task can be planned in. */
  projects: Project[];
  /** The project it opens on: the one in sight. */
  projectId: string | undefined;
  agents: AgentInfo[];
  favorites: Favorites;
  /** What was typed after `/planifier`. */
  text: string;
  /** The planned task being changed; a new one otherwise. */
  schedule?: Schedule | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [firstWhen, setFirstWhen] = useState("");
  const [when, setWhen] = useState("");
  const [repeat, setRepeat] = useState<ScheduleRepeat>("once");
  const [projectId, setProjectId] = useState(firstProjectId);
  const [pick, setPick] = useState<ModelPick | undefined>(undefined);
  // Nobody watches a planned task start: it asks before acting unless told otherwise.
  const [mode, setMode] = useState<PermissionMode>("supervised");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the task given, or from an empty one.
  useEffect(() => {
    if (!open) return;
    const first = toField(firstMoment(schedule, Date.now()));
    setText(schedule?.text ?? initialText);
    setTitle(schedule?.title ?? "");
    setFirstWhen(first);
    setWhen(first);
    setRepeat(schedule?.repeat ?? "once");
    setProjectId(schedule?.projectId ?? firstProjectId);
    setPick(
      schedule
        ? { agentId: schedule.agentId, ...(schedule.model ? { model: schedule.model } : {}) }
        : firstPick(agents, favorites),
    );
    setMode(schedule?.permissionMode ?? "supervised");
    setBusy(false);
    setError(null);
    // Read as they are when it opens: a list that moves under an open sheet changes nothing.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule?.id]);

  const project = projects.find((p) => p.id === projectId);
  const agentId = pick?.agentId ?? "";
  const agent = agents.find((a) => a.id === agentId);
  const model = pick?.model ?? "";
  const at = fromField(when);
  const ready = !!text.trim() && at !== null && (!!schedule || (!!agentId && !!project));

  const submit = async () => {
    if (!ready || busy || at === null) return;
    setBusy(true);
    setError(null);
    try {
      if (schedule) {
        // Only what changed is sent: a task left as it was keeps its time, and a paused one
        // stays paused. A one-time task that has run is planned again.
        const time = timeChange(schedule, { timeChanged: when !== firstWhen, repeat, at });
        await connection.request({
          type: "schedule.update",
          requestId: newId(),
          id: schedule.id,
          text: text.trim(),
          // Left empty, the name is taken from the task again.
          title: title.trim() || titleFromText(text),
          ...time,
        });
      } else if (project) {
        const picked = model || agent?.defaultModel;
        await connection.request({
          type: "schedule.add",
          requestId: newId(),
          projectId: project.id,
          text: text.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          agentId,
          ...(picked ? { model: picked } : {}),
          permissionMode: mode,
          ...(project.git ? { isolated: true } : {}),
          repeat,
          at,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const { groups, favoritesOnly } = routeChoices(agents, favorites, pick, all);
  const models: Choice[] = groups.flatMap((g) =>
    g.options.map((o) => ({ value: o.value, label: o.label, group: g.agent.name })),
  );
  const value = pick ? routeValue(pick.agentId, pick.model) : "";
  const label = schedule ? "Enregistrer" : "Planifier";

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title={schedule ? "Modifier la tâche planifiée" : "Planifier une tâche"}
      tall
      className="schd"
      right={
        <button
          className={`ok2 press${ready && !busy ? " on" : ""}`}
          aria-label={label}
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          <I n="check" s={19} />
        </button>
      }
    >
      <form
        className="sbody"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="gl2">Consigne</div>
        <div className="ins stw">
          <textarea
            className="sta"
            // Focused when the sheet opens, where the keyboard is wanted at once.
            ref={(el) => {
              if (el && open && !text && document.activeElement !== el) el.focus();
            }}
            aria-label="Tâche"
            required
            rows={3}
            value={text}
            placeholder="Lance les tests et corrige ce qui échoue"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <label className="fld">
          <input
            aria-label="Nom"
            value={title}
            maxLength={200}
            placeholder={text.trim() ? titleFromText(text) : "Nom"}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="gl2">Quand</div>
        <div className="chips wrap" role="radiogroup" aria-label="Répéter">
          {REPEATS.map((r) => (
            <button
              key={r.repeat}
              type="button"
              role="radio"
              aria-checked={repeat === r.repeat}
              aria-pressed={repeat === r.repeat}
              onClick={() => setRepeat(r.repeat)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="ins">
          <label className="it ro">
            <span className="tx">{repeat === "once" ? "Lancement" : "Premier lancement"}</span>
            <input
              className="dte"
              type="datetime-local"
              aria-label="Quand"
              required
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
        </div>
        <div className="gl2">Où et avec qui</div>
        <div className="ins">
          {schedule ? (
            <>
              <div className="it ro">
                <span className="tx">Projet</span>
                <span className="rt">{project?.name}</span>
              </div>
              <div className="it ro">
                <span className="tx">Agent</span>
                <span className="rt">{agent?.name ?? schedule.agentId}</span>
              </div>
              <div className="it ro">
                <span className="tx">Accès</span>
                <span className="rt">
                  {schedule.permissionMode === "full" ? "Accès complet" : "Me demander"}
                </span>
              </div>
            </>
          ) : (
            <>
              <ChoiceRow
                title="Projet"
                value={projectId ?? ""}
                shown={project?.name ?? ""}
                choices={projects.map((p) => ({ value: p.id, label: p.name }))}
                onPick={setProjectId}
              />
              <ChoiceRow
                title="Modèle"
                value={value}
                shown={
                  models.find((c) => c.value === value)?.label ??
                  (agents.some((a) => a.available) ? "" : "Aucun agent prêt")
                }
                choices={models}
                {...(favoritesOnly || all
                  ? {
                      more: {
                        label: all ? "Favoris" : "Tous",
                        on: all,
                        toggle: () => setAll((on) => !on),
                      },
                    }
                  : {})}
                onPick={(v) => setPick(parseRouteValue(v))}
              />
            </>
          )}
        </div>
        {!schedule && (
          <>
            <div className="gl2">Accès</div>
            <div className="seg" role="radiogroup" aria-label="Accès de l'agent">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "supervised"}
                aria-pressed={mode === "supervised"}
                onClick={() => setMode("supervised")}
              >
                <I n="hand" s={16} />
                Me demander
              </button>
              <button
                type="button"
                role="radio"
                className="f"
                aria-checked={mode === "full"}
                aria-pressed={mode === "full"}
                onClick={() => setMode("full")}
              >
                <I n="bolt" s={16} />
                Accès complet
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="ppill err" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
