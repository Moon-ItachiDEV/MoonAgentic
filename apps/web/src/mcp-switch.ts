// A project switched on or off for an MCP server, from that project's settings.
import type { McpServerInfo, Project } from "@moonagentic/protocol";

/**
 * The projects a server reaches once one project is switched on or off for it: every project
 * but that one when it reached them all, the locked ones included so that they keep it, and
 * back to `null` once it reaches them all again, so the projects made later get it too.
 */
export function scopeSwitched(
  server: McpServerInfo,
  projectId: string,
  on: boolean,
  projects: Project[],
): string[] | null {
  const all = projects.map((p) => p.id);
  const others = (server.projectIds ?? all).filter((id) => id !== projectId);
  const next = on ? [...others, projectId] : others;
  return all.every((id) => next.includes(id)) ? null : next;
}
