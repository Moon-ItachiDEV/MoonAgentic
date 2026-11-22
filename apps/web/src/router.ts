import { useSyncExternalStore } from "react";

export type SettingsSection = "general" | "appearance" | "agents" | "models" | "mcp" | "remote";
export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "appearance",
  "agents",
  "models",
  "mcp",
  "remote",
];

export type Route =
  | { name: "home" }
  | { name: "planner" }
  | { name: "thread"; threadId: string }
  | { name: "settings"; section: SettingsSection };

const parse = (pathname: string): Route => {
  const settings = /^\/reglages(?:\/([a-z]+))?$/.exec(pathname);
  if (settings) {
    const section = SETTINGS_SECTIONS.find((s) => s === settings[1]) ?? "general";
    return { name: "settings", section };
  }
  const match = /^\/t\/([^/]+)$/.exec(pathname);
  try {
    if (match?.[1]) return { name: "thread", threadId: decodeURIComponent(match[1]) };
  } catch {
    // an address no thread can have
  }
  if (pathname === "/planner") return { name: "planner" };
  return { name: "home" };
};

const listeners = new Set<() => void>();
let current = parse(location.pathname);
window.addEventListener("popstate", () => {
  current = parse(location.pathname);
  for (const l of listeners) l();
});

export function navigate(route: Route): void {
  const path =
    route.name === "thread"
      ? `/t/${encodeURIComponent(route.threadId)}`
      : route.name === "planner"
        ? "/planner"
        : route.name === "settings"
          ? `/reglages/${route.section}`
          : "/";
  if (path !== location.pathname) history.pushState(null, "", path);
  current = route;
  for (const l of listeners) l();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
