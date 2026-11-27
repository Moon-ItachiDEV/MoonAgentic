// The composer changes shape instead of jumping: its one line grows into the card (text above,
// model and buttons under), the text travels to its new place and the model's chip comes in.
// Folding does the same the other way.
//
// The layout takes the new shape at once. What is seen starts from the old one and is carried
// to the new by springs (`spring.ts`): how much taller or shorter than its layout the composer
// looks, and how far from its place the text is drawn. Each goes to nothing from where it is,
// at the speed it has, so a change of mind half way goes back from there. The composer's own
// height is never held: what is written, pasted or attached meanwhile has its room at once.

import { type RefObject, useLayoutEffect, useRef } from "react";
import { frames, send, settle, type Spring, still, type Track } from "./spring.ts";

const MORPH: Spring = { duration: 0.42, bounce: 0 };

/** The composer as the layout alone draws it. */
interface Rest {
  height: number;
  /**
   * Where its text starts in it: from the composer's left edge, and from its bottom edge up
   * (the composer grows from its base). Not while the text is put away (dictation).
   */
  text: { left: number; up: number } | null;
}

interface Memo {
  open: boolean;
  /** The layout's shape at the last picture. */
  rest: Rest;
  /** 0 folded, 1 open: what comes in and goes out with the shape. */
  shape: Track;
  /** How much taller than its layout the composer is seen, in px. */
  tall: Track;
  /** How far from its place the text is seen, in px. */
  x: Track;
  y: Track;
  running: Animation[];
}

/** The composer, its text, and the empty first child whose margin makes it look taller. */
interface Parts {
  card: HTMLElement;
  text: HTMLElement;
  grow: HTMLElement;
}

function partsOf(card: HTMLElement | null, text: HTMLElement | null): Parts | null {
  const grow = card?.querySelector<HTMLElement>(":scope > .cgrow");
  return card && text && grow ? { card, text, grow } : null;
}

const unit = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clock = () => performance.now() / 1000;

/**
 * The layout's own shape, whatever is being drawn: measured on the composer itself (what is
 * above it may come and go), and without what a change of shape under way adds.
 */
function measure({ card, text, grow }: Parts): Rest {
  const box = card.getBoundingClientRect();
  const added = parseFloat(getComputedStyle(grow).marginTop) || 0;
  let at: Rest["text"] = null;
  if (text.getClientRects().length) {
    const drawn = text.getBoundingClientRect();
    const moved = getComputedStyle(text).transform;
    const by = moved && moved !== "none" ? new DOMMatrixReadOnly(moved) : null;
    at = {
      left: drawn.left - (by?.m41 ?? 0) - box.left,
      up: box.bottom - (drawn.top - (by?.m42 ?? 0)),
    };
  }
  return { height: box.height - added, text: at };
}

/**
 * The height the composer will have: the page keeps that much room from the start. Said again
 * only when it really changed, not for the fraction of a pixel a measure taken on the way
 * can be off by.
 */
function sayRest(card: HTMLElement, height: number): void {
  const said = Number(card.dataset.rest);
  if (!(Math.abs(height - said) < 1)) card.dataset.rest = String(Math.round(height));
}

/** Nothing is added to the layout any more. */
function clear({ card }: Parts, m: Memo): void {
  for (const animation of m.running) animation.cancel();
  m.running = [];
  delete card.dataset.morph;
  delete card.dataset.rest;
  const bar = card.querySelector<HTMLElement>(".bar");
  if (bar) {
    bar.inert = false;
    bar.removeAttribute("aria-hidden");
  }
}

function park(m: Memo): void {
  m.shape = still(m.open ? 1 : 0);
  m.tall = still(0);
  m.x = still(0);
  m.y = still(0);
}

