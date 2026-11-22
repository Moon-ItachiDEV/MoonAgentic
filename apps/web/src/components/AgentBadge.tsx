import type { AgentInfo } from "@moonagentic/protocol";
import { agentLogo } from "../agent-logos.ts";

export function AgentBadge({
  agent,
  small,
}: {
  agent: Pick<AgentInfo, "id" | "short"> | undefined;
  small?: boolean;
}) {
  const logo = agentLogo(agent?.id);
  return (
    <span className={`ag${small ? " sm" : ""}${logo ? " logo" : ""}`} data-agent={agent?.id}>
      {logo ? <img src={logo} alt="" draggable={false} /> : (agent?.short ?? "?")}
    </span>
  );
}
