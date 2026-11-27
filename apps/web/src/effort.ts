import { type AgentInfo, type AgentSetting, agentSettingsFor } from "@moonagentic/protocol";

/** The name of an effort level: the agent's own, but the highest, which is « UltraMoon ». */
export const effortName = (setting: AgentSetting, index: number): string =>
  setting.choices.length > 1 && index === setting.choices.length - 1
    ? "UltraMoon"
    : (setting.choices[index]?.name ?? "");

/**
 * The reasoning effort `agent` offers for `model`, and the level `settings` set: the agent's own
 * while none is set, or one it no longer offers.
 */
export function effortOf(
  agent: AgentInfo | undefined,
  model: string | undefined,
  settings: Record<string, string> | undefined,
): { setting: AgentSetting; value: string; name: string } | undefined {
  const setting = agentSettingsFor(agent, model).find((s) => s.kind === "effort");
  if (!setting || !setting.choices.length) return undefined;
  const picked = settings?.[setting.id];
  const value = picked && setting.choices.some((c) => c.id === picked) ? picked : setting.current;
  const index = setting.choices.findIndex((c) => c.id === value);
  return { setting, value, name: index >= 0 ? effortName(setting, index) : "" };
}
