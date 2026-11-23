import type {
  AgentInfo,
  AgentQuota,
  AgentSetting,
  Favorites,
  ModelChoice,
} from "@moonagentic/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { IconBack, IconCheck, IconOrbit, IconStar, IconX } from "./icons.tsx";
import { entryKey, keepLines, type WheelEntry, wheelEntries } from "../wheel.ts";
import { formatPercent, quotaLevel, tightest } from "../quotas.ts";
import { useQuotas } from "../use-quotas.ts";

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
  /** How full the conversation's context is, with a way to compact it when the agent can. */
  context?: { used: number; size: number; onCompact?: () => void };
  onPickAgent: (agentId: string) => void;
  /** A model of the current agent: the sheet closes, unless the wheel only came to rest on it. */
  onPickModel: (model: string, stay?: boolean) => void;
  /** A model of another agent: in a thread this hands it over, then sets the model. */
  onPickAgentModel: (agentId: string, model: string | undefined, stay?: boolean) => void;
  onPickSetting: (settingId: string, value: string) => void;
  onClose: () => void;
}) {
  const { agent, favorites } = props;
  const quotas = useQuotas();
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
  const modelName = agent?.models?.find((m) => m.id === props.model)?.name ?? props.model;
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
        {effort && (
          <>
            <div className="menu-sep" role="separator" />
            <EffortTrack
              setting={effort}
              model={modelName}
              value={props.settings[effort.id] ?? effort.current}
              onPick={(value) => props.onPickSetting(effort.id, value)}
            />
          </>
        )}
        {props.context && (
          <div className="menu-foot">
            <span className="grow">
              Contexte : {kilo(props.context.used)} sur {kilo(props.context.size)}
            </span>
            {props.context.onCompact && (
              <button className="lnk" onClick={props.context.onCompact}>
                Compacter
              </button>
            )}
          </div>
        )}
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
        {head(back("model"), "Effort", null)}
        <EffortTrack
          setting={effort}
          model={modelName}
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
            {a.available && <AgentQuotaTag quota={quotas.find((q) => q.agentId === a.id)} />}
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

/**
 * The effort as one slider whose stops are the agent's own levels, lowest first. Its top level
 * is « Galaxie »: the track turns into a field of stars and the thumb lights up.
 */
function EffortTrack(props: {
  setting: AgentSetting;
  model: string | undefined;
  value: string;
  onPick: (value: string) => void;
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
    if (!box || box.width <= 30) return 0;
    return Math.max(0, Math.min(1, (x - box.left - 15) / (box.width - 30)));
  };
  const at = (x: number) => (n < 2 ? index : Math.round(raw(x) * (n - 1)));
  const pick = (i: number) => {
    const choice = choices[i];
    if (choice && i !== index) props.onPick(choice.id);
  };
  const x = (i: number) => (n < 2 ? 0 : i / (n - 1));
  const galaxy = n > 1 && index === n - 1;
  // Reached while the menu is open, « Galaxie » arrives once with its show; opened on it, calm.
  const below = useRef(!galaxy);
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if (!galaxy) {
      below.current = true;
      setIntro(false);
      return;
    }
    if (!below.current) return;
    below.current = false;
    setIntro(true);
    const timer = setTimeout(() => setIntro(false), 1700);
    return () => clearTimeout(timer);
  }, [galaxy]);
  const recommended = choices.findIndex((c) => c.id === props.setting.current);
  const name = (i: number) => (n > 1 && i === n - 1 ? "Galaxie" : choices[i]?.name);
  const current = choices[index];
  return (
    <div className="eff">
      <div className="eh">
        <span className="el">Effort</span>
        {/* A new level's name comes in out of a blur, like a lens refocusing. */}
        <b
          key={index}
          className={`ev in${galaxy ? " gx" : ""}${galaxy && (intro || below.current) ? " shine" : ""}`}
        >
          {name(index)}
          {galaxy && (
            <small>
              {current?.name}
              {props.model ? `, le maximum de ${props.model}` : ""}
            </small>
          )}
        </b>
      </div>
      <div className="ends" aria-hidden>
        <span>Plus rapide</span>
        <span>Plus réfléchi</span>
      </div>
      <div
        ref={track}
        className={`trk${galaxy ? " gx" : ""}${intro ? " gx-in" : ""}${drag !== null ? " drag" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={`Effort${props.model ? ` de ${props.model}` : ""}`}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={index}
        aria-valuetext={name(index)}
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
        onPointerUp={() => {
          pressed.current = false;
          setDrag(null);
        }}
        onPointerCancel={() => {
          pressed.current = false;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
          if (step) {
            e.preventDefault();
            pick(Math.max(0, Math.min(n - 1, index + step)));
          } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            pick(e.key === "Home" ? 0 : n - 1);
          }
        }}
      >
        {galaxy && <Galaxy intro={intro || below.current} />}
        <i className="fill" />
        {choices.map((c, i) => (
          <i
            key={c.id}
            className={`nt${i === recommended ? " rec" : ""}`}
            style={{ "--x": x(i) } as React.CSSProperties}
          />
        ))}
        <span className="th">
          <IconOrbit />
        </span>
      </div>
      {recommended >= 0 && n > 1 && (
        <div className="recl" aria-hidden>
          <span style={{ "--x": x(recommended) } as React.CSSProperties}>Par défaut</span>
        </div>
      )}
      {current?.description && <p className="mp-desc">{current.description}</p>}
    </div>
  );
}

/**
 * « Galaxie »: pixel stars fill the track, denser and brighter towards the thumb, with a few
 * rays around it. Reached by the user while the menu is open (`intro`), it arrives once with
 * warp streaks, a light front, two shock waves and a burst of sparks; then it stays calm.
 * Drawn only while the menu shows it, and still when motion is reduced.
 */
function Galaxy({ intro: wanted }: { intro: boolean }) {
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
    // The colours follow the theme: a light track in the light theme, deep space in the dark.
    const css = getComputedStyle(c);
    const colors = css
      .getPropertyValue("--gx-pal")
      .replace(/['"\s]/g, "")
      .split(",")
      .filter(Boolean);
    if (!colors.length) colors.push("#4b5bff");
    const ray = css.getPropertyValue("--gx-ray").trim() || "#9fb0ff";
    const light = css.getPropertyValue("--gx-light").trim() === "1";
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
    const X = W - O - 15;
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

/** « 41 k » for 41 000 tokens. */
const kilo = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`
    : n >= 1000
      ? `${Math.round(n / 1000)} k`
      : String(n);

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

/** The window closest to its limit, beside an agent; nothing when it cannot be read. */
function AgentQuotaTag({ quota }: { quota: AgentQuota | undefined }) {
  const worst = tightest(quota);
  if (!worst) return null;
  const level = quotaLevel(worst.usedPercent);
  return (
    <span
      className={`mp-quota ${level}`}
      title={`${worst.label} : ${formatPercent(worst.usedPercent)} utilisés`}
    >
      <i aria-hidden>
        <b style={{ width: `${Math.min(100, worst.usedPercent)}%` }} />
      </i>
      {worst.short} {formatPercent(worst.usedPercent)}
    </span>
  );
}
