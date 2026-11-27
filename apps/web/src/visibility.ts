// Unified page visibility for both browsers (`document.hidden`) and the Electron desktop
// shell: the desktop window disables `backgroundThrottling` so background notifications keep
// running, which leaves `document.hidden` false even while hidden in the tray.
import { desktopShell } from "./desktop.ts";

let desktopVisible = true;
const listeners = new Set<() => void>();
let docBound = false;
let desktopBound = false;

/** True when the user cannot see the page (background tab, minimized, or hidden in the tray). */
export function isPageHidden(): boolean {
  return (typeof document !== "undefined" && document.hidden) || !desktopVisible;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function bind(): void {
  if (
    !docBound &&
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    docBound = true;
    document.addEventListener("visibilitychange", notify);
  }
  if (!desktopBound) {
    const onVisible = desktopShell()?.onVisible;
    if (onVisible) {
      desktopBound = true;
      onVisible((visible) => setDesktopVisible(visible));
    }
  }
}

/** Updates desktop-window visibility (called from the Electron preload bridge and tests). */
export function setDesktopVisible(visible: boolean): void {
  if (desktopVisible === visible) return;
  desktopVisible = visible;
  notify();
}

/** Runs `listener` whenever effective page visibility changes; returns an unsubscribe handle. */
export function onPageVisibility(listener: () => void): () => void {
  // Listening before the shell is asked: it says at once what it last said, and a window
  // already hidden then is told to this listener too.
  listeners.add(listener);
  bind();
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps `html.page-hidden` in sync so CSS animations pause while hidden in the desktop tray. */
export function watchPageVisibility(): () => void {
  const sync = () => {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.classList.toggle("page-hidden", isPageHidden());
    }
  };
  sync();
  return onPageVisibility(sync);
}

/** The same, for what takes its sight of the page as a value (`<moon-mascot>`). */
export const pageSight = { hidden: isPageHidden, watch: onPageVisibility };
