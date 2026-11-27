import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/newsreader/opsz.css";
import "./v2/tokens.css";
import "./v2/app.css";
import "./v2/wide.css";
import "./v2/real.css";
import "./v2/thread.css";
import "./v2/planner.css";
import "./v2/projet.css";
import "./v2/fenetres.css";
import "./v2/parametres.css";
import "./v2/skills.css";
import { watchTabs } from "./v2/tab-slide.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AppFailed, ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { startUpdateBanner } from "./components/UpdateBanner.tsx";
import { installGlobalErrorHandlers, reportUiError } from "./diagnostics.ts";
import { startNotifications } from "./notifications.ts";
import { startPush } from "./push.ts";
import { applyTheme } from "./theme.ts";
import { watchDevice } from "./v2/use-screen.ts";

installGlobalErrorHandlers();
applyTheme();
watchDevice();
watchTabs();

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
