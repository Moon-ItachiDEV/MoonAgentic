import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "thread"; threadId: string };

const parse = (pathname: string): Route => {
  const match = /^\/t\/([^/]+)$/.exec(pathname);
  return match?.[1] ? { name: "thread", threadId: decodeURIComponent(match[1]) } : { name: "home" };
};

const listeners = new Set<() => void>();
let current = parse(location.pathname);
window.addEventListener("popstate", () => {
  current = parse(location.pathname);
  for (const l of listeners) l();
});

export function navigate(route: Route): void {
  const path = route.name === "thread" ? `/t/${encodeURIComponent(route.threadId)}` : "/";
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
