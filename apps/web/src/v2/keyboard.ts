// The phone's keyboard, followed. Left alone, an iPhone pushes the whole page up when the
// composer is touched: the top bar leaves the screen, the composer ends half way up and the
// home page's tabs stay stuck above the keyboard. Here the page says where the keyboard is
// (`--kb`, and `data-kb` on the page's root while it is up), the composer rests on it, the
// tabs step aside, and what moves is carried there by springs (`spring.ts`).
//
// The keyboard's height is only known once it is up. It is remembered, so that from the second
// time the composer is already drawn above the keyboard at the very moment it takes the focus:
// the system then finds nothing to push, and the page moves together with the keyboard.

import { useSyncExternalStore } from "react";
import { touchScreen } from "../touch.ts";
import { frames, type Motion, send, settle, type Spring, still, type Track } from "./spring.ts";

/** Less than this hidden at the bottom of the page is a browser's bar, not a keyboard. */
const MIN = 80;
/**
 * How long a keyboard expected from a touch is given to show, in ms. An iPhone says it is up
 * only once it has finished rising, and the first one after the app starts is slow.
 */
const WAIT = 1500;
const KEY = "moonagentic.keyboard";

/** The page with its keyboard, the composer and the greeting: one spring, no bounce. */
const FOLLOW: Spring = { duration: 0.42, bounce: 0 };
/** The tabs leave briefly, and come back one after the other with a slight bounce. */
const LEAVE: Spring = { duration: 0.22, bounce: 0 };
const RETURN: Spring = { duration: 0.5, bounce: 0.2 };

/** The window as the browser gives it: its height, what of it is seen, and how it is seen. */
export interface Viewport {
  height: number;
  visible: number;
  offsetTop: number;
  scale: number;
}

/** A keyboard on the screen. */
export interface Keyboard {
  /** Its height. */
  height: number;
  /** How far the system pushed the page up to show the field. */
  top: number;
  /**
   * What it hides at the bottom of the page once the page starts at `top`. Negative when the
   * system pushed the page further than the keyboard is tall: the page then ends above it.
   */
  inset: number;
}

/** The keyboard a window shows, if any. A page zoomed with two fingers says nothing of one. */
export function keyboardOf(v: Viewport): Keyboard | null {
  if (Math.abs(v.scale - 1) > 0.01) return null;
  const height = Math.round(v.height - v.visible);
  if (height < MIN) return null;
  const top = Math.max(0, Math.round(v.offsetTop));
  return { height, top, inset: height - top };
}

/** Where the page follows the keyboard: what it hides at the bottom, and the page's top. */
interface Shown {
  inset: number;
  top: number;
}

let shown: Shown | null = null;
/** The composer's text, while it has the focus. */
let field: HTMLTextAreaElement | null = null;
/** A keyboard is expected until then (ms), from a touch on the composer. */
let waitUntil = 0;
/** The page was moved at the touch, before the focus that should follow. */
let early = false;
/** After the keyboard, the system brings the page back down: its top is followed until there. */
let trail = false;
let fieldWatch: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const clock = () => performance.now() / 1000;
const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The dock's composer text, when that is what an event is about. */
const composerField = (target: EventTarget | null): HTMLTextAreaElement | null =>
  target instanceof HTMLTextAreaElement && target.closest("#bottom .cmp") ? target : null;

function viewport(): Viewport | null {
  const vv = window.visualViewport;
  if (!vv) return null;
  return { height: innerHeight, visible: vv.height, offsetTop: vv.offsetTop, scale: vv.scale };
}

const key = () => `${KEY}.${innerWidth > innerHeight ? "l" : "p"}`;

/** The keyboard's height the last time it was seen, this way up. */
function remembered(): number | undefined {
  try {
    const height = Number(localStorage.getItem(key()));
    return height >= MIN && height < innerHeight * 0.8 ? height : undefined;
  } catch {
    return undefined;
  }
}

function remember(height: number | null): void {
  if (height === (remembered() ?? null)) return;
  try {
    if (height === null) localStorage.removeItem(key());
    else localStorage.setItem(key(), String(height));
  } catch {
    // Private browsing: the keyboard is then followed once it is up, each time.
  }
}

// ── What the page is told ────────────────────────────────────────────────────────────────

function apply(next: Shown | null): void {
  const root = document.documentElement;
  if (next) {
    root.dataset.kb = "";
    root.style.setProperty("--kb", `${next.inset}px`);
  } else {
    delete root.dataset.kb;
    root.style.removeProperty("--kb");
  }
  setTop(next ? next.top : trail ? (shown?.top ?? 0) : 0);
  const flipped = !next !== !shown;
  shown = next;
  if (!flipped) return;
  // A field taken off the page while it had the focus says nothing: it is looked for.
  clearInterval(fieldWatch);
  if (next) fieldWatch = setInterval(checkField, 300);
  for (const l of listeners) l();
}

function setTop(top: number): void {
  const root = document.documentElement;
  if (top > 0) root.style.setProperty("--kbt", `${top}px`);
  else root.style.removeProperty("--kbt");
}

