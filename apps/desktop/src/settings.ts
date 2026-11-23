import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The shell's own choices; MoonAgentic's are kept by its server. */
export interface DesktopSettings {
  /** Keeps the computer from sleeping while MoonAgentic runs, so that it answers at night. */
  preventSleep: boolean;
  /** Said once that closing the window leaves MoonAgentic running. */
  backgroundHintShown: boolean;
}

export const DEFAULTS: DesktopSettings = { preventSleep: true, backgroundHintShown: false };

export function readSettings(file: string): DesktopSettings {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<DesktopSettings>;
    return {
      preventSleep:
        typeof saved.preventSleep === "boolean" ? saved.preventSleep : DEFAULTS.preventSleep,
      backgroundHintShown: saved.backgroundHintShown === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(file: string, settings: DesktopSettings): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch {
    // Kept for this run only.
  }
}
