import type { Project } from "@moonagentic/protocol";
import type { State } from "../connection.ts";
import { MoonMark } from "./MoonMark.tsx";

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
  return (
    <div className="view">
      <div className="home">
        <MoonMark className="mark" />
        <h1 className="greet">Bonjour</h1>
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
          </div>
        )}
      </div>
    </div>
  );
}
