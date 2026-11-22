/**
 * Official agent logos, shown in place of the letter badge.
 *
 * An agent is listed here only when its maker publishes the mark for anyone to use
 * without asking first. The others keep their letter badge:
 * - Claude Code (Anthropic), Codex (OpenAI) and Antigravity (Google): their brand
 *   guidelines require prior approval to show the logo in another product.
 * - Hermes (Nous Research): no published rule for third-party use of the mark.
 *
 * Files live in public/agents/, taken unchanged from the maker's brand kit.
 */
export const AGENT_LOGOS: Readonly<Record<string, string>> = {
  // Cube mark from Cursor's brand kit (https://cursor.com/brand), 2D on its dark tile.
  cursor: "/agents/cursor.svg",
};

export function agentLogo(id: string | undefined): string | undefined {
  return id ? AGENT_LOGOS[id] : undefined;
}
