import { useSyncExternalStore } from "react";

export type SettingsSection =
  | "general"
  | "appearance"
  | "agents"
  | "mascots"
  | "models"
  | "subscriptions"
  | "coordinator"
  | "mcp"
  | "remote";
export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "appearance",
  "agents",
  "mascots",
  "models",
  "subscriptions",
  "coordinator",
  "mcp",
  "remote",
];

/** The planner's views other than its board, each at its own address. */
export const PLANNER_VIEWS = ["timeline", "planifiees"] as const;
export type PlannerView = (typeof PLANNER_VIEWS)[number];

export type Route =
  | { name: "home" }
  /** The planner: its board, or the view given (`/planner/planifiees`: the planned tasks). */
  | { name: "planner"; view?: PlannerView }
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
  const planner = /^\/planner(?:\/([a-z]+))?$/.exec(pathname);
  if (planner) {
    const view = PLANNER_VIEWS.find((v) => v === planner[1]);
    return view ? { name: "planner", view } : { name: "planner" };
  }
  return { name: "home" };
};

const listeners = new Set<() => void>();
let current = parse(location.pathname);
window.addEventListener("popstate", () => {
  current = parse(location.pathname);
  for (const l of listeners) l();
});

/** The address of a route. */
const pathOf = (route: Route): string =>
  route.name === "thread"
    ? `/t/${encodeURIComponent(route.threadId)}`
    : route.name === "project"
      ? `/p/${encodeURIComponent(route.projectId)}${
          route.threadId ? `/f/${encodeURIComponent(route.threadId)}` : ""
        }`
      : route.name === "planner"
        ? `/planner${route.view ? `/${route.view}` : ""}`
        : route.name === "settings"
          ? `/reglages/${route.section}`
          : "/";

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = pathOf(route);
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
