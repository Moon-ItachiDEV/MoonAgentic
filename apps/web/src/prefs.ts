// Per-device conveniences only; anything shared lives on the server.
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`moonagentic.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`moonagentic.${key}`, value);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}