/** True while the page follows a keyboard: the home page's tabs are then out of reach. */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown !== null,
    () => false,
  );
}

/** The dock says its height to the page (`--cbh`); it is asked to at once when the page moves. */
let dockTeller: (() => void) | undefined;
export function setDockTeller(tell: (() => void) | undefined): void {
  dockTeller = tell;
}

// ── What moves, and how ──────────────────────────────────────────────────────────────────

/** A part of the page the keyboard moves, and the line of it that is followed. */
interface Part {
  name: string;
  el: HTMLElement;
  edge: "middle" | "bottom" | "content";
}

function parts(): Part[] {
  const out: Part[] = [];
  const add = (name: string, el: Element | null, edge: Part["edge"]) => {
    if (el instanceof HTMLElement) out.push({ name, el, edge });
  };
  add("top", document.getElementById("top"), "middle");
  add("greet", document.getElementById("gstack"), "middle");
  add("feed", document.querySelector("#main > .view > .feed"), "bottom");
  add("dock", document.getElementById("bottom"), "content");
  add("fade", document.querySelector("#main > .bfade"), "bottom");
  return out;
}

/** Where a part is drawn by the layout alone, down the window. */
function place(part: Part): number {
  const box = part.el.getBoundingClientRect();
  if (part.edge === "middle") return box.top + box.height / 2;
  // The dock ends with room kept under the composer: the composer's own end is followed.
  if (part.edge === "content")
    return box.bottom - (parseFloat(getComputedStyle(part.el).paddingBottom) || 0);
  return box.bottom;
}

/** How far from its place each part is seen, in px. */
let offsets = new Map<string, Track>();
/** 0 with the keyboard down, 1 with it up: how far back the greeting stands. */
let depth: Track = still(0);
/** The same for each tab: 0 there, 1 gone. */
let tabs: Track[] = [still(0), still(0), still(0), still(0)];
/** Where `depth` and `tabs` were last sent. */
let up = false;
let running: Animation[] = [];

function stop(): void {
  for (const animation of running) animation.cancel();
  running = [];
}

/** Everything at rest where it was sent: the tracks no longer hold the moves before them. */
function rest(): void {
  stop();
  offsets = new Map();
  depth = still(up ? 1 : 0);
  tabs = tabs.map(() => still(up ? 1 : 0));
}

/** The page as it is seen before a change: where each part is and how it moves. */
interface Seen {
  moving: Map<string, Motion>;
  places: Map<string, number>;
  /** The reader was at the end of the thread: they stay there. */
  pinned: boolean;
}

let pending: Seen | null = null;

function see(): Seen {
  const now = clock();
  const moving = new Map<string, Motion>();
  for (const [name, track] of offsets) moving.set(name, track.at(now));
  // Without its animations, each part is where the layout puts it.
  stop();
  const places = new Map<string, number>();
  for (const part of parts()) places.set(part.name, place(part));
  const view = document.querySelector<HTMLElement>("#main > .view");
  return {
    moving,
    places,
    pinned: !!view && view.scrollHeight - view.scrollTop - view.clientHeight < 80,
  };
}

/** The page follows `next`, and what that moves travels there instead of jumping. */
function change(next: Shown | null): void {
  if (
    next === shown ||
    (next && shown && Math.abs(next.inset - shown.inset) < 1 && Math.abs(next.top - shown.top) < 1)
  )
    return;
  // Several changes before the next picture start from the same one: what was last seen.
  pending ??= see();
  apply(next);
  requestAnimationFrame(land);
}

/**
 * A change of the page's layout made here and now, by whoever knows of one (the dock, when
 * the composer's new shape asks for more or less room): what it moves travels there too.
 * Called while the page is being laid out, so that nothing is drawn in between.
 */
export function carry(layout: () => void): void {
  pending ??= see();
  layout();
  land();
}

/**
 * Before the next picture, once React has drawn what the focus changed: the parts are where
 * the layout now puts them, and each is sent there from where it was seen.
 */
function land(): void {
  const was = pending;
  pending = null;
  if (!was) return;
  if (early) {
    // The touch was followed by no focus: nothing was shown, nothing is.
    early = false;
    if (!field) {
      apply(null);
      return;
    }
  }
  dockTeller?.();
  const view = document.querySelector<HTMLElement>("#main > .view");
  if (was.pinned && view) view.scrollTop = view.scrollHeight;
  const open = shown !== null;
  if (reduced() || typeof Element.prototype.animate !== "function") {
    up = open;
    rest();
    return;
  }
  const now = clock();
  const list = parts();
  const next = new Map<string, Track>();
  for (const part of list) {
    const from = was.places.get(part.name);
    if (from === undefined) continue;
    const [x, v] = was.moving.get(part.name) ?? [0, 0];
    const offset = x + from - place(part);
    if (Math.abs(offset) >= 0.5 || Math.abs(v) >= 1)
      next.set(part.name, settle(offset, v, FOLLOW, now));
  }
  offsets = next;
  if (open !== up) {
    up = open;
    depth = send(depth, open ? 1 : 0, FOLLOW, now);
    tabs = tabs.map((track, i) =>
      open
        ? send(track, 1, LEAVE, now + i * 0.015)
        : send(track, 0, RETURN, now + 0.12 + i * 0.045),
    );
  }
  play(list, now);
}

