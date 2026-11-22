/**
 * Official agent logos, shown in place of the letter badge.
 *
 * An agent is listed here only when its maker publishes the mark for anyone to use
 * without asking first. The others keep their letter badge:
 * - Claude Code (Anthropic), Codex (OpenAI) and Antigravity (Google): their brand
 *   guidelines require prior approval to show the logo in another product.
 *
 * Hermes (Nous Research) publishes no rule either way for third-party use; the user
 * chose to show it. Its icon is the official one from hermes-agent.nousresearch.com.
 *
 * Files live in public/agents/, taken unchanged from the maker's own assets.
 */
export const AGENT_LOGOS: Readonly<Record<string, string>> = {
  // Cube mark from Cursor's brand kit (https://cursor.com/brand), 2D on its dark tile.
  cursor: "/agents/cursor.svg",
  // Hermes Agent's own site icon (48 px PNG), shown full tile.
  hermes: "/agents/hermes.png",
};

export function agentLogo(id: string | undefined): string | undefined {
  return id ? AGENT_LOGOS[id] : undefined;
}
