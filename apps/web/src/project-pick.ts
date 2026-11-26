// Which projects the home screen offers, and where a new conversation starts. Pure, so it is
// easy to test: an archived project is kept out of every list made for new work.
import type { Project, Thread } from "@moonagentic/protocol";
import { isDiscussionsProject } from "./default-models.ts";
import { pinnedFirst } from "./project-threads.ts";

/** The projects of the phone's « Projets » tab: code projects, pinned first, none archived. */
export function tabProjects(projects: Project[]): Project[] {
  return pinnedFirst(projects.filter((p) => !isDiscussionsProject(p) && !p.archived));
}

/** The conversations with a branch of their own, the latest first, yours before a team member's. */
export function codeThreads(state: { threads: Thread[]; projects: Project[] }): Thread[] {
  const archived = new Set(state.projects.filter((p) => p.archived).map((p) => p.id));
  const withCode = state.threads
    .filter(
      (t) => t.workspace && !t.archived && t.kind !== "coordinator" && !archived.has(t.projectId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const own = withCode.filter((t) => !t.parentId);
  return own.length ? own : withCode;
}

/**
 * The project the composer writes in when no project page is open: the open thread's own,
 * else the one last picked while it can still take new work, else the first that can.
 * Outside a project, « Discussions ».
 */
export function startProject(options: {
  projects: Project[];
  looseHome: boolean;
  threadProjectId?: string | undefined;
  pickedProjectId?: string | null | undefined;
}): Project | undefined {
  const open = options.projects.filter((p) => !p.locked);
  const discussions = open.find(isDiscussionsProject);
  if (options.looseHome) return discussions;
  const code = open.filter((p) => !isDiscussionsProject(p) && !p.archived);
  return (
    (options.threadProjectId ? open.find((p) => p.id === options.threadProjectId) : undefined) ??
    code.find((p) => p.id === options.pickedProjectId) ??
    code[0] ??
    discussions
  );
}