const unit = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The moves, drawn ahead and handed to the browser. */
function play(list: Part[], now: number): void {
  const end = Math.max(
    depth.end,
    ...tabs.map((t) => t.end),
    ...[...offsets.values()].map((t) => t.end),
  );
  if (end <= now) return rest();
  const { times, duration } = frames(now, end);
  const jobs: [HTMLElement, Keyframe[]][] = [];
  for (const part of list) {
    const track = offsets.get(part.name);
    const greet = part.name === "greet" && depth.end > now;
    if (!track && !greet) continue;
    jobs.push([
      part.el,
      times.map((t) => {
        const y = `translateY(${(track?.at(t)[0] ?? 0).toFixed(2)}px)`;
        return {
          transform:
            part.name === "greet" ? `${y} scale(${(1 - 0.04 * depth.at(t)[0]).toFixed(4)})` : y,
        };
      }),
    ]);
  }
  document.querySelectorAll<HTMLElement>(".tabbar button").forEach((el, i) => {
    const track = tabs[Math.min(i, tabs.length - 1)]!;
    if (track.end <= now) return;
    jobs.push([
      el,
      times.map((t) => {
        const gone = track.at(t)[0];
        return {
          opacity: unit(1 - gone * 1.35),
          transform: `translateY(${(10 * gone).toFixed(2)}px) scale(${(1 - 0.1 * gone).toFixed(4)})`,
          filter: `blur(${(Math.max(0, gone) * 6).toFixed(2)}px)`,
        };
      }),
    ]);
  });
  if (!jobs.length) return rest();
  running = jobs.map(([el, keyframes]) =>
    el.animate(keyframes, { duration: duration * 1000, fill: "both", easing: "linear" }),
  );
  const mine = running;
  running[0]!.finished.then(
    () => {
      // Arrived: the page's own styles say the same, and the animations are let go.
      if (running === mine) rest();
    },
    () => {},
  );
}

// ── What the keyboard does ───────────────────────────────────────────────────────────────

/** The window changed, or a keyboard that was expected had its time. */
function look(): void {
  const v = viewport();
  if (!v) return;
  if (!field) {
    if (!trail) return;
    // The keyboard is going: the page's top follows the system back down.
    const top = Math.abs(v.scale - 1) > 0.01 ? 0 : Math.max(0, Math.round(v.offsetTop));
    if (top === 0) trail = false;
    setTop(top);
    return;
  }
  const keyboard = keyboardOf(v);
  if (keyboard) {
    waitUntil = 0;
    remember(keyboard.height);
    change({ inset: keyboard.inset, top: keyboard.top });
  } else if (shown && performance.now() >= waitUntil) {
    // Expected and never seen (a keyboard is plugged in): it is not expected the next time.
    if (waitUntil) remember(null);
    waitUntil = 0;
    change(null);
  }
}

/** The composer's text lost the focus: the keyboard goes with it, and the page with both. */
function leave(): void {
  field = null;
  waitUntil = 0;
  if (!shown) return;
  trail = shown.top > 0;
  change(null);
  // The way back down is not always told: it is looked at a few times on the way.
  if (trail) for (const ms of [250, 600, 1200]) setTimeout(look, ms);
}

function checkField(): void {
  if (field && (!field.isConnected || document.activeElement !== field)) leave();
}

/** A keyboard is expected: the page follows the one remembered at once. */
function anticipate(height: number): void {
  change({ inset: height, top: 0 });
  waitUntil = performance.now() + WAIT;
  setTimeout(look, WAIT + 30);
}

/** Starts following the keyboard. Once, when the app starts. */
export function watchKeyboard(): void {
  if (typeof document === "undefined" || !window.visualViewport) return;
  // The touch that will give the composer the focus: the page moves first, so that the
  // system, which looks where the field is when it takes the focus, has nothing to push.
  document.addEventListener(
    "mousedown",
    (e) => {
      const target = composerField(e.target);
      if (!target || shown || document.activeElement === target || !touchScreen()) return;
      const height = remembered();
      if (!height) return;
      early = true;
      anticipate(height);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const target = composerField(e.target);
      if (!target) return;
      field = target;
      trail = false;
      if (early) {
        early = false;
        return;
      }
      const v = viewport();
      const keyboard = v && keyboardOf(v);
      if (keyboard) change({ inset: keyboard.inset, top: keyboard.top });
      else if (touchScreen()) {
        const height = remembered();
        if (height) anticipate(height);
      }
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      // The keyboard goes with the focus: the page goes back with it, not after it.
      if (field && e.target === field) leave();
    },
    true,
  );
  window.visualViewport.addEventListener("resize", look);
  window.visualViewport.addEventListener("scroll", look);
}
