import { useRef, useState } from "react";
import { Dropdown } from "./Dropdown.tsx";
import { I } from "./I.tsx";
import { Sheet } from "./Sheet.tsx";
import { useScreen } from "./use-screen.ts";

export type Choice = { value: string; label: string; group?: string };

/** A line that shows a choice and opens the sheet to change it. */
export function ChoiceRow(props: {
  title: string;
  /** What names the choice for a screen reader, when the title alone would not. */
  label?: string;
  value: string;
  shown: string;
  choices: Choice[];
  /** On the sheet's header, such as « Tous les modèles ». */
  more?: { label: string; on: boolean; toggle: () => void };
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  // On an iPad or a computer the choice drops from its line, as a menu; on a phone, a sheet.
  const { roomy } = useScreen();
  const groups: { name: string | undefined; choices: Choice[] }[] = [];
  for (const choice of props.choices) {
    const last = groups.at(-1);
    if (last && last.name === choice.group) last.choices.push(choice);
    else groups.push({ name: choice.group, choices: [choice] });
  }
  return (
    <>
      <button
        ref={row}
        type="button"
        className="it"
        aria-haspopup="dialog"
        aria-label={`${props.label ?? props.title} : ${props.shown}`}
        onClick={() => setOpen(true)}
      >
        <span className="tx">{props.title}</span>
        <span className="rt">
          {props.shown}
          <I n="right" s={15} />
        </span>
      </button>
      {roomy && open && (
        <Dropdown anchor={row} role="dialog" onClose={() => setOpen(false)} label={props.title}>
          {props.more && (
            <button
              type="button"
              className="ddmore"
              aria-pressed={props.more.on}
              onClick={props.more.toggle}
            >
              {props.more.label}
            </button>
          )}
          {groups.map((g, i) => (
            <div
              key={g.name ?? i}
              role={g.name ? "group" : "radiogroup"}
              aria-label={g.name ?? props.label ?? props.title}
            >
              {i > 0 && <hr />}
              {g.name && <div className="ddh">{g.name}</div>}
              {g.choices.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={c.value === props.value}
                  onClick={() => {
                    setOpen(false);
                    if (c.value !== props.value) props.onPick(c.value);
                  }}
                >
                  <span className="ddt">{c.label}</span>
                  {c.value === props.value && (
                    <span className="ddk">
                      <I n="check" s={15} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </Dropdown>
      )}
      <Sheet
        open={open && !roomy}
        onClose={() => setOpen(false)}
        title={props.title}
        right={
          props.more && (
            <button
              type="button"
              className="hmore press"
              aria-pressed={props.more.on}
              onClick={props.more.toggle}
            >
              {props.more.label}
            </button>
          )
        }
      >
        <div className="sbody" role="radiogroup" aria-label={props.label ?? props.title}>
          {groups.map((g, i) => (
            <div key={g.name ?? i} {...(g.name ? { role: "group", "aria-label": g.name } : {})}>
              {g.name && <div className="gl2">{g.name}</div>}
              <div className="ins">
                {g.choices.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="it"
                    role="radio"
                    aria-checked={c.value === props.value}
                    onClick={() => {
                      setOpen(false);
                      if (c.value !== props.value) props.onPick(c.value);
                    }}
                  >
                    <span className="tx">{c.label}</span>
                    {c.value === props.value && <I n="check" s={20} className="ck" />}
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
