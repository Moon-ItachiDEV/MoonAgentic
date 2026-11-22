import type { AgentInfo } from "@moonagentic/protocol";

export function AgentBadge({
  agent,
  small,
}: {
  agent: Pick<AgentInfo, "id" | "short"> | undefined;
  small?: boolean;
}) {
  return (
    <span className={`ag${small ? " sm" : ""}`} data-agent={agent?.id}>
      {agent?.short ?? "?"}
    </span>
  );
}
