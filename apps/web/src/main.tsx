import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "./styles.css";
import "./picker.css";
import "./planner.css";
import "./review.css";
import "./settings.css";
import "./sidebar.css";
import "./github.css";
import "./remote.css";
import "./pull-request.css";
import "./composer.css";
import "./overview.css";
import "./quotas.css";
import "./quiet.css";
import "./offline.css";
import "./project.css";
import "./phone.css";
import "./update.css";
import "./plan.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startUpdateBanner } from "./components/UpdateBanner.tsx";
import { startNotifications } from "./notifications.ts";
import { applyTheme } from "./theme.ts";

applyTheme();
startNotifications();
startUpdateBanner();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
