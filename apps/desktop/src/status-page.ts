import type { ServerState } from "./server-process.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the tray icon's menu says of the server. */
export function stateLabel(state: ServerState, port: number): string {
  switch (state.kind) {
    case "starting":
      return "Démarrage…";
    case "ready":
      return `En marche, port ${port}`;
    case "restarting":
      return "Redémarrage…";
    case "stopping":
      return "Arrêt des agents…";
    case "stopped":
      return "Arrêté";
    case "failed":
      return "Ne peut pas démarrer";
  }
}

/** The page the window shows until the server first answers. */
export function statusPage(state: ServerState, logDir: string): string {
  const title =
    state.kind === "failed"
      ? "MoonAgentic ne peut pas démarrer"
      : state.kind === "restarting"
        ? "MoonAgentic redémarre"
        : "MoonAgentic démarre";
  const detail =
    state.kind === "restarting" || state.kind === "failed" ? state.reason : "Le serveur se lance.";
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>MoonAgentic</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --fg: #ececef; --muted: #a1a1aa; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; padding: 0 16px; text-align: center; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 6px; color: var(--muted); }
  code { font-size: 12px; word-break: break-all; }
</style></head>
<body><main>
  <h1>${escape(title)}</h1>
  <p>${escape(detail)}</p>
  <p>Journal : <code>${escape(logDir)}</code></p>
</main></body></html>`;
}
