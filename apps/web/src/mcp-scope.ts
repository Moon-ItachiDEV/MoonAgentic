// Who gets an MCP server, as the app says it.
import {
  type AgentInfo,
  type McpServerInfo,
  mcpReaches,
  type Project,
} from "@moonagentic/protocol";

/**
 * Who gets a server: which projects (`null` for all of them, but those left out), and a team's
 * every role or not.
 */
export interface McpScope {
  projectIds: string[] | null;
  exceptProjectIds?: string[];
  allRoles: boolean;
}

export const scopeOf = (server: McpServerInfo): McpScope => ({
  projectIds: server.projectIds ?? null,
  ...(server.exceptProjectIds ? { exceptProjectIds: server.exceptProjectIds } : {}),
  allRoles: !!server.allRoles,
});

/** True when the threads of that project get the server, once it is enabled. */
export const mcpInProject = (server: McpServerInfo, projectId: string | undefined): boolean =>
  mcpReaches(server, projectId);

/** The enabled servers a new thread of that project is given. */
export const mcpCount = (servers: McpServerInfo[], projectId: string | undefined): number =>
  servers.filter((s) => s.enabled && mcpInProject(s, projectId)).length;

/** In a few words, the projects and the roles a server is for. */
export function mcpScopeLabel(scope: McpScope, projects: Project[]): string {
  const names = (scope.projectIds ?? []).flatMap(
    (id) => projects.find((p) => p.id === id)?.name ?? [],
  );
  const except = scope.exceptProjectIds?.length ?? 0;
  const where = !scope.projectIds
    ? except
      ? `Tous sauf ${except} projet${except > 1 ? "s" : ""}`
      : "Tous les projets"
    : names.length === 0
      ? "Aucun projet"
      : names.length <= 2
        ? names.join(", ")
        : `${names.length} projets`;
  return scope.allRoles ? `${where} · toute l'équipe` : where;
}

/** In a few words, the agents a server is for, when it is not for every one. */
export function mcpAgentsLabel(agentIds: string[], agents: AgentInfo[]): string {
  const names = agentIds.flatMap((id) => agents.find((a) => a.id === id)?.name ?? []);
  return names.length === 0
    ? "Aucun agent"
    : names.length <= 2
      ? names.join(", ")
      : `${names.length} agents`;
}
