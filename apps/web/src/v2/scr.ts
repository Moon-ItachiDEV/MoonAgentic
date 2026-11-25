import { useEffect, useSyncExternalStore } from "react";

/**
 * What is open over the screen (a sheet, the « + » menu, a thread's menu…), said as classes on
 * the screen's root so the rest of the page can dim or step aside, as in the mockup. A part of
 * the page raises its flag while it is open; the root reads them all.
 */
export type ScrFlag = "sh" | "pm" | "tm" | "tp" | "sg" | "ph" | "sdrag";

const raised = new Map<ScrFlag, number>();
const listeners = new Set<() => void>();
let classes = "";

const publish = () => {
  const next = [...raised.keys()].sort().join(" ");
  if (next === classes) return;
  classes = next;
  for (const l of listeners) l();
};

/** Raises the flag while `on` is true and the caller is on the page. */
export function useScrFlag(flag: ScrFlag, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    raised.set(flag, (raised.get(flag) ?? 0) + 1);
    publish();
    return () => {
      const left = (raised.get(flag) ?? 1) - 1;
      if (left > 0) raised.set(flag, left);
      else raised.delete(flag);
      publish();
    };
  }, [flag, on]);
}

/** The classes of every flag raised, for the screen's root. */
export function useScrFlags(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => classes,
  );
}

/** The screen's root, where what floats over the page is drawn. */
export const scrRoot = (): HTMLElement => document.getElementById("scr") ?? document.body;
