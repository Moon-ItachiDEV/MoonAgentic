import { readPref, writePref } from "./prefs.ts";

export type Theme = "system" | "light" | "dark";

export function readTheme(): Theme {
  const t = readPref("theme");
  return t === "light" || t === "dark" ? t : "system";
}

/** Follows the system unless this device picked light or dark. */
export function applyTheme(theme: Theme = readTheme()): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  writePref("theme", theme);
  applyTheme(theme);
}
