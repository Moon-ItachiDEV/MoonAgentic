import type { AgentInfo, Favorites } from "@moonagentic/protocol";
import { useRef, useState } from "react";
import { parseRouteValue, routeChoices, routeValue } from "../route-choices.ts";
import { Dropdown } from "./Dropdown.tsx";
import { I } from "./I.tsx";
import { Sheet } from "./Sheet.tsx";
import { useScreen } from "./use-screen.ts";

type Pick = { agentId: string; model?: string };

/**
 * A model as a small pill at the end of a line: it opens the sheet of the favorite models,
 * never a list of agents first. `none` adds a way to pick nobody, for a role one can do without.
 */
export function ModelPill(props: {
  /** What the choice is for, read aloud and set as the sheet's title. */
  label: string;
  agents: AgentInfo[];
  favorites: Favorites;
  value: Pick | undefined;
  none?: string;
  onChange: (pick: Pick | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const { roomy } = useScreen();
  const { groups, favoritesOnly } = routeChoices(props.agents, props.favorites, props.value, all);
  const value = props.value ? routeValue(props.value.agentId, props.value.model) : "";
  const shown =
    groups.flatMap((g) => g.options).find((o) => o.value === value)?.label ??
    (props.value ? (props.value.model ?? props.value.agentId) : undefined);
  const pick = (next: string) => {
    setOpen(false);
    if (next !== value) props.onChange(next ? parseRouteValue(next) : undefined);
  };
  const line = (v: string, label: string) => (
    <button key={v} type="button" role="radio" aria-checked={v === value} onClick={() => pick(v)}>
      <span className="ddt">{label}</span>
      {v === value && (
        <span className="ddk">
          <I n="check" s={15} />
        </span>
      )}
    </button>
  );
  return (
    <>
      <button
        ref={pill}
        type="button"
        className={shown ? "tmm" : "tmm tmno"}
        aria-haspopup="dialog"
        aria-label={`${props.label} : ${shown ?? props.none ?? "à choisir"}`}
        onClick={() => setOpen(true)}
      >
        {shown ?? "—"}
        <I n="down" s={13} />
      </button>
      {roomy && open && (
        <Dropdown anchor={pill} role="dialog" onClose={() => setOpen(false)} label={props.label}>
          {(favoritesOnly || all) && (
            <button
              type="button"
              className="ddmore"
              aria-pressed={all}
              onClick={() => setAll((on) => !on)}
            >
              {all ? "Favoris" : "Tous"}
            </button>
          )}
          {props.none && line("", props.none)}
          {groups.map((g, i) => (
            <div key={g.agent.id} role="group" aria-label={g.agent.name}>
              {(i > 0 || props.none) && <hr />}
              <div className="ddh">{g.agent.name}</div>
              {g.options.map((o) => line(o.value, o.label))}
            </div>
          ))}
        </Dropdown>
      )}
      <Sheet
        open={open && !roomy}
        onClose={() => setOpen(false)}
        title={props.label}
        right={
          (favoritesOnly || all) && (
            <button
              type="button"
              className="hmore press"
              aria-pressed={all}
              onClick={() => setAll((on) => !on)}
            >
              {all ? "Favoris" : "Tous"}
            </button>
          )
        }
      >
        <div className="sbody" role="radiogroup" aria-label={props.label}>
          {props.none && (
            <div className="ins">
              <button
                type="button"
                className="it"
                role="radio"
                aria-checked={!value}
                onClick={() => pick("")}
              >
                <span className="tx">{props.none}</span>
                {!value && <I n="check" s={20} className="ck" />}
              </button>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.agent.id} role="group" aria-label={g.agent.name}>
              <div className="gl2">{g.agent.name}</div>
              <div className="ins">
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className="it"
                    role="radio"
                    aria-checked={o.value === value}
                    onClick={() => pick(o.value)}
                  >
                    <span className="tx">{o.label}</span>
                    {o.value === value && <I n="check" s={20} className="ck" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
