import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "@fontsource-variable/newsreader/opsz.css";
import "./v2/tokens.css";
import "./v2/app.css";
import "./v2/wide.css";
import "./v2/real.css";
import "./v2/thread.css";
import "./v2/planner.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AppFailed, ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { startUpdateBanner } from "./components/UpdateBanner.tsx";
import { installGlobalErrorHandlers } from "./diagnostics.ts";
import { startNotifications } from "./notifications.ts";
import { startPush } from "./push.ts";
import { applyTheme } from "./theme.ts";
import { watchDevice } from "./v2/use-screen.ts";

installGlobalErrorHandlers();
applyTheme();
watchDevice();
startNotifications();
startPush();
startUpdateBanner();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reload) => <AppFailed error={error} reload={reload} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
