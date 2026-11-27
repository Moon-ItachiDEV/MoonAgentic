// A project switched on or off for an MCP server, from that project's settings.
import type { McpServerInfo } from "@moonagentic/protocol";

/**
 * Who a server is for once one project is switched on or off for it: a server for every
 * project stays one, that project left out or let back in, so that the others (a locked one
 * among them) keep it and the projects made later get it too; a server for some projects
 * only gains or loses that one.
 */
export function scopeSwitched(
  server: McpServerInfo,
  projectId: string,
  on: boolean,
): { projectIds: string[] | null; exceptProjectIds?: string[] } {
  if (server.projectIds) {
    const others = server.projectIds.filter((id) => id !== projectId);
    return { projectIds: on ? [...others, projectId] : others };
  }
  const others = (server.exceptProjectIds ?? []).filter((id) => id !== projectId);
  const except = on ? others : [...others, projectId];
  return { projectIds: null, ...(except.length ? { exceptProjectIds: except } : {}) };
}

/** A server for locked projects alone: theirs, not to be shown nor offered elsewhere. */
export const lockedOnly = (server: McpServerInfo, projects: { id: string; locked?: boolean }[]) =>
  !!server.projectIds?.length &&
  server.projectIds.every((id) => projects.find((p) => p.id === id)?.locked);
