import type { Project } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { MoonMark } from "./MoonMark.tsx";

/** « Bonsoir » from 18 h until the small hours, « Bonjour » the rest of the day. */
export const greeting = (hour: number) => (hour >= 18 || hour < 5 ? "Bonsoir" : "Bonjour");

export function Home({
  state,
  project,
  onNewProject,
}: {
  state: State;
  project: Project | undefined;
  onNewProject: () => void;
}) {
  const available = state.agents.filter((a) => a.available).length;
  const mcp = state.mcpServers.filter((m) => m.enabled).length;
  return (
    <div className="view">
      <div className="home">
        <MoonMark className="mark" />
        <h1 className="greet">{greeting(new Date().getHours())}</h1>
        {state.ready && (
          <div className="greet-sub">
            {project ? (
              <span title={project.path}>{project.name}</span>
            ) : (
              <button onClick={onNewProject}>Crée ton premier projet</button>
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
      </div>
    </div>
  );
}
