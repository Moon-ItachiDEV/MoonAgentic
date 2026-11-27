// The composer changes shape instead of jumping: its one line grows into the card (text above,
// model and buttons under), the text travels to its new place and the model's chip comes in.
// Folding does the same the other way. One spring carries it all (`spring.ts`), so a change of
// mind half way goes back from where it is.

import { type RefObject, useLayoutEffect, useRef } from "react";
import { frames, send, type Spring, still, type Track } from "./spring.ts";

const MORPH: Spring = { duration: 0.42, bounce: 0 };

/** The composer as the layout draws it at rest: its height, and where its text starts. */
interface Rest {
  height: number;
  left: number;
  /** From the composer's bottom edge up to the text's top: the composer grows from its base. */
  up: number;
}

interface Memo {
  open: boolean;
  rest: Rest;
  /** 0 folded, 1 open. */
  track: Track;
  running: Animation[];
}

const unit = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Carries the composer (`box`, with its text `field`) from one shape to the other when `open`
 * changes. While it moves, `data-morph` says which way and `data-rest` the height it will
 * have: the page keeps that much room from the start, not at each step.
 */
export function useComposerMorph(
  box: RefObject<HTMLElement | null>,
  field: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  const memo = useRef<Memo | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const text = field.current;
    if (!el || !text) return;
    const measure = (): Rest => ({
      height: el.offsetHeight,
      left: text.offsetLeft,
      up: el.offsetHeight - text.offsetTop,
    });
    const m = memo.current;
    if (!m) {
      memo.current = { open, rest: measure(), track: still(open ? 1 : 0), running: [] };
      return;
    }
    const bar = el.querySelector<HTMLElement>(".bar");
    const clear = () => {
      for (const animation of m.running) animation.cancel();
      m.running = [];
      delete el.dataset.morph;
      delete el.dataset.rest;
      if (bar) {
        bar.inert = false;
        bar.removeAttribute("aria-hidden");
      }
    };
    if (m.open === open) {
      // At rest, what is measured is what the next change will leave from.
      if (!m.running.length) m.rest = measure();
      return;
    }
    const now = performance.now() / 1000;
    clear();
    const was = m.rest;
    const next = measure();
    m.open = open;
    m.rest = next;
    const park = () => {
      m.track = still(open ? 1 : 0);
    };
    if (
      was.height === next.height ||
      typeof el.animate !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return park();
    const folded = open ? was : next;
    const opened = open ? next : was;
    const dx = folded.left - opened.left;
    const dy = opened.up - folded.up;
    m.track = send(m.track, open ? 1 : 0, MORPH, now);
    const track = m.track;
    const { times, duration } = frames(now, track.end);
    const at = times.map((t) => track.at(t)[0]);
    const jobs: [Element, Keyframe[]][] = [
      [
        el,
        at.map((p) => ({
          height: `${(folded.height + (opened.height - folded.height) * p).toFixed(2)}px`,
        })),
      ],
      [
        text,
        at.map((p) => {
          // Drawn at its new place, the text is seen leaving the old one.
          const left = open ? 1 - p : -p;
          return {
            transform: `translate(${(dx * left).toFixed(2)}px, ${(dy * left).toFixed(2)}px)`,
          };
        }),
      ],
    ];
    if (bar && open) {
      // The buttons at both ends stay where the folded line had them: only what is new comes in.
      for (const chip of bar.children)
        if (!chip.classList.contains("cb"))
          jobs.push([chip, at.map((p) => ({ opacity: unit((p - 0.2) / 0.5) }))]);
    } else if (bar) {
      // Folding, the bar stays over the line while it goes: seen, but its buttons are the
      // line's from now on, for the finger as for a screen reader.
      jobs.push([bar, at.map((p) => ({ opacity: unit((p - 0.3) / 0.5) }))]);
      bar.inert = true;
      bar.setAttribute("aria-hidden", "true");
    }
    el.dataset.morph = open ? "open" : "fold";
    el.dataset.rest = String(next.height);
    m.running = jobs.map(([part, keyframes]) =>
      part.animate(keyframes, { duration: duration * 1000, fill: "both", easing: "linear" }),
    );
    const mine = m.running;
    mine[0]!.finished.then(
      () => {
        if (m.running !== mine) return;
        clear();
        park();
        m.rest = measure();
      },
      () => {},
    );
  });
}
