import type {
  AgentInfo,
  Favorites,
  PermissionMode,
  Project,
  TeamMember,
} from "@moonagentic/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connection, newId } from "../connection.ts";
import { presetMembers, type TeamRole, teamPresets, withRoles } from "../team-presets.ts";
import { I } from "../v2/I.tsx";
import { ModelPill } from "../v2/ModelPill.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { Galaxy } from "./Picker.tsx";

const ROLES: { role: TeamRole; label: string; optional?: true }[] = [
  { role: "lead", label: "Chef" },
  { role: "coder", label: "Codeurs" },
  { role: "reviewer", label: "Relecture", optional: true },
  { role: "reviewer2", label: "Relecture 2", optional: true },
  { role: "judge", label: "Arbitre", optional: true },
  { role: "tester", label: "Tests", optional: true },
  { role: "merger", label: "Fusion", optional: true },
];

/** The suggested teams by their ids, from the most sparing to the most careful. */
const SLIDER_ORDER = ["economique", "equilibree", "qualite"];
const TOP_PRESET = "qualite";

/**
 * The saved teams on one slider, the most careful last: the same thumb as the effort's. The
 * last one of several gets the field of stars.
 */
function TeamSlide(props: {
  names: string[];
  index: number;
  /** The team in sight is the most careful one: it gets the field of stars. */
  top: boolean;
  onPick: (index: number) => void;
}) {
  const n = props.names.length;
  const { index } = props;
  const track = useRef<HTMLDivElement>(null);
  /** Where the finger is while it drags, from 0 to 1: the thumb follows it, then settles. */
  const [drag, setDrag] = useState<number | null>(null);
  const pressed = useRef(false);
  const raw = (x: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 52) return 0;
    return Math.max(0, Math.min(1, (x - box.left - 26) / (box.width - 52)));
  };
  const at = (x: number) => (n < 2 ? index : Math.round(raw(x) * (n - 1)));
  const pick = (i: number) => i !== index && i >= 0 && i < n && props.onPick(i);
  const x = (i: number) => (n < 2 ? 0 : i / (n - 1));
  const top = n > 1 && props.top;
  // Reached while the sheet is open, the top team arrives once with its show; opened on it, calm.
  const below = useRef(!top);
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if (!top) {
      below.current = true;
      setIntro(false);
      return;
    }
    if (!below.current) return;
    below.current = false;
    setIntro(true);
    const timer = setTimeout(() => setIntro(false), 1700);
    return () => clearTimeout(timer);
  }, [top]);
  // The way a new team's name comes in: from the side it was reached by.
  const before = useRef(index);
  const dir = index > before.current ? -1 : 1;
  useEffect(() => {
    before.current = index;
  }, [index]);
  const letGo = () => {
    pressed.current = false;
    setDrag(null);
  };
  return (
    <div className="tsl">
      <b
        key={index}
        className={`ev in${top ? " gx" : ""}${top && intro ? " shine" : ""}`}
        style={{ "--dir": dir } as React.CSSProperties}
      >
        {props.names[index]}
      </b>
      {n > 1 && (
        <>
          <div
            ref={track}
            className={`etrack${top ? " gx" : ""}${intro ? " gx-in" : ""}${drag !== null ? " drag" : ""}`}
            role="slider"
            tabIndex={0}
            aria-label="Équipe"
            aria-valuemin={0}
            aria-valuemax={n - 1}
            aria-valuenow={index}
            aria-valuetext={props.names[index]}
            style={{ "--p": drag ?? x(index) } as React.CSSProperties}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pressed.current = true;
              // A click without moving jumps to the nearest stop.
              pick(at(e.clientX));
            }}
            onPointerMove={(e) => {
              if (!pressed.current) return;
              setDrag(raw(e.clientX));
              pick(at(e.clientX));
            }}
            onPointerUp={letGo}
            onPointerCancel={letGo}
            onKeyDown={(e) => {
              const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
              if (step) {
                e.preventDefault();
                pick(index + step);
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                pick(e.key === "Home" ? 0 : n - 1);
              }
            }}
          >
            {top && <Galaxy intro={intro} />}
            <i className="fill" />
            {props.names.map((name, i) => (
              <i key={name + i} className="nt" style={{ "--x": x(i) } as React.CSSProperties} />
            ))}
            <span className="th">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10.6 3.3A5 5 0 1 0 12.7 9 4 4 0 0 1 10.6 3.3z" fill="currentColor" />
                <ellipse
                  cx="8"
                  cy="8"
                  rx="7"
                  ry="2.6"
                  transform="rotate(-24 8 8)"
                  stroke="currentColor"
                  strokeWidth="1"
                  opacity=".7"
                />
              </svg>
            </span>
          </div>
          <div className="ends" aria-hidden="true">
            <span>Plus économe</span>
            <span>Plus soigné</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Gives a task to a team: a lead plans it, then coders do the pieces at once. */
export function TeamDialog({
  open,
  project,
  agents,
  favorites,
  task: initialTask,
  onClose,
  onStarted,
}: {
  open: boolean;
  /** The project the team works in; none while the sheet is closed on a page without one. */
  project: Project | undefined;
  agents: AgentInfo[];
  favorites: Favorites;
  task: string;
  onClose: () => void;
  onStarted: (leadId: string) => void;
}) {
  const [task, setTask] = useState(initialTask);
  // The user's teams from the settings, or the suggested ones until they set theirs up.
  const saved = useSyncExternalStore(connection.subscribe, () => connection.getState().teamPresets);
  const listed = teamPresets(saved ?? undefined, agents);
  // On the slider the suggested teams go from the most sparing to the most careful, as in
  // the mockup; the user's own follow, in their order.
  const rank = (id: string) => {
    const at = SLIDER_ORDER.indexOf(id);
    return at < 0 ? SLIDER_ORDER.length : at;
  };
  const presets = [...listed].sort((a, b) => rank(a.id) - rank(b.id));
  // It opens on the first team of the list, as it always did.
  const [presetId, setPresetId] = useState(() => listed[0]?.id);
  const preset = presets.find((p) => p.id === presetId) ?? listed[0];
  const fromPreset = preset ? presetMembers(preset, agents) : {};
  // Until the user picks, a role follows the team and the agents as their models arrive;
  // `null` once the user said nobody, and the team does without that role.
  const [choices, setChoices] = useState<Partial<Record<TeamRole, TeamMember | null>>>({});
  const member = (role: TeamRole) => {
    const chosen = choices[role];
    return chosen === undefined ? fromPreset[role] : (chosen ?? undefined);
  };
  const [keptFor, setKeptFor] = useState<string>();
  const choose = (role: TeamRole) => (m: TeamMember | undefined) => {
    setChoices((c) => ({ ...c, [role]: m ?? null }));
    setKeptFor(undefined);
    setMissing(null);
  };
  const lead = member("lead");
  const coder = member("coder");
  const reviewer = member("reviewer");
  // A second review and a judge only come with a first review.
  const reviewer2 = reviewer && member("reviewer2");
  const judge = reviewer && member("judge");
  const inTeam = (role: TeamRole) =>
    role === "reviewer2" ? reviewer2 : role === "judge" ? judge : member(role);
  const tester = member("tester");
  const merger = member("merger");
  const noGit = !!project && !project.git;
  const [coders, setCoders] = useState(2);
  const [mode, setMode] = useState<PermissionMode>("full");
  const [autoShip, setAutoShip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the team still needs, said when « Lancer l'équipe » is tapped without it. */
  const [missing, setMissing] = useState<string | null>(null);
  const taskField = useRef<HTMLTextAreaElement | null>(null);

  // Each opening starts from the task given and from the teams as saved.
  useEffect(() => {
    if (!open) return;
    setTask(initialTask);
    setChoices({});
    setKeptFor(undefined);
    setBusy(false);
    setError(null);
    setMissing(null);
  }, [open, initialTask]);

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

  const submit = async () => {
    if (busy || !project || noGit) return;
    // The button stays live: a tap that cannot launch says why rather than doing nothing. The
    // task's field is focused within the tap itself, so that the phone's keyboard comes up.
    if (!task.trim()) {
      setMissing("Écris d'abord la tâche de l'équipe.");
      taskField.current?.focus();
      return;
    }
    if (!lead || !coder) {
      setMissing("Choisis d'abord un chef et un codeur.");
      return;
    }
    setMissing(null);
    setBusy(true);
    setError(null);
    try {
      const id = await connection.request({
        type: "team.start",
        requestId: newId(),
        projectId: project.id,
        task: task.trim(),
        lead,
        coder,
        ...(reviewer ? { reviewer } : {}),
        ...(reviewer2 ? { reviewer2 } : {}),
        ...(judge ? { judge } : {}),
        ...(tester ? { tester } : {}),
        ...(merger ? { merger } : {}),
        coders,
        permissionMode: mode,
        autoShip,
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
      title="Confier à une équipe"
      tall
      className="tmsh"
    >
      <form
        className="sbody"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TeamSlide
          names={presets.map((p) => p.label)}
          index={Math.max(
            0,
            presets.findIndex((p) => p.id === preset?.id),
          )}
          top={preset?.id === TOP_PRESET}
          onPick={(i) => {
            setPresetId(presets[i]?.id);
            setChoices({});
            setKeptFor(undefined);
          }}
        />
        <div className="ins stw">
          <textarea
            className="sta"
            // Focused when the sheet opens with no task yet, where the keyboard is wanted at once.
            ref={(el) => {
              taskField.current = el;
              if (el && open && !task && document.activeElement !== el) el.focus();
            }}
            aria-label="Tâche"
            aria-required="true"
            aria-invalid={missing !== null && !task.trim()}
            rows={3}
            value={task}
            placeholder="Ajoute l'export CSV aux rapports"
            onChange={(e) => {
              setTask(e.target.value);
              setMissing(null);
            }}
          />
        </div>
        {missing && (
          <p className="pcw t-err" role="alert">
            {missing}
          </p>
        )}
        <div className="ins tmrs" key={preset?.id}>
          {ROLES.map(({ role, label, optional }) => (
            <div key={role} className={`it ro tmrow${inTeam(role) ? "" : " off"}`}>
              <span className="tx">{label}</span>
              {role === "coder" && (
                <span className="stpr" role="group" aria-label="Codeurs en même temps">
                  <button
                    type="button"
                    aria-label="Moins"
                    disabled={coders <= 1}
                    onClick={() => setCoders(coders - 1)}
                  >
                    −
                  </button>
                  <b key={coders} className="bump">
                    {coders}
                  </b>
                  <button
                    type="button"
                    aria-label="Plus"
                    disabled={coders >= 4}
                    onClick={() => setCoders(coders + 1)}
                  >
                    +
                  </button>
                </span>
              )}
              <ModelPill
                label={label}
                agents={agents}
                favorites={favorites}
                value={member(role)}
                onChange={choose(role)}
                {...(optional ? { none: "Personne" } : {})}
              />
            </div>
          ))}
        </div>
        {preset && Object.keys(choices).length > 0 && (
          <button
            type="button"
            className="ppill tmkeep"
            disabled={keptFor === preset.id}
            onClick={() => {
              // Kept for every device: the next /equipe and the coordinator start from it.
              connection.send({
                type: "teamPresets.set",
                presets: withRoles(presets, preset.id, {
                  lead,
                  coder,
                  reviewer,
                  reviewer2: member("reviewer2"),
                  judge: member("judge"),
                  tester,
                  merger,
                }),
              });
              setKeptFor(preset.id);
            }}
          >
            {keptFor === preset.id ? (
              <>
                <I n="check" s={13} />
                Gardé
              </>
            ) : (
              `Garder pour « ${preset.label} »`
            )}
          </button>
        )}
        <div className="seg" role="radiogroup" aria-label="Accès des codeurs">
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
        <div className="ins">
          <div className="it ro">
            <span className="tx">Ouvrir la PR à la fin</span>
            <button
              type="button"
              className="tog"
              role="switch"
              aria-checked={autoShip}
              aria-label="Ouvrir la PR à la fin"
              onClick={() => setAutoShip(!autoShip)}
            />
          </div>
        </div>
        {noGit && project && (
          <p className="pcw t-err" role="alert">
            « {project.name} » n'est pas un dépôt git
          </p>
        )}
        {error && (
          <p className="pcw t-err" role="alert">
            {error}
          </p>
        )}
        <div className="mga stk">
          <button className="b2 ink press" disabled={busy || noGit}>
            {busy ? "Lancement…" : "Lancer l'équipe"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
