import {
  agentSettingsFor,
  type AgentInfo,
  type AgentQuota,
  type AgentSetting,
  type Favorites,
  type ModelChoice,
} from "@moonagentic/protocol";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { connection } from "../connection.ts";
import { effortName } from "../effort.ts";
import { entryKey, keepLines, type WheelEntry, wheelEntries } from "../wheel.ts";
import { modelLabel, modelNameOf } from "../model-label.ts";
import { formatPercent, quotaLevel, tightest } from "../quotas.ts";
import { useQuotas } from "../use-quotas.ts";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { useMouse, useScreen } from "../v2/use-screen.ts";

type View = "model" | "all" | "effort" | "options";

/** Height of one wheel line; the wheel shows three, the middle one is the pick. */
const LINE = 52;
/** A scroll that rests this long settles on the line in the middle. */
const SETTLE_MS = 140;
/** Let go, the effort slider gives the wheel back after this long. */
const EFFORT_CLOSE_MS = 1200;

/**
 * The model sheet: the favorites on a wheel, the effort on a slider that takes the wheel's
 * place, then « Plus » for every model of every agent, the agent itself and its mode.
 */
export function Picker(props: {
  open: boolean;
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
  const { agent, favorites, open } = props;
  // The wheel's order, set in Réglages › Modèles.
  const order = useSyncExternalStore(connection.subscribe, connection.getState).favoriteOrder;
  const quotas = useQuotas();
  // From the iPad's width up, a menu above the model's button, like the « + » one.
  const pop = useScreen().roomy;
  const desk = useMouse();
  const [all, setAll] = useState(false);
  const [sliding, setSliding] = useState(false);
  // Each opening starts on the page asked for.
  useEffect(() => {
    if (!open) return;
    setAll(props.start === "all" || props.start === "options");
    setSliding(props.start === "effort");
  }, [open, props.start]);

  // Settings missing from an older cache (or before per-model settings existed) are learned the same way.
  const asking = (a: AgentInfo | undefined) =>
    !!a?.available &&
    (!a.models || !a.settings || (a.models.length > 0 && !a.modelSettings)) &&
    !a.modelsError &&
    !!props.projectId;
  const discover = (a: AgentInfo | undefined) => {
    if (a && props.projectId)
      connection.send({ type: "agent.discover", agentId: a.id, projectId: props.projectId });
  };

  // The model list comes from the agent itself; the server starts it once to learn it.
  useEffect(() => {
    if (open && asking(agent)) discover(agent);
  }, [open, agent?.id, asking(agent), props.projectId]);

  const toggleStar = (a: AgentInfo, id: string) => {
    const starred = favorites[a.id] ?? [];
    connection.send({
      type: "favorites.toggle",
      agentId: a.id,
      model: id,
      starred: !starred.includes(id),
    });
  };

  const agentSettings = agent?.available ? agentSettingsFor(agent, props.model) : [];
  const effort = agentSettings.find((s) => s.kind === "effort");
  const modelName = modelNameOf(agent?.models, props.model);
  const otherSettings = agentSettings.filter((s) => s.kind !== "effort");
  const effortValue = effort ? (props.settings[effort.id] ?? effort.current) : undefined;

  // Let go, the slider gives the wheel back by itself.
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holdSlider = () => clearTimeout(closing.current);
  const releaseSlider = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setSliding(false), EFFORT_CLOSE_MS);
  };
  useEffect(() => () => clearTimeout(closing.current), []);

  const wheel: WheelProps = {
    entries: wheelEntries(props.agents, favorites, { agent, model: props.model }, order),
    agent,
    model: props.model,
    inThread: props.inThread,
    effort:
      effort && effortValue !== undefined ? { setting: effort, value: effortValue } : undefined,
    onEffort: () => {
      holdSlider();
      setSliding(true);
    },
    onPick: (entry, settle) => {
      if (entry.agent.id === agent?.id) {
        // Scrolling the wheel picks as it goes and keeps it open; a click closes it.
        if (entry.model && entry.model !== props.model) props.onPickModel(entry.model, settle);
        else if (!settle) props.onClose();
      } else props.onPickAgentModel(entry.agent.id, entry.model, settle);
    },
  };
  const favoritesView = (
    <div className={`mv${sliding && effort ? " eff" : ""}`} role="menu" aria-label="Modèle">
      {/* With a mouse, a list: a wheel is for a finger. */}
      {pop && desk ? (
        <FavoriteList {...wheel} asleep={sliding && !!effort} />
      ) : (
        <Wheel {...wheel} />
      )}
      {effort && effortValue !== undefined && (
        <EffortSlide
          shown={sliding}
          setting={effort}
          model={modelName}
          value={effortValue}
          onPick={(value) => props.onPickSetting(effort.id, value)}
          onHold={holdSlider}
          onRelease={releaseSlider}
          onBack={() => setSliding(false)}
        />
      )}
    </div>
  );
  const pickIn = (a: AgentInfo, id: string) =>
    a.id === agent?.id ? props.onPickModel(id) : props.onPickAgentModel(a.id, id);

  if (pop)
    return (
      <ModelPop open={open} onClose={props.onClose} wide={all}>
        <div className="mph">
          <b>{all ? "Tous les modèles" : "Favoris"}</b>
          <button
            className="mpt"
            onClick={() => {
              setSliding(false);
              setAll((a) => !a);
            }}
          >
            {all ? "Favoris" : "Tous les modèles"}
          </button>
        </div>
        <div key={all ? "all" : "fav"} className="mpb">
          {all ? (
            <AllModels
              agents={props.agents}
              agent={agent}
              model={props.model}
              favorites={favorites}
              quotas={quotas}
              canDiscover={!!props.projectId}
              asking={(a) => a.id === agent?.id && asking(a)}
              onDiscover={discover}
              onStar={toggleStar}
              onPick={pickIn}
              agentsTitle={props.agentsTitle}
              onPickAgent={props.onPickAgent}
              settings={otherSettings.map((setting) => ({
                setting,
                value: props.settings[setting.id] ?? setting.current,
              }))}
              onPickSetting={props.onPickSetting}
              focus={desk}
            />
          ) : (
            favoritesView
          )}
        </div>
      </ModelPop>
    );

  return (
    <Sheet
      open={open}
      onClose={props.onClose}
      title={all ? "Tous les modèles" : "Modèle"}
      tall={all}
      className="mpk"
      right={
        <button className="hmore press" onClick={() => setAll((a) => !a)}>
          {all ? "Favoris" : "Plus"}
        </button>
      }
    >
      {all ? (
        <div className="sbody" role="menu" aria-label="Tous les modèles">
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
              onPick={(id) => pickIn(a, id)}
            />
          ))}
          <div className="gl2">{props.agentsTitle}</div>
          <div className="ins">
            {props.agents.map((a) => (
              <button
                key={a.id}
                className="it"
                role="menuitemradio"
                aria-checked={a.id === agent?.id}
                disabled={!a.available}
                onClick={() => props.onPickAgent(a.id)}
              >
                <span className="tx">
                  {a.name}
                  {!a.available && a.hint && <small>{a.hint}</small>}
                </span>
                {a.available && <AgentQuotaTag quota={quotas.find((q) => q.agentId === a.id)} />}
                {a.id === agent?.id && <I n="check" s={20} className="ck" />}
              </button>
            ))}
          </div>
          {otherSettings.map((setting) => (
            <SettingRow
              key={setting.id}
              setting={setting}
              value={props.settings[setting.id] ?? setting.current}
              onPick={(value) => props.onPickSetting(setting.id, value)}
            />
          ))}
        </div>
      ) : (
        favoritesView
      )}
    </Sheet>
  );
}

