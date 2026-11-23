/**
 * Agent logos, shown in place of the two-letter fallback badge.
 *
 * Files live in public/agents/. Custom agents and the built-in demo agents keep their
 * letter badges.
 */
export const AGENT_LOGOS: Readonly<Record<string, string>> = {
  claude: "/agents/claude.svg",
  codex: "/agents/codex.svg",
  antigravity: "/agents/antigravity.svg",
  // Cube mark from Cursor's brand kit (https://cursor.com/brand), 2D on its dark tile.
  cursor: "/agents/cursor.svg",
  // Hermes Agent's own site icon (48 px PNG), shown full tile.
  hermes: "/agents/hermes.png",
};

export function agentLogo(id: string | undefined): string | undefined {
  return id ? AGENT_LOGOS[id] : undefined;
}
