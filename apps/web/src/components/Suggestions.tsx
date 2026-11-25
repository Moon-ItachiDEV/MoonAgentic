import type { Skill } from "@moonagentic/protocol";
import { useLayoutEffect, useRef } from "react";
import type { ComposerCommand, Trigger } from "../commands.ts";

export type Suggestion =
  | { type: "command"; command: ComposerCommand }
  | { type: "file"; path: string }
  | { type: "skill"; skill: Skill };

export const suggestionKey = (s: Suggestion) =>
  s.type === "command"
    ? `/${s.command.name}`
    : s.type === "file"
      ? `@${s.path}`
      : `$${s.skill.name}`;

const TITLES: Record<Trigger["kind"], string> = {
  "/": "Commandes",
  "@": "Mentionner un fichier du projet",
  $: "Utiliser un skill",
};

/** The list that opens above the composer while a `/`, `@` or `$` word is typed. */
export function Suggestions(props: {
  kind: Trigger["kind"];
  items: Suggestion[];
  active: number;
  /** Shown when nothing matches. */
  empty: string | null;
  onPick: (item: Suggestion) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The highlighted row stays in view while the arrow keys move it.
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${props.active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.active]);

  return (
    <div className="sugm" role="listbox" id="composer-suggest" aria-label={TITLES[props.kind]}>
      <div className="sgl" ref={list}>
        {props.items.length === 0 && props.empty && <p className="sge">{props.empty}</p>}
        {props.items.map((item, i) => (
          <button
            key={suggestionKey(item)}
            id={`sg-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === props.active}
            className={`sgr${i === props.active ? " on" : ""}`}
            // The textarea keeps the focus, and its caret.
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== props.active && props.onHover(i)}
            onClick={() => props.onPick(item)}
          >
            <Row item={item} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ item }: { item: Suggestion }) {
  if (item.type === "command") {
    const c = item.command;
    return (
      <>
        <span className="nm">
          /{c.name}
          {c.hint && <i> {c.hint}</i>}
        </span>
        <small>
          {c.description}
          {c.hides?.length ? ` · remplace celle de ${c.hides.join(", ")}` : ""}
        </small>
        <span className="by">{c.by}</span>
      </>
    );
  }
  if (item.type === "file") {
    const at = item.path.lastIndexOf("/");
    return (
      <>
        <span className="nm">{item.path.slice(at + 1)}</span>
        <small className="mono">{at === -1 ? "racine du projet" : item.path.slice(0, at)}</small>
      </>
    );
  }
  const s = item.skill;
  return (
    <>
      <span className="nm">{s.name}</span>
      {s.description && <small>{s.description}</small>}
      <span className="by">{s.scope === "project" ? "Projet" : "Perso"}</span>
    </>
  );
}
