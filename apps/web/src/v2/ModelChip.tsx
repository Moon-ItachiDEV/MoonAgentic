import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { useRef, useState } from "react";
import { effortName, effortOf } from "../effort.ts";
import { parseRouteValue, type RouteOption, routeChoices, routeValue } from "../route-choices.ts";
import { Dropdown } from "./Dropdown.tsx";
import { I } from "./I.tsx";
import { Sheet } from "./Sheet.tsx";
import { useExit } from "./use-exit.ts";
import { useScreen } from "./use-screen.ts";

/** A model as a route keeps it: its agent, the model, and the effort it runs on. */
export type Route = { agentId: string; model?: string; settings?: Record<string, string> };

/**
 * A model choice in the settings: a chip with the model and its reflection level that drops
 * the favorites, then « Réflexion » (iPad, computer); on a phone, a line that opens the same
 * choices in a sheet.
 */
export function ModelChip(props: {
  /** What the choice is for: read aloud, and the line's title on a phone. */
  label: string;
  agents: AgentInfo[];
  favorites: Favorites;
  value: Route | undefined;
  /** Shown while nothing is set: what applies then. */
  unset?: string;
  /** A first line that sets nothing, back to what applies by default. */
  clear?: string;
  disabled?: boolean;
  /** On a phone, a whole line of a list rather than a chip. */
  row?: boolean;
  onChange: (route: Route | undefined) => void;
}) {
  const { agents, value } = props;
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const { roomy } = useScreen();
  const drop = useExit(open && roomy);
  const { groups, favoritesOnly } = routeChoices(agents, props.favorites, value, all);
  const current = value ? routeValue(value.agentId, value.model) : "";
  const options = groups.flatMap((g) => g.options);
  const shown =
    options.find((o) => o.value === current)?.label ??
    (value ? (value.model ?? value.agentId) : undefined);
  const agent = value && agents.find((a) => a.id === value.agentId);
  const effort =
    value && agent?.available ? effortOf(agent, value.model, value.settings) : undefined;
  const text = shown ?? props.unset ?? "—";

  const pickModel = (option: RouteOption) => {
    setOpen(false);
    if (option.value === current) return;
    const picked = parseRouteValue(option.value);
    if (!picked) return;
    // The effort set before goes on with the new model when it offers that level too.
    const next = effortOf(
      agents.find((a) => a.id === picked.agentId),
      picked.model,
      value?.settings,
    );
    const kept =
      next && value?.settings?.[next.setting.id] === next.value
        ? { [next.setting.id]: next.value }
        : undefined;
    props.onChange({ ...picked, ...(kept ? { settings: kept } : {}) });
  };
  const pickEffort = (id: string) => {
    setOpen(false);
    if (!value || !effort || id === effort.value) return;
    props.onChange({ ...value, settings: { ...value.settings, [effort.setting.id]: id } });
  };
  const clear = () => {
    setOpen(false);
    if (value) props.onChange(undefined);
  };

  const more = (favoritesOnly || all) && (
    <button
      type="button"
      className={roomy ? "ddmore" : "hmore press"}
      aria-pressed={all}
      onClick={() => setAll((on) => !on)}
    >
      {all ? "Favoris" : "Tous"}
    </button>
  );

  const menu = drop.mounted && (
    <Dropdown
      anchor={chip}
      role="dialog"
      className={`mcm${drop.leaving ? " out" : ""}`}
      onClose={() => setOpen(false)}
      label={props.label}
    >
      {more}
      <ModelLines
        agents={agents}
        favorites={props.favorites}
        value={value}
        all={all}
        {...(props.clear ? { clear: props.clear } : {})}
        onPick={(route) => {
          setOpen(false);
          if (route !== value) props.onChange(route);
        }}
      />
    </Dropdown>
  );

  const line = (key: string, label: string, on: boolean, run: () => void) => (
    <button key={key} type="button" className="it" role="radio" aria-checked={on} onClick={run}>
      <span className="tx">{label}</span>
      {on && <I n="check" s={20} className="ck" />}
    </button>
  );
  const sheet = !roomy && (
    <Sheet open={open} onClose={() => setOpen(false)} title={props.label} right={more}>
      <div className="sbody">
        {props.clear && <div className="ins">{line("", props.clear, !value, clear)}</div>}
        {favoritesOnly ? (
          <div role="radiogroup" aria-label="Favoris">
            <div className="gl2">Favoris</div>
            <div className="ins">
              {options.map((o) => line(o.value, o.label, o.value === current, () => pickModel(o)))}
            </div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.agent.id} role="radiogroup" aria-label={g.agent.name}>
              <div className="gl2">{g.agent.name}</div>
              <div className="ins">
                {g.options.map((o) =>
                  line(o.value, o.label, o.value === current, () => pickModel(o)),
                )}
              </div>
            </div>
          ))
        )}
        {effort && (
          <div role="radiogroup" aria-label="Réflexion">
            <div className="gl2">Réflexion</div>
            <div className="ins">
              {effort.setting.choices.map((c, i) =>
                line(c.id, effortName(effort.setting, i), c.id === effort.value, () =>
                  pickEffort(c.id),
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );

  return (
    <>
      {props.row ? (
        <button
          ref={chip}
          type="button"
          className="it"
          aria-haspopup="dialog"
          aria-label={`${props.label} : ${text}`}
          disabled={props.disabled}
          onClick={() => setOpen(true)}
        >
          <span className="tx">{props.label}</span>
          <span className="rt">
            {text}
            {effort && <em className="ppe"> · {effort.name}</em>}
            <I n="right" s={15} />
          </span>
        </button>
      ) : (
        <button
          ref={chip}
          type="button"
          className="ppch"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${props.label} : ${text}${effort ? `, réflexion ${effort.name}` : ""}`}
          disabled={props.disabled}
          onClick={() => setOpen((on) => !on)}
        >
          <span className={shown ? undefined : "ppu"}>{text}</span>
          {effort && <em>{effort.name}</em>}
          <span className="pcv">
            <I n="down" s={13} />
          </span>
        </button>
      )}
      {menu}
      {sheet}
    </>
  );
}

/**
 * The lines of a model menu: the favorites (or every model once « Tous » is asked for), then
 * « Réflexion » for the model picked. `onPick` gets the route chosen, or `value` itself when
 * the line picked is the one already chosen.
 */
export function ModelLines(props: {
  agents: AgentInfo[];
  favorites: Favorites;
  value: Route | undefined;
  all: boolean;
  clear?: string;
  onPick: (route: Route | undefined) => void;
}) {
  const { agents, value } = props;
  const { groups, favoritesOnly } = routeChoices(agents, props.favorites, value, props.all);
  const current = value ? routeValue(value.agentId, value.model) : "";
  const options = groups.flatMap((g) => g.options);
  const agent = value && agents.find((a) => a.id === value.agentId);
  const effort =
    value && agent?.available ? effortOf(agent, value.model, value.settings) : undefined;
  const pickModel = (option: RouteOption) => {
    if (option.value === current) return props.onPick(value);
    const picked = parseRouteValue(option.value);
    if (!picked) return props.onPick(value);
    // The effort set before goes on with the new model when it offers that level too.
    const next = effortOf(
      agents.find((a) => a.id === picked.agentId),
      picked.model,
      value?.settings,
    );
    const kept =
      next && value?.settings?.[next.setting.id] === next.value
        ? { [next.setting.id]: next.value }
        : undefined;
    props.onPick({ ...picked, ...(kept ? { settings: kept } : {}) });
  };
  const pickEffort = (id: string) => {
    if (!value || !effort || id === effort.value) return props.onPick(value);
    props.onPick({ ...value, settings: { ...value.settings, [effort.setting.id]: id } });
  };
  const clear = () => props.onPick(undefined);
  const tick = (on: boolean, s: number) =>
    on && (
      <span className="ddk">
        <I n="check" s={s} />
      </span>
    );
  return (
    <>
      {props.clear && (
        <>
          <button type="button" role="radio" aria-checked={!value} onClick={clear}>
            <span className="ddt">{props.clear}</span>
            {tick(!value, 15)}
          </button>
          <hr />
        </>
      )}
      {favoritesOnly ? (
        <div role="radiogroup" aria-label="Favoris">
          <div className="ddh">Favoris</div>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === current}
              onClick={() => pickModel(o)}
            >
              <span className="ddt">{o.label}</span>
              {tick(o.value === current, 15)}
            </button>
          ))}
        </div>
      ) : (
        groups.map((g, i) => (
          <div key={g.agent.id} role="radiogroup" aria-label={g.agent.name}>
            {i > 0 && <hr />}
            <div className="ddh">{g.agent.name}</div>
            {g.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={o.value === current}
                onClick={() => pickModel(o)}
              >
                <span className="ddt">{o.label}</span>
                {tick(o.value === current, 15)}
              </button>
            ))}
          </div>
        ))
      )}
      {effort && (
        <div role="radiogroup" aria-label="Réflexion">
          <hr />
          <div className="ddh">Réflexion</div>
          {effort.setting.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === effort.value}
              onClick={() => pickEffort(c.id)}
            >
              <span className="ddt">{effortName(effort.setting, i)}</span>
              {tick(c.id === effort.value, 15)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
