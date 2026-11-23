import { useSyncExternalStore } from "react";

export type SettingsSection =
  | "general"
  | "appearance"
  | "agents"
  | "models"
  | "subscriptions"
  | "coordinator"
  | "mcp"
  | "remote";
export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "appearance",
  "agents",
  "models",
  "subscriptions",
  "coordinator",
  "mcp",
  "remote",
];

export type Route =
  | { name: "home" }
  | { name: "planner" }
  /** A project's page, with one of its threads open beside its coordinator when given. */
  | { name: "project"; projectId: string; threadId?: string }
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
  const project = /^\/p\/([^/]+)(?:\/f\/([^/]+))?$/.exec(pathname);
  try {
    if (project?.[1]) {
      return {
        name: "project",
        projectId: decodeURIComponent(project[1]),
        ...(project[2] ? { threadId: decodeURIComponent(project[2]) } : {}),
      };
    }
  } catch {
    // an address no project can have
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

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path =
    route.name === "thread"
      ? `/t/${encodeURIComponent(route.threadId)}`
      : route.name === "project"
        ? `/p/${encodeURIComponent(route.projectId)}${
            route.threadId ? `/f/${encodeURIComponent(route.threadId)}` : ""
          }`
        : route.name === "planner"
          ? "/planner"
          : route.name === "settings"
            ? `/reglages/${route.section}`
            : "/";
  if (path !== location.pathname) {
    if (options.replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }
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