/** How a line of the wheel is drawn, `d` lines away from the middle. */
const lineStyle = (line: HTMLElement, d: number) => {
  const far = Math.abs(d);
  line.style.opacity = Math.max(0, 1 - far * 0.62).toFixed(2);
  line.style.transform = `scale(${(1 - Math.min(far, 2) * 0.05).toFixed(3)})`;
};

/** What the favorites are drawn from, on the wheel or in the list. */
interface WheelProps {
  entries: WheelEntry[];
  agent: AgentInfo | undefined;
  model: string | undefined;
  inThread: boolean;
  /** The current model's effort, shown on its line with the way to its slider. */
  effort: { setting: AgentSetting; value: string } | undefined;
  onEffort: () => void;
  onPick: (entry: WheelEntry, settle: boolean) => void;
}

/**
 * The favorites on a wheel: scrolling settles on the middle line, a click picks a line.
 * In a thread, landing on another agent only says so; a click hands the thread over.
 */
function Wheel(props: WheelProps) {
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
    el.querySelectorAll<HTMLElement>(".wi").forEach((line, k) => lineStyle(line, k - top / LINE));
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
      ? `Passe la main à ${shown.agent.name}`
      : [shown.agent.name, shown.agent.models?.find((m) => m.id === shown.model)?.description]
          .filter(Boolean)
          .join(" · ")
    : "";
  const effort = props.effort;

  return (
    <>
      <div className="wheelw">
        <div className="wsel" />
        <div
          ref={wheel}
          className="wheel nat"
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
          <div className="wlist">
            {entries.map((entry, i) => (
              <div
                key={entryKey(entry)}
                id={`wh-${i}`}
                className={`wi${i === centered ? " c" : ""}`}
                role="option"
                aria-selected={i === centered}
                onClick={() => (i === centered ? props.onPick(entry, false) : scrollTo(i))}
              >
                <span className="wn">{entry.name}</span>
                {effort && i === centered && i === currentIndex && (
                  <EffortPill effort={effort} onEffort={props.onEffort} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="wdesc" aria-live="polite">
        {description}
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

/** The current model's effort on its line: the levels as marks, the way to its slider. */
function EffortPill(props: {
  effort: { setting: AgentSetting; value: string };
  onEffort: () => void;
}) {
  const { setting, value } = props.effort;
  const level = Math.max(
    0,
    setting.choices.findIndex((c) => c.id === value),
  );
  const levels = setting.choices.length;
  return (
    <button
      className="eg"
      aria-label={`Effort : ${effortName(setting, level)}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onEffort();
      }}
    >
      <span
        className="mg"
        style={
          {
            "--mp": `${levels > 1 ? Math.round((level / (levels - 1)) * 100) : 0}%`,
          } as React.CSSProperties
        }
      >
        {setting.choices.map((c, k) => (
          <i key={c.id} className={k === level ? "t" : undefined} />
        ))}
      </span>
      <span className={`el${levels > 1 && level === levels - 1 ? " gx" : ""}`}>
        {effortName(setting, level)}
      </span>
      <I n="right" s={13} />
    </button>
  );
}

/** How long the menu takes to shrink back into its button. */
const POP_OUT_MS = 230;

/**
 * From the iPad's width up, the model's menu opens above its button, like the « + » one, and
 * shrinks back into it. A press anywhere else, or Escape, closes it.
 */
function ModelPop(props: {
  open: boolean;
  onClose: () => void;
  /** « Tous les modèles »: wider and taller. */
  wide: boolean;
  children: React.ReactNode;
}) {
  const { open, onClose } = props;
  const [out, setOut] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Closing is known in the same render: the menu stays drawn, without a frame where it is gone
  // and then mounted again (which gave the search the focus back, and the user's typing with it).
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setOut(!open);
  }
  useEffect(() => {
    if (!out) return;
    const timer = setTimeout(() => setOut(false), POP_OUT_MS);
    return () => clearTimeout(timer);
  }, [out]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const at = event.target as Node;
      // Its own button toggles it (not another composer's, beside it); a sheet it opened stays
      // above it.
      const own = box.current?.parentElement?.querySelector(".cmp .mdl");
      if (box.current?.contains(at) || own?.contains(at)) return;
      if ((at as Element).closest?.(".sheet, .sscrim")) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".sheet.on")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);
  // As tall as the room above the composer allows, under the top bar, also once the window or
  // the iPad's keyboard changes that room.
  const fit = () => {
    const el = box.current;
    const above = el?.parentElement?.getBoundingClientRect().top;
    if (!el || above === undefined) return;
    const top = visualViewport?.offsetTop ?? 0;
    el.style.maxHeight = `${Math.max(220, Math.min(props.wide ? 560 : 420, above - top - 76))}px`;
  };
  useLayoutEffect(fit);
  useEffect(() => {
    if (!open) return;
    addEventListener("resize", fit);
    visualViewport?.addEventListener("resize", fit);
    return () => {
      removeEventListener("resize", fit);
      visualViewport?.removeEventListener("resize", fit);
    };
  });
  if (!open && !out) return null;
  return (
    <div
      ref={box}
      className={`mpop${props.wide ? " all" : ""}${open ? "" : " out"}`}
      role="dialog"
      aria-label={props.wide ? "Tous les modèles" : "Modèle"}
      aria-hidden={!open || undefined}
      inert={!open}
    >
      {props.children}
    </div>
  );
}

/** With a mouse, the favorites as a plain list: a click picks, the arrows and Enter too. */
function FavoriteList(props: WheelProps & { asleep: boolean }) {
  const entries = useStableEntries(props.entries);
  const current = entries.findIndex(
    (e) => e.agent.id === props.agent?.id && e.model === props.model,
  );
  const [active, setActive] = useState(Math.max(0, current));
  const list = useRef<HTMLDivElement>(null);
  // Keys go to the list, but not while the effort's slider is over it: then they go to the slider.
  useEffect(() => {
    if (props.asleep)
      list.current?.parentElement
        ?.querySelector<HTMLElement>(".eslide [role=slider]")
        ?.focus({ preventScroll: true });
    else list.current?.focus({ preventScroll: true });
  }, [props.asleep]);
  useEffect(() => {
    list.current?.querySelector(`#fv-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={list}
      className="mpl"
      role="listbox"
      aria-label="Modèles favoris"
      inert={props.asleep}
      aria-activedescendant={`fv-${active}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = active + (e.key === "ArrowDown" ? 1 : -1);
          if (next >= 0 && next < entries.length) setActive(next);
        } else if (e.key === "Enter" && entries[active]) {
          e.preventDefault();
          props.onPick(entries[active], false);
        }
      }}
    >
      {entries.length === 0 && <p className="mpe">Aucun favori</p>}
      {entries.map((entry, i) => {
        // Two agents can offer models of the same name: the agent tells them apart.
        const twin = entries.some((e, k) => k !== i && e.name === entry.name);
        const on = i === current;
        const other = props.inThread && entry.agent.id !== props.agent?.id;
        return (
          <div
            key={entryKey(entry)}
            id={`fv-${i}`}
            className={`mpr${on ? " c" : ""}${i === active ? " kf" : ""}`}
            role="option"
            aria-selected={on}
            title={other ? `Passe la main à ${entry.agent.name}` : undefined}
            onClick={() => props.onPick(entry, false)}
            onPointerMove={() => i !== active && setActive(i)}
          >
            <span className="nm">
              {entry.name}
              {twin && <small> · {entry.agent.name}</small>}
            </span>
            {on && props.effort && <EffortPill effort={props.effort} onEffort={props.onEffort} />}
            <span className="ck">{on && <I n="check" s={17} />}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Agents not in use show this many models until « N autres ». */
const FOLDED = 3;

/**
 * « Tous les modèles » in the menu: a search, the agent in use first, the others folded to
 * their first models; a full star is a favorite. Then the agent itself and its other settings.
 */
function AllModels(props: {
  agents: AgentInfo[];
  agent: AgentInfo | undefined;
  model: string | undefined;
  favorites: Favorites;
  quotas: AgentQuota[];
  canDiscover: boolean;
  asking: (a: AgentInfo) => boolean;
  onDiscover: (a: AgentInfo) => void;
  onStar: (a: AgentInfo, id: string) => void;
  onPick: (a: AgentInfo, id: string) => void;
  agentsTitle: string;
  onPickAgent: (id: string) => void;
  settings: { setting: AgentSetting; value: string }[];
  onPickSetting: (settingId: string, value: string) => void;
  /** Typing goes to the search at once (with a keyboard). */
  focus: boolean;
}) {
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The models shown, in order: the arrows go from one to the next. */
  const rows = () => [
    ...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []),
  ];
  useEffect(() => {
    if (props.focus) search.current?.focus({ preventScroll: true });
  }, [props.focus]);
  const q = query.trim().toLowerCase();
  const agents = [
    ...props.agents.filter((a) => a.id === props.agent?.id),
    ...props.agents.filter((a) => a.id !== props.agent?.id),
  ];
  let found = 0;
  const groups = agents.map((a) => {
    const current = a.id === props.agent?.id;
    const models = a.available ? (a.models ?? []) : [];
    const matching = q
      ? models.filter((m) => `${modelLabel(m)} ${a.name}`.toLowerCase().includes(q))
      : models;
    found += matching.length;
    const open = q || current || unfolded[a.id];
    const shown = open ? matching : matching.slice(0, FOLDED);
    const starred = props.favorites[a.id] ?? [];
    const note = !a.available
      ? a.hint
      : !a.models && !props.canDiscover
        ? "Crée d'abord un projet"
        : !a.models && props.asking(a)
          ? "Lecture des modèles…"
          : a.models?.length === 0
            ? "Pas de choix de modèle"
            : undefined;
    if (q && matching.length === 0) return null;
    return (
      <div key={a.id} className="mpgw" role="group" aria-label={a.name}>
        <div className="mpg">
          <span className="an">{a.name}</span>
          {a.available && <AgentQuotaTag quota={props.quotas.find((x) => x.agentId === a.id)} />}
        </div>
        {note && !q && <p className="mpn">{note}</p>}
        {!q && a.available && !a.models && a.modelsError && (
          <div className="mpr ro">
            <span className="nm erx" title={a.modelsError}>
              Modèles illisibles
            </span>
            {props.canDiscover && (
              <button className="mpm in" onClick={() => props.onDiscover(a)}>
                Réessayer
              </button>
            )}
          </div>
        )}
        {!q &&
          a.available &&
          !a.models &&
          !props.asking(a) &&
          !a.modelsError &&
          props.canDiscover && (
            <button className="mpm" onClick={() => props.onDiscover(a)}>
              Voir ses modèles
            </button>
          )}
        {shown.map((m) => {
          const on = current && m.id === props.model;
          const star = starred.includes(m.id);
          return (
            <div
              key={m.id}
              className={`mpr${on ? " c" : ""}`}
              role="menuitemradio"
              aria-checked={on}
              tabIndex={-1}
              title={m.description}
              onClick={() => props.onPick(a, m.id)}
            >
              <span className="nm">{modelLabel(m)}</span>
              <span className="ck">{on && <I n="check" s={17} />}</span>
              <button
                className={`st${star ? " on" : ""}`}
                aria-label={star ? "Retirer des favoris" : "Ajouter aux favoris"}
                aria-pressed={star}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onStar(a, m.id);
                }}
              >
                <I n={star ? "starf" : "star"} s={16} />
              </button>
            </div>
          );
        })}
        {shown.length < matching.length && (
          <button className="mpm" onClick={() => setUnfolded((u) => ({ ...u, [a.id]: true }))}>
            {matching.length - shown.length}{" "}
            {matching.length - shown.length > 1 ? "autres" : "autre"}
          </button>
        )}
      </div>
    );
  });
  const agentName = props.agent?.name ?? "Aucun";
  return (
    <>
      <label className="mps">
        <I n="search" s={16} />
        <input
          ref={search}
          type="search"
          placeholder="Rechercher un modèle"
          aria-label="Rechercher un modèle"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Down goes into the list; Enter takes the first model found.
            const first = rows()[0];
            if (e.key === "ArrowDown" && first) {
              e.preventDefault();
              first.focus();
            } else if (e.key === "Enter" && q && first) {
              e.preventDefault();
              first.click();
            }
          }}
        />
      </label>
      <div
        ref={list}
        className="mpl"
        role="menu"
        aria-label="Tous les modèles"
        onKeyDown={(e) => {
          const all = rows();
          const at = all.indexOf(e.target as HTMLElement);
          if (at < 0) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = at + (e.key === "ArrowDown" ? 1 : -1);
            if (next < 0) search.current?.focus();
            else all[Math.min(next, all.length - 1)]?.focus();
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            all[at]?.click();
          }
        }}
      >
        {groups}
        {q && found === 0 && <p className="mpe">Aucun modèle</p>}
      </div>
      <div className="mpf">
        <button
          className="mpr"
          aria-expanded={opened === "agent"}
          onClick={() => setOpened((o) => (o === "agent" ? null : "agent"))}
        >
          <span className="nm">{props.agentsTitle}</span>
          <span className="rt">
            {agentName}
            <I n={opened === "agent" ? "down" : "right"} s={13} />
          </span>
        </button>
        {opened === "agent" && (
          <div className="mpsub" role="menu" aria-label={props.agentsTitle}>
            {props.agents.map((a) => (
              <button
                key={a.id}
                className={`mpr${a.id === props.agent?.id ? " c" : ""}`}
                role="menuitemradio"
                aria-checked={a.id === props.agent?.id}
                disabled={!a.available}
                title={!a.available ? a.hint : undefined}
                onClick={() => props.onPickAgent(a.id)}
              >
                <span className="nm">{a.name}</span>
                <span className="ck">{a.id === props.agent?.id && <I n="check" s={17} />}</span>
              </button>
            ))}
          </div>
        )}
        {props.settings.map(({ setting, value }) => {
          const label = SETTING_LABELS[setting.kind];
          const name = setting.choices.find((c) => c.id === value)?.name ?? value;
          return (
            <Fragment key={setting.id}>
              <button
                className="mpr"
                aria-expanded={opened === setting.id}
                onClick={() => setOpened((o) => (o === setting.id ? null : setting.id))}
              >
                <span className="nm">{label}</span>
                <span className="rt">
                  {name}
                  <I n={opened === setting.id ? "down" : "right"} s={13} />
                </span>
              </button>
              {opened === setting.id && (
                <div className="seg mseg" role="radiogroup" aria-label={label}>
                  {setting.choices.map((c) => (
                    <button
                      key={c.id}
                      role="radio"
                      aria-checked={c.id === value}
                      aria-pressed={c.id === value}
                      title={c.description}
                      onClick={() => props.onPickSetting(setting.id, c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </>
  );
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
      <div key={m.id} className={`it mrow${on ? " on" : ""}`}>
        <button
          className="mpick"
          role="menuitemradio"
          aria-checked={on}
          onClick={() => props.onPick(m.id)}
        >
          <span className="tx">
            {modelLabel(m)}
            {m.description && <small>{m.description}</small>}
          </span>
          {on && <I n="check" s={20} className="ck" />}
        </button>
        <button
          className={`mstar${star ? " on" : ""}`}
          aria-label={star ? "Retirer des favoris" : "Ajouter aux favoris"}
          aria-pressed={star}
          onClick={() => props.onStar(m.id)}
        >
          <I n="star" s={18} />
        </button>
      </div>
    );
  };
  const note = !agent.available
    ? agent.hint
    : !models && !props.canDiscover
      ? "Crée d'abord un projet"
      : !models && props.asking
        ? "Lecture des modèles…"
        : models?.length === 0
          ? "Pas de choix de modèle"
          : undefined;
  return (
    <>
      <div className="gl2">
        {agent.name}
        {note && (
          <>
            <span className="sp" />
            <span className="ppill">{note}</span>
          </>
        )}
      </div>
      {agent.available && !models && agent.modelsError && (
        <div className="ins">
          <div className="it ro">
            <span className="tx">
              Modèles illisibles
              <small className="erx">{agent.modelsError}</small>
            </span>
            {props.canDiscover && (
              <button className="b2 soft press" onClick={props.onDiscover}>
                Réessayer
              </button>
            )}
          </div>
        </div>
      )}
      {agent.available && !models && !props.asking && !agent.modelsError && props.canDiscover && (
        <div className="ins">
          <button className="it acc" onClick={props.onDiscover}>
            <span className="tx">Voir ses modèles</span>
          </button>
        </div>
      )}
      {agent.available && !!models?.length && <div className="ins">{models.map(row)}</div>}
    </>
  );
}

/**
 * The effort as one slider whose stops are the agent's own levels, lowest first: it takes the
 * wheel's place while it is used. Its top level is « UltraMoon »: the track turns into a
 * field of stars and the thumb lights up.
 */
function EffortSlide(props: {
  shown: boolean;
  setting: AgentSetting;
  model: string | undefined;
  value: string;
  onPick: (value: string) => void;
  onHold: () => void;
  onRelease: () => void;
  onBack: () => void;
}) {
  const { choices } = props.setting;
  const n = choices.length;
  const index = Math.max(
    0,
    choices.findIndex((c) => c.id === props.value),
  );
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
  const pick = (i: number) => {
    const choice = choices[i];
    if (choice && i !== index) props.onPick(choice.id);
  };
  const x = (i: number) => (n < 2 ? 0 : i / (n - 1));
  const top = n > 1 && index === n - 1;
  // Reached while the sheet is open, « UltraMoon » arrives once with its show; opened on it, calm.
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
  // The way a new level's name comes in: from the side it was reached by.
  const before = useRef(index);
  const dir = index > before.current ? -1 : 1;
  useEffect(() => {
    before.current = index;
  }, [index]);
  const recommended = choices.findIndex((c) => c.id === props.setting.current);
  const let_go = () => {
    pressed.current = false;
    setDrag(null);
    props.onRelease();
  };
  return (
    <div
      className="eslide"
      aria-hidden={!props.shown}
      inert={!props.shown}
      onClick={(e) => e.target === e.currentTarget && props.onBack()}
    >
      <small style={index === recommended ? undefined : { opacity: 0 }}>Par défaut</small>
      <b
        key={index}
        className={`ev in${top ? " gx" : ""}${top && intro ? " shine" : ""}`}
        style={{ "--dir": dir } as React.CSSProperties}
      >
        {effortName(props.setting, index)}
      </b>
      <div
        ref={track}
        className={`etrack${top ? " gx" : ""}${intro ? " gx-in" : ""}${drag !== null ? " drag" : ""}`}
        role="slider"
        tabIndex={props.shown ? 0 : -1}
        aria-label={`Effort${props.model ? ` de ${props.model}` : ""}`}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={index}
        aria-valuetext={effortName(props.setting, index)}
        style={{ "--p": drag ?? x(index) } as React.CSSProperties}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pressed.current = true;
          props.onHold();
          // A click without moving jumps to the nearest stop.
          pick(at(e.clientX));
        }}
        onPointerMove={(e) => {
          if (!pressed.current) return;
          setDrag(raw(e.clientX));
          pick(at(e.clientX));
        }}
        onPointerUp={let_go}
        onPointerCancel={let_go}
        onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
          if (step) {
            e.preventDefault();
            props.onHold();
            pick(Math.max(0, Math.min(n - 1, index + step)));
          } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            props.onHold();
            pick(e.key === "Home" ? 0 : n - 1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            props.onBack();
          }
        }}
      >
        {top && <Galaxy intro={intro} />}
        <i className="fill" />
        {choices.map((c, i) => (
          <i
            key={c.id}
            className={`nt${i === recommended ? " rec" : ""}`}
            style={{ "--x": x(i) } as React.CSSProperties}
          />
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
        <span>Plus rapide</span>
        <span>Plus réfléchi</span>
      </div>
    </div>
  );
}

/**
 * « UltraMoon »: pixel stars fill the track, denser and brighter towards the thumb, with a few
 * rays around it. Reached by the user while the menu is open (`intro`), it arrives once with
 * warp streaks, a light front, two shock waves and a burst of sparks; then it stays calm.
 * Drawn only while the menu shows it, and still when motion is reduced.
 */
export function Galaxy({ intro: wanted }: { intro: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    g.scale(dpr, dpr);
    const O = 40;
    const tw = W - 2 * O;
    const th = H - 2 * O;
    const cell = 4;
    const cols = Math.floor(tw / cell);
    const rows = Math.floor(th / cell);
    // Deep space in both themes: the track under it is dark grey either way.
    const colors = ["#3b4cff", "#6d5dfc", "#a855f7", "#e879f9", "#38bdf8", "#c7d2fe"];
    const ray = "#c9d2ff";
    const light = false;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const intro = wanted && !still;
    const born = performance.now();
    const SW = intro ? 720 : 520;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pick = () => colors[Math.floor(rnd() * colors.length)]!;
    const stars: [number, number, string, number, number][] = [];
    for (let cx = 0; cx < cols; cx++)
      for (let cy = 0; cy < rows; cy++) {
        const d = cx / cols;
        if (rnd() < 0.18 + 0.62 * d * d)
          stars.push([cx, cy, pick(), rnd() * 6.3, 0.25 + 0.75 * d * rnd()]);
      }
    const rays = Array.from({ length: 14 }, (_, k) => [
      (k / 14) * 6.283 + rnd() * 0.3,
      10 + rnd() * 10,
    ]) as [number, number][];
    const X = W - O - th / 2;
    const Y = H / 2;
    // Sparks flung from the thumb when the top is reached, slowed by drag.
    const sparks = intro
      ? Array.from({ length: 46 }, () => {
          const a = Math.PI * (0.5 + rnd()) + (rnd() - 0.5) * Math.PI * 1.2;
          const v = 70 + rnd() * 190;
          return [
            X,
            Y,
            Math.cos(a) * v,
            Math.sin(a) * v,
            1.5 + rnd() * 2.2,
            0.55 + rnd() * 0.6,
            pick(),
          ] as [number, number, number, number, number, number, string];
        })
      : [];
    let last = born;
    let frame = 0;
    const draw = (now: number) => {
      const t = now / 1000;
      const el = now - born;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // The stars sweep in from the left, then the rays burst around the thumb.
      const age = still ? 1 : Math.min(1, el / SW);
      const sweep = 1 - Math.pow(1 - age, 3);
      g.clearRect(0, 0, W, H);
      g.save();
      g.beginPath();
      g.roundRect(O, O, tw, th, th / 2);
      g.clip();
      const warp = intro ? Math.max(0, 1 - el / 900) : 0;
      for (const [sx, sy, color, phase, bright] of stars) {
        const xr = sx / cols;
        if (xr > sweep) continue;
        const pop = Math.min(1, (sweep - xr) * 6);
        const base = light ? 0.35 + bright * 0.75 : bright;
        g.globalAlpha = Math.max(
          0,
          Math.min(1, pop * base * (0.65 + 0.35 * Math.sin(t * 2.2 + phase))),
        );
        g.fillStyle = color;
        const px = O + 2 + sx * cell;
        const py = O + 3 + sy * cell;
        if (warp > 0) {
          const len = cell - 1 + warp * warp * (18 + bright * 36);
          g.fillRect(px - len + cell - 1, py, len, cell - 1);
        } else g.fillRect(px, py, cell - 1, cell - 1);
      }
      // A bright front travels with the sweep.
      if (intro && age < 1) {
        const fx = O + tw * sweep;
        const front = g.createLinearGradient(fx - 60, 0, fx + 6, 0);
        front.addColorStop(0, "rgba(255,255,255,0)");
        front.addColorStop(1, light ? "rgba(255,255,255,.95)" : "rgba(220,228,255,.9)");
        g.globalAlpha = 1 - age * 0.6;
        g.fillStyle = front;
        g.fillRect(fx - 60, O, 66, th);
      }
      g.restore();
      // Two shock waves when the sweep lands on the thumb.
      if (intro)
        for (const [d0, w] of [
          [560, 2.4],
          [700, 1.4],
        ] as const) {
          const k = (el - d0) / 700;
          if (k <= 0 || k >= 1) continue;
          const e = 1 - Math.pow(1 - k, 3);
          g.globalAlpha = (1 - k) * 0.9;
          g.strokeStyle = ray;
          g.lineWidth = w * (1 - k) + 0.4;
          g.beginPath();
          g.arc(X, Y, 14 + e * 70, 0, 6.283);
          g.stroke();
        }
      const burst = age < 1 ? Math.max(0, (age - 0.55) / 0.45) : 1;
      const boost = intro ? 1 + 1.6 * Math.max(0, 1 - Math.abs(el - 650) / 500) : 1;
      g.fillStyle = ray;
      for (const [a, len] of rays) {
        const l = len * boost * (0.8 + 0.2 * Math.sin(t * 3 + a * 5)) * (0.4 + 0.6 * burst);
        for (let k = 0; k < 4; k++) {
          const r = 15 + k * (l / 4);
          g.globalAlpha = Math.min(1, burst * (0.6 - k * 0.13) * (boost > 1 ? 1.4 : 1));
          g.fillRect(X + Math.cos(a) * r - 0.75, Y + Math.sin(a) * r - 0.75, 1.5, 1.5);
        }
      }
      let live = false;
      if (el > 560)
        for (const sp of sparks) {
          const life = (el - 560) / 1000 / sp[5];
          if (life >= 1) continue;
          live = true;
          sp[0] += sp[2] * dt;
          sp[1] += sp[3] * dt;
          sp[2] *= 1 - 3.2 * dt;
          sp[3] = sp[3] * (1 - 3.2 * dt) + 30 * dt;
          g.globalAlpha = (1 - life) * (light ? 0.95 : 1);
          g.fillStyle = sp[6];
          const z = sp[4] * (1 - life * 0.5);
          g.fillRect(sp[0] - z / 2, sp[1] - z / 2, z, z);
        }
      if (!still || age < 1 || live) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={canvas} aria-hidden />;
}

const SETTING_LABELS: Record<AgentSetting["kind"], string> = {
  mode: "Mode",
  effort: "Raisonnement",
};

/** One of the agent's settings, as a row of choices; picking one keeps the sheet open. */
function SettingRow(props: {
  setting: AgentSetting;
  value: string;
  onPick: (value: string) => void;
}) {
  const { setting } = props;
  const label = SETTING_LABELS[setting.kind];
  return (
    <>
      <div className="gl2">{label}</div>
      <div className="seg" role="radiogroup" aria-label={label}>
        {setting.choices.map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={c.id === props.value}
            aria-pressed={c.id === props.value}
            title={c.description}
            onClick={() => props.onPick(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
    </>
  );
}

/** The window closest to its limit, beside an agent; nothing when it cannot be read. */
function AgentQuotaTag({ quota }: { quota: AgentQuota | undefined }) {
  const worst = tightest(quota);
  if (!worst) return null;
  const level = quotaLevel(worst.usedPercent);
  return (
    <span
      className={`rt mq ${level}`}
      title={`${worst.label} : ${formatPercent(worst.usedPercent)} utilisés`}
    >
      {worst.short} {formatPercent(worst.usedPercent)}
    </span>
  );
}
