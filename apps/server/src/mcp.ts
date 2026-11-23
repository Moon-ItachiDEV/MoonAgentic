import type * as acp from "@agentclientprotocol/sdk";
import type { McpServerInfo, McpServerInput } from "@moonagentic/protocol";

/** Reserved for MoonAgentic's internal coordinator bridge: user MCP servers cannot take it. */
export const RESERVED_MCP_NAME = "moonagentic";

/** An MCP server as kept on disk, secrets included. */
export interface McpServerRecord extends McpServerInput {
  id: string;
  enabled: boolean;
}

const quote = (arg: string) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg);

/** What clients may see: everything but the secret values. */
export function mcpInfo(server: McpServerRecord): McpServerInfo {
  const t = server.transport;
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: t.type,
    target: t.type === "stdio" ? [t.command, ...t.args].map(quote).join(" ") : t.url,
    secretNames: (t.type === "stdio" ? t.env : t.headers).map((s) => s.name),
  };
}

/** The enabled servers in ACP form, leaving out HTTP ones for agents that cannot reach them. */
export function acpMcpServers(
  servers: McpServerRecord[],
  capabilities: acp.McpCapabilities | null | undefined,
): acp.McpServer[] {
  return servers
    .filter((s) => s.enabled)
    .flatMap((s): acp.McpServer[] => {
      const t = s.transport;
      if (t.type === "stdio")
        return [{ name: s.name, command: t.command, args: t.args, env: t.env }];
      if (!capabilities?.http) return [];
      return [{ type: "http", name: s.name, url: t.url, headers: t.headers }];
    });
}
