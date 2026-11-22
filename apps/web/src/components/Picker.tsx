import type { AgentInfo, AgentSetting, Favorites, ModelChoice } from "@moonagentic/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconBack, IconCheck, IconStar, IconX } from "./icons.tsx";
import { entryKey, keepLines, type WheelEntry, wheelEntries } from "../wheel.ts";

type View = "model" | "all" | "effort" | "options";

/** Height of one wheel line; the wheel shows three, the middle one is the pick. */
const LINE = 44;
/** A scroll that rests this long settles on the line in the middle. */
const SETTLE_MS = 140;

/**
 * Model sheet above the composer: the favorites on a wheel, then « Tous » for every model of
 * every agent, « Options » for the agent itself and its mode, and the effort on its own page.
 */
export function Picker(props: {
  agents: AgentInfo[];
  agent: AgentInfo | undefined;
  model: string | undefined;
  favorites: Favorites;
  projectId: string | undefined;
  /** In a thread, another agent takes over the conversation instead of starting afresh. */
  inThread: boolean;
  /** Heading of the agent list: picking one in a thread hands the thread over. */
  agentsTitle: string;
  /** The current value of each of the agent's settings. */
  settings: Record<string, string>;
  /** Page to open on, for `/modeles` the wheel. */
  start?: View;
  onPickAgent: (agentId: string) => void;
  /** A model of the current agent: the sheet closes, unless the wheel only came to rest on it. */
  onPickModel: (model: string, stay?: boolean) => void;
  /** A model of another agent: in a thread this hands it over, then sets the model. */
  onPickAgentModel: (agentId: string, model: string | undefined, stay?: boolean) => void;
  onPickSetting: (settingId: string, value: string) => void;
  onClose: () => void;
}) {
  const { agent, favorites } = props;
  const [view, setView] = useState<View>(props.start ?? "model");
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  const go = (next: View, back = false) => {
    setDirection(back ? "back" : "fwd");
    setView(next);
  };

  // Settings missing from an older cache are learned the same way.
  const asking = (a: AgentInfo | undefined) =>
    !!a?.available && (!a.models || !a.settings) && !a.modelsError && !!props.projectId;
  const discover = (a: AgentInfo | undefined) => {
    if (a && props.projectId)
      connection.send({ type: "agent.discover", agentId: a.id, projectId: props.projectId });
  };

  // The model list comes from the agent itself; the server starts it once to learn it.
  useEffect(() => {
    if (asking(agent)) discover(agent);
  }, [agent?.id, asking(agent), props.projectId]);

  const toggleStar = (a: AgentInfo, id: string) => {
    const starred = favorites[a.id] ?? [];
    connection.send({
      type: "favorites.toggle",
      agentId: a.id,
      model: id,
      starred: !starred.includes(id),
    });
  };

  const effort = agent?.available ? agent.settings?.find((s) => s.kind === "effort") : undefined;
  const otherSettings = agent?.available
    ? (agent.settings ?? []).filter((s) => s.kind !== "effort")
    : [];

  const close = (
    <button className="ib" aria-label="Fermer" onClick={props.onClose}>
      <IconX size={14} />
    </button>
  );
  const back = (to: View) => (
    <button className="ib" aria-label="Retour" onClick={() => go(to, true)}>
      <IconBack />
    </button>
  );
  const head = (left: ReactNode, title: string, right: ReactNode) => (
    <div className="mp-h">
      {left}
      <b>{title}</b>
      {right ?? <span className="ib" aria-hidden />}
    </div>
  );

  let body: React.ReactNode;
  if (view === "model") {
    body = (
      <>
        {head(
          close,
          "Modèle",
          <button className="mp-more" onClick={() => go("all")}>
            Tous
          </button>,
        )}
        <Wheel
          entries={wheelEntries(props.agents, favorites, { agent, model: props.model })}
          agent={agent}
          model={props.model}
          inThread={props.inThread}
          effort={effort}
          effortValue={effort ? props.settings[effort.id] : undefined}
          onEffort={() => go("effort")}
          onPick={(entry, settle) => {
            if (entry.agent.id === agent?.id) {
              // Scrolling the wheel picks as it goes and keeps it open; a click closes it.
              if (entry.model && entry.model !== props.model)
                props.onPickModel(entry.model, settle);
              else if (!settle) props.onClose();
            } else props.onPickAgentModel(entry.agent.id, entry.model, settle);
          }}
        />
        <p className="mp-hint">
          <IconStar size={11} />
          Tes favoris. « Tous » affiche le reste, ou tape /modeles.
        </p>
      </>
    );
  } else if (view === "all") {
    body = (
      <>
        {head(
          back("model"),
          "Tous les modèles",
          <button className="mp-more" onClick={() => go("options")}>
            Options
          </button>,
        )}
        <p className="mp-desc">
          Choisis un modèle pour l'utiliser. L'étoile l'ajoute à tes favoris.
        </p>
        {props.agents.map((a) => (
          <AgentModels
            key={a.id}
            agent={a}
            current={a.id === agent?.id}
            model={a.id === agent?.id ? props.model : undefined}
            starred={favorites[a.id] ?? []}
            canDiscover={!!props.projectId}
            asking={a.id === agent?.id && asking(a)}
            onDiscover={() => discover(a)}
            onStar={(id) => toggleStar(a, id)}
            onPick={(id) =>
              a.id === agent?.id ? props.onPickModel(id) : props.onPickAgentModel(a.id, id)
            }
          />
        ))}
      </>
    );
  } else if (view === "effort" && effort) {
    body = (
      <>
        {head(back("model"), "Raisonnement", null)}
        <EffortTrack
          setting={effort}
          value={props.settings[effort.id] ?? effort.current}
          onPick={(value) => props.onPickSetting(effort.id, value)}
        />
      </>
    );
  } else {
    body = (
      <>
        {head(back(view === "effort" ? "model" : "all"), "Options", null)}
        <div className="menu-h">{props.agentsTitle}</div>
        {props.agents.map((a) => (
          <button
            key={a.id}
            className="mp-agent"
            role="menuitemradio"
            aria-checked={a.id === agent?.id}
            disabled={!a.available}
            onClick={() => props.onPickAgent(a.id)}
          >
            <AgentBadge agent={a} />
            <span className="tx">
              {a.name}
              {!a.available && a.hint && <small>{a.hint}</small>}
            </span>
            {a.id === agent?.id && (
              <span className="on-mark">
                <IconCheck />
              </span>
            )}
          </button>
        ))}
        {otherSettings.map((setting) => (
          <SettingRow
            key={setting.id}
            setting={setting}
            value={props.settings[setting.id] ?? setting.current}
            onPick={(value) => props.onPickSetting(setting.id, value)}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <div className="menu-scrim" onClick={props.onClose} />
      <div className="menu mpick" role="menu" aria-label="Modèle">
        <div key={view} className={`mp-body in-${direction}`}>
          {body}
        </div>
      </div>
    </>
  );
}

/**
 * The favorites on a wheel: scrolling settles on the middle line, a click picks a line.
 * In a thread, landing on another agent only says so; a click hands the thread over.
 */
function Wheel(props: {
  entries: WheelEntry[];
  agent: AgentInfo | undefined;
  model: string | undefined;
  inThread: boolean;
  effort: AgentSetting | undefined;
  effortValue: string | undefined;
  onEffort: () => void;
  onPick: (entry: WheelEntry, settle: boolean) => void;
}) {
  const entries = useStableEntries(props.entries);
  const currentIndex = Math.max(
    0,
    entries.findIndex((e) => e.agent.id === props.agent?.id && e.model === props.model),
  );
  const [centered, setCentered] = useState(currentIndex);
  const wheel = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Only a scroll the user makes picks: not the one that opens the wheel on the current line.
  const touched = useRef(false);
  const touch = () => (touched.current = true);
  // The line the wheel itself last picked: when the pick comes back, the wheel is already there.
  const picked = useRef<number>(undefined);

  const paint = () => {
    const el = wheel.current;
    if (!el) return;
    const top = el.scrollTop;
    el.querySelectorAll<HTMLElement>(".wh").forEach((line, k) => {
      const d = (k * LINE - top) / LINE;
      const far = Math.min(Math.abs(d), 2);
      line.style.transform = `perspective(420px) rotateX(${(-d * 22).toFixed(2)}deg) scale(${(1 - far * 0.07).toFixed(3)})`;
      line.style.opacity = (1 - far * 0.42).toFixed(3);
    });
    return Math.max(0, Math.min(entries.length - 1, Math.round(top / LINE)));
  };

  // Opens on the current pick, and follows it when it changes elsewhere. A pick the wheel made
  // itself is left alone, so a scroll that goes on is never pulled back to it.
  useLayoutEffect(() => {
    const el = wheel.current;
    if (!el) return;
    if (picked.current === currentIndex) {
      picked.current = undefined;
      return;
    }
    touched.current = false;
    el.scrollTop = currentIndex * LINE;
    setCentered(currentIndex);
    paint();
  }, [currentIndex, entries.length]);
  useEffect(() => () => clearTimeout(settle.current), []);

  const onScroll = () => {
    const index = paint();
    if (index === undefined) return;
    setCentered(index);
    clearTimeout(settle.current);
    if (!touched.current) return;
    settle.current = setTimeout(() => {
      const entry = entries[index];
      if (!entry || index === currentIndex) return;
      // Handing a thread over is never done by a scroll that went one line too far.
      if (props.inThread && entry.agent.id !== props.agent?.id) return;
      picked.current = index;
      props.onPick(entry, true);
    }, SETTLE_MS);
  };

  const scrollTo = (index: number) => {
    touch();
    wheel.current?.scrollTo({ top: index * LINE, behavior: "smooth" });
  };

  const shown = entries[centered];
  const description = shown
    ? props.inThread && shown.agent.id !== props.agent?.id
      ? `Choisis-le pour passer la main à ${shown.agent.name}.`
      : [
          `via ${shown.agent.name}`,
          shown.agent.models?.find((m) => m.id === shown.model)?.description,
        ]
          .filter(Boolean)
          .join(" · ")
    : "";

  const effortIndex = props.effort
    ? Math.max(
        0,
        props.effort.choices.findIndex(
          (c) => c.id === (props.effortValue ?? props.effort?.current),
        ),
      )
    : 0;
  const effortName = props.effort?.choices[effortIndex]?.name;

  return (
    <>
      <div className="wheel-wrap">
        <div
          ref={wheel}
          className="wheel"
          role="listbox"
          aria-label="Modèles favoris"
          aria-activedescendant={`wh-${centered}`}
          tabIndex={0}
          onScroll={onScroll}
          onWheel={touch}
          onTouchStart={touch}
          onPointerDown={touch}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const next = centered + (e.key === "ArrowDown" ? 1 : -1);
              if (next >= 0 && next < entries.length) scrollTo(next);
            } else if (e.key === "Enter" && shown) {
              e.preventDefault();
              props.onPick(shown, false);
            }
          }}
        >
          {entries.map((entry, i) => (
            <button
              key={entryKey(entry)}
              id={`wh-${i}`}
              className={`wh${i === centered ? " on" : ""}`}
              role="option"
              aria-selected={i === centered}
              tabIndex={-1}
              onClick={() => (i === centered ? props.onPick(entry, false) : scrollTo(i))}
            >
              <AgentBadge agent={entry.agent} small />
              <span className="nm">{entry.name}</span>
            </button>
          ))}
        </div>
        {props.effort && shown?.agent.id === props.agent?.id && (
          <button
            className="effbtn"
            aria-label={`Raisonnement : ${effortName ?? ""}`}
            title={`Raisonnement : ${effortName ?? ""}`}
            onClick={props.onEffort}
          >
            {props.effort.choices.map((c, i) => (
              <span
                key={c.id}
                className={i === effortIndex ? "cur" : i < effortIndex ? "fill" : undefined}
              />
            ))}
          </button>
        )}
      </div>
      <p className="mp-desc wheel-desc" aria-live="polite">
        <span key={description} className="swap">
          {description}
        </span>
      </p>
    </>
  );
}

/** The wheel keeps its lines while it is open: see `keepLines`. */
function useStableEntries(live: WheelEntry[]): WheelEntry[] {
  const kept = useRef(live);
  kept.current = keepLines(kept.current, live);
  return kept.current;
}

/** Every model of one agent, with its star; an agent not set up says what to do. */
function AgentModels(props: {
  agent: AgentInfo;
  current: boolean;
  model: string | undefined;
  starred: string[];
  canDiscover: boolean;
  asking: boolean;
  onDiscover: () => void;
  onStar: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const { agent } = props;
  const models = agent.models;
  const row = (m: ModelChoice) => {
    const on = props.current && m.id === props.model;
    const star = props.starred.includes(m.id);
    return (
      <div key={m.id} className={`al-r${on ? " on" : ""}`}>
        <button
          className="al-m"
          role="menuitemradio"
          aria-checked={on}
          onClick={() => props.onPick(m.id)}
        >
          <span className="tx">
            {m.name}
            {m.description && <small>{m.description}</small>}
          </span>
          {on && (
            <span className="on-mark">
              <IconCheck />
            </span>
          )}
        </button>
        <button
          className={`al-s${star ? " on" : ""}`}
          aria-label={star ? "Retirer des favoris" : "Ajouter aux favoris"}
          aria-pressed={star}
          onClick={() => props.onStar(m.id)}
        >
          <IconStar filled={star} size={15} />
        </button>
      </div>
    );
  };
  return (
    <div className={`al${agent.available ? "" : " dis"}`}>
      <div className="al-h">
        <AgentBadge agent={agent} small />
        {agent.name}
      </div>
      {!agent.available && agent.hint && <div className="menu-note">{agent.hint}</div>}
      {agent.available && !models && !props.canDiscover && (
        <div className="menu-note">Crée d'abord un projet pour voir les modèles.</div>
      )}
      {agent.available && !models && props.asking && (
        <div className="menu-note">Je demande la liste à {agent.name}…</div>
      )}
      {agent.available && !models && agent.modelsError && (
        <div className="menu-note err">
          Impossible de lister les modèles de {agent.name}.<small>{agent.modelsError}</small>
          {props.canDiscover && (
            <button className="retry" onClick={props.onDiscover}>
              Réessayer
            </button>
          )}
        </div>
      )}
      {agent.available && !models && !props.asking && !agent.modelsError && props.canDiscover && (
        <button className="retry al-ask" onClick={props.onDiscover}>
          Voir ses modèles
        </button>
      )}
      {models?.length === 0 && (
        <div className="menu-note">{agent.name} ne propose pas de choix de modèle.</div>
      )}
      {agent.available && models?.map(row)}
    </div>
  );
}

/** The effort as a track: one stop per level the agent offers. */
function EffortTrack(props: {
  setting: AgentSetting;
  value: string;
  onPick: (value: string) => void;
}) {
  const { choices } = props.setting;
  const index = Math.max(
    0,
    choices.findIndex((c) => c.id === props.value),
  );
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const at = (x: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || !box.width) return index;
    const f = Math.max(0, Math.min(0.999, (x - box.left) / box.width));
    return Math.floor(f * choices.length);
  };
  const pick = (i: number) => {
    const choice = choices[i];
    if (choice && i !== index) props.onPick(choice.id);
  };
  const current = choices[index];
  return (
    <div className="effv">
      <div className="lvl">{current?.name}</div>
      <div
        ref={track}
        className={`track${drag ? " drag" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Raisonnement"
        aria-valuemin={0}
        aria-valuemax={choices.length - 1}
        aria-valuenow={index}
        aria-valuetext={current?.name}
        style={{ gridTemplateColumns: `repeat(${choices.length}, 1fr)` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(true);
          pick(at(e.clientX));
        }}
        onPointerMove={(e) => drag && pick(at(e.clientX))}
        onPointerUp={() => setDrag(false)}
        onPointerCancel={() => setDrag(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            pick(Math.min(choices.length - 1, index + 1));
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            pick(Math.max(0, index - 1));
          }
        }}
      >
        <span className="fill" style={{ width: `${((index + 1) / choices.length) * 100}%` }} />
        {choices.map((c, i) => (
          <span
            key={c.id}
            className={`tk${i <= index ? " in" : ""}${i === index ? " cur" : ""}`}
            aria-hidden
          >
            <span />
          </span>
        ))}
      </div>
      <div className="tkl" style={{ gridTemplateColumns: `repeat(${choices.length}, 1fr)` }}>
        {choices.map((c, i) => (
          <button key={c.id} className={i === index ? "on" : undefined} onClick={() => pick(i)}>
            {c.name}
          </button>
        ))}
      </div>
      <p className="mp-desc">
        {current?.description ??
          "Plus d'effort donne des réponses plus approfondies, mais prend plus de temps et consomme davantage tes limites."}
      </p>
    </div>
  );
}

const SETTING_LABELS: Record<AgentSetting["kind"], string> = {
  mode: "Mode",
  effort: "Raisonnement",
};

/** One of the agent's settings, as a row of choices; picking one keeps the menu open. */
function SettingRow(props: {
  setting: AgentSetting;
  value: string;
  onPick: (value: string) => void;
}) {
  const { setting } = props;
  const label = SETTING_LABELS[setting.kind];
  return (
    <div className="menu-setting">
      <div className="menu-h">{label}</div>
      <div className="seg" role="radiogroup" aria-label={label}>
        {setting.choices.map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={c.id === props.value}
            title={c.description}
            onClick={() => props.onPick(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
