import type { Project, Thread } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { mcpCount } from "../mcp-scope.ts";
import { MoonMark } from "./MoonMark.tsx";
import { Overview } from "./Overview.tsx";
import { updateShown } from "../app-update.ts";
import { AppUpdateHomePill } from "./AppUpdatePill.tsx";

/** « Bonsoir » from 18 h until the small hours, « Bonjour » the rest of the day. */
export const greeting = (hour: number) => (hour >= 18 || hour < 5 ? "Bonsoir" : "Bonjour");

export function Home({
  state,
  project,
  onNewProject,
  overview,
}: {
  state: State;
  project: Project | undefined;
  onNewProject: () => void;
  /** The overview under the greeting, once there is a thread to talk about. */
  overview?: {
    shown: boolean;
    narrow: boolean;
    onToggle: (shown: boolean) => void;
    onOpenThread: (thread: Thread) => void;
    onOpenPlanner: () => void;
    onOpenSubscriptions: () => void;
  };
}) {
  const available = state.agents.filter((a) => a.available).length;
  const hasCodeProject = state.projects.some((p) => !isDiscussionsProject(p));
  const shownProject = project && !isDiscussionsProject(project) ? project : undefined;
  // Those a thread started here is given: for every project, or for this one.
  const mcp = mcpCount(state.mcpServers, project?.id);
  const withOverview = !!overview && state.ready && state.threads.length > 0;
  return (
    <div className="view">
      <div className={`home${withOverview ? " with-ov" : ""}`}>
        <MoonMark className="mark" />
        <h1 className="greet">{greeting(new Date().getHours())}</h1>
        {state.ready && (
          <div className="greet-sub">
            {shownProject ? (
              <span title={shownProject.path}>{shownProject.name}</span>
            ) : !hasCodeProject ? (
              <button onClick={onNewProject}>Crée ton premier projet</button>
            ) : (
              <span>Hors projet</span>
            )}
            <span className="sep" />
            <span>
              {available} {available > 1 ? "agents prêts" : "agent prêt"}
            </span>
            {mcp > 0 && (
              <>
                <span className="sep" />
                <span>
                  {mcp} {mcp > 1 ? "serveurs MCP" : "serveur MCP"}
                </span>
              </>
            )}
          </div>
        )}
        {/* Without the overview, the pill of a newer version still shows: on a phone, the
            side bar is folded away. */}
        {!(withOverview && overview.shown) && updateShown(state.app) && (
          <div className="ov-pills apu-home">
            <AppUpdateHomePill />
          </div>
        )}
        {withOverview &&
          (overview.shown ? (
            <Overview
              state={state}
              narrow={overview.narrow}
              onOpenThread={overview.onOpenThread}
              onOpenPlanner={overview.onOpenPlanner}
              onOpenSubscriptions={overview.onOpenSubscriptions}
              onHide={() => overview.onToggle(false)}
            />
          ) : (
            <button className="ov-show" onClick={() => overview.onToggle(true)}>
              Afficher l'aperçu
            </button>
          ))}
      </div>
    </div>
  );
}