/** The composer just took its other shape in the layout: it is seen leaving the one it had. */
function change(parts: Parts, m: Memo, open: boolean): void {
  const { card, text, grow } = parts;
  const now = clock();
  // What was seen: the layout's shape at the last picture, and what a move under way adds.
  const was = m.rest;
  const [tall, tallSpeed] = m.tall.at(now);
  const [x, xSpeed] = m.x.at(now);
  const [y, ySpeed] = m.y.at(now);
  clear(parts, m);
  const next = measure(parts);
  m.open = open;
  m.rest = next;
  if (
    // Not drawn before, or not now (its page is put away): there is no shape to leave from.
    !was.height ||
    !next.height ||
    typeof card.animate !== "function" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return park(m);
  // Drawn in its new place, each is seen where it was.
  const from = {
    tall: was.height + tall - next.height,
    x: was.text && next.text ? was.text.left + x - next.text.left : 0,
    y: was.text && next.text ? next.text.up - was.text.up + y : 0,
  };
  if (Math.abs(from.tall) < 0.5 && Math.abs(from.x) < 0.5 && Math.abs(from.y) < 0.5) return park(m);
  m.shape = send(m.shape, open ? 1 : 0, MORPH, now);
  m.tall = settle(from.tall, tallSpeed, MORPH, now);
  m.x = settle(from.x, xSpeed, MORPH, now);
  m.y = settle(from.y, ySpeed, MORPH, now);
  const { shape } = m;
  const { times, duration } = frames(now, shape.end);
  const jobs: [Element, Keyframe[]][] = [
    [grow, times.map((t) => ({ marginTop: `${m.tall.at(t)[0].toFixed(2)}px` }))],
    [
      text,
      times.map((t) => ({
        transform: `translate(${m.x.at(t)[0].toFixed(2)}px, ${m.y.at(t)[0].toFixed(2)}px)`,
      })),
    ],
  ];
  const bar = card.querySelector<HTMLElement>(".bar");
  if (bar && open) {
    // The buttons at both ends stay where the folded line had them: only what is new comes in.
    for (const chip of bar.children)
      if (!chip.classList.contains("cb"))
        jobs.push([chip, times.map((t) => ({ opacity: unit((shape.at(t)[0] - 0.2) / 0.5) }))]);
  } else if (bar) {
    // Folding, the bar stays over the line while it goes: seen, but its buttons are the
    // line's from now on, for the finger as for a screen reader.
    jobs.push([bar, times.map((t) => ({ opacity: unit((shape.at(t)[0] - 0.3) / 0.5) }))]);
    bar.inert = true;
    bar.setAttribute("aria-hidden", "true");
  }
  card.dataset.morph = open ? "open" : "fold";
  sayRest(card, next.height);
  m.running = jobs.map(([part, keyframes]) =>
    part.animate(keyframes, { duration: duration * 1000, fill: "both", easing: "linear" }),
  );
  const mine = m.running;
  mine[0]!.finished.then(
    () => {
      if (m.running !== mine) return;
      clear(parts, m);
      park(m);
      m.rest = measure(parts);
    },
    () => {},
  );
}

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
    const parts = partsOf(box.current, field.current);
    if (!parts) return;
    const m = memo.current;
    if (m) {
      if (m.open !== open) change(parts, m, open);
      return;
    }
    memo.current = {
      open,
      rest: measure(parts),
      shape: still(open ? 1 : 0),
      tall: still(0),
      x: still(0),
      y: still(0),
      running: [],
    };
  }, [box, field, open]);
  // The shape a change will leave from is the one of the last picture: read when the browser
  // has laid the composer out and says its size changed, never while a letter is being typed.
  useLayoutEffect(() => {
    const card = box.current;
    if (!card) return;
    const watch = new ResizeObserver(() => {
      const m = memo.current;
      const parts = partsOf(box.current, field.current);
      if (!m || !parts) return;
      m.rest = measure(parts);
      // More was written while it changes shape: the page is told the room it now takes.
      if (m.running.length) sayRest(parts.card, m.rest.height);
    });
    watch.observe(card);
    return () => watch.disconnect();
  }, [box, field]);
}
