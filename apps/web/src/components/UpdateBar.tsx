// The update bar of the home page, kept in the main chunk: it is small and shows at once. The
// sheet and the steps of an install (AppUpdate.tsx) are loaded once there is something to say,
// while the server still answers: a page that waits for it to come back already has them.
import { lazy, Suspense, useSyncExternalStore } from "react";
import { installSteps, openUpdateCard, updateShown, workingLine } from "../app-update.ts";
import { connection } from "../connection.ts";

const useApp = () => {
  const app = useSyncExternalStore(connection.subscribe, () => connection.getState().app);
  const status = useSyncExternalStore(connection.subscribe, () => connection.getState().status);
  return { app, status };
};

const Host = lazy(() => import("./AppUpdate.tsx").then((m) => ({ default: m.AppUpdateHost })));

/** Above the home page's composer, only while there is a newer version to speak of. */
export function UpdateBar() {
  const { app, status } = useApp();
  if (!updateShown(app)) return null;
  const u = app.update;
  const name = app.kind === "git" ? "Nouvelle version" : `Version ${u.version ?? ""}`.trim();
  if (u.phase) {
    const now = installSteps(u, status === "open").find((s) => s.state === "now");
    return (
      <div className="updb glass inst" role="status">
        <span className="t2-spin" />
        <span className="tx">{now?.label ?? "Installation"}</span>
      </div>
    );
  }
  if (u.install) {
    const n = u.working ?? 0;
    return (
      <div className="updb glass" role="status">
        <span className="tx">
          {u.version ?? "Mise à jour"} quand rien ne tourne
          {n > 0 && <small>{workingLine(n)}</small>}
        </span>
        <button className="b2 soft press" onClick={() => connection.send({ type: "app.cancel" })}>
          Annuler
        </button>
      </div>
    );
  }
  const loading = u.state === "downloading";
  return (
    <div className={`updb glass${loading ? " inst" : ""}`} role="status">
      {loading ? <span className="t2-spin" /> : <span className="dvon" />}
      <span className="tx">
        {name}
        {loading && <span className="mono"> · {Math.round((u.progress ?? 0) * 100)} %</span>}
        {u.state === "failed" && <small className="mer">Téléchargement en échec</small>}
      </span>
      <button className="b2 ink press" aria-haspopup="dialog" onClick={() => openUpdateCard()}>
        Voir
      </button>
    </div>
  );
}

let hostWanted = false;

/** The sheet and the steps of an install, loaded only once there is a version to speak of. */
export function AppUpdateHostOnDemand() {
  const { app } = useApp();
  // Once loaded it stays: back from an install, the server says there is nothing newer, and
  // the host must still see it come back to load the new build.
  if (updateShown(app)) hostWanted = true;
  if (!hostWanted) return null;
  return (
    <Suspense fallback={null}>
      <Host />
    </Suspense>
  );
}
