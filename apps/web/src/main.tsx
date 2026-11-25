import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "./styles.css";
import "./picker.css";
import "./planner.css";
import "./review.css";
import "./review-sync.css";
import "./worktree-files.css";
import "./branch-cleanup.css";
import "./artifacts.css";
import "./settings.css";
import "./sidebar.css";
import "./github.css";
import "./remote.css";
import "./pairing.css";
import "./pull-request.css";
import "./pr-watch.css";
import "./pr-review.css";
import "./pr-remarks.css";
import "./composer.css";
import "./mascot.css";
import "./decision.css";
import "./long-threads.css";
import "./queue.css";
import "./goal.css";
import "./planner-run.css";
import "./images.css";
import "./local-files.css";
import "./mcp-scope.css";
import "./overview.css";
import "./quotas.css";
import "./quiet.css";
import "./stopped.css";
import "./offline.css";
import "./project.css";
import "./phone.css";
import "./update.css";
import "./plan.css";
import "./team-tree.css";
import "./pr-board.css";
import "./app-update.css";
import "./team-presets.css";
import "./project-settings.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AppFailed, ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { startUpdateBanner } from "./components/UpdateBanner.tsx";
import { installGlobalErrorHandlers, reportUiError } from "./diagnostics.ts";
import { startNotifications } from "./notifications.ts";
import { startPush } from "./push.ts";
import { applyTheme } from "./theme.ts";

installGlobalErrorHandlers();
applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reload) => <AppFailed error={error} reload={reload} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// What runs beside the page never keeps it from showing: a browser missing one of these
// (an iPhone app on the home screen has its own) loses that part alone.
for (const [name, start] of [
  ["notifications", startNotifications],
  ["push", startPush],
  ["update", startUpdateBanner],
] as const) {
  try {
    start();
  } catch (error) {
    reportUiError(`start.${name}`, error);
  }
}
