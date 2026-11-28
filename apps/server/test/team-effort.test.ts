import type { Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it, vi } from "vitest";
import { type TeamHost, Teams } from "../src/team.ts";

/** A team on a fake hub that keeps what each of its threads was started with. */
function setup(roles: Partial<Parameters<Teams["start"]>[0]>) {
  const threads = new Map<string, Thread>();
  const replies = new Map<string, string>();
  const started: Parameters<TeamHost["createThread"]>[0][] = [];
  let seq = 0;
  const host = {
    thread: (id: string) => threads.get(id),
    threads: () => [...threads.values()],
    createThread: (input: Parameters<TeamHost["createThread"]>[0]) => {
      started.push(input);
      const id = `t${++seq}`;
      threads.set(id, {
        id,
        projectId: input.projectId,
        title: input.title,
        agentId: input.agentId,
        status: "running",
        permissionMode: input.permissionMode,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        role: input.role,
        ...(input.team ? { team: input.team } : {}),
        createdAt: 1,
        updatedAt: 1,
      });
      return id;
    },
    send: () => undefined,
    cancel: async () => undefined,
    setTeam: (threadId: string, team: Team) => {
      const existing = threads.get(threadId);
      if (existing) threads.set(threadId, { ...existing, team });
    },
    lastReply: (threadId: string) => replies.get(threadId) ?? "",
    changes: async () => ({ files: [] }),
    mergeInto: async () => [],
    ship: async () => ({ prOpened: false }),
    unfinishedMerge: async () => undefined,
    contains: async () => false,
  } satisfies TeamHost;
  const teams = new Teams(host);
  const leadId = teams.start({
    projectId: "p1",
    task: "Export CSV",
    lead: { agentId: "claude" },
    coder: { agentId: "claude" },
    coders: 1,
    permissionMode: "full",
    ...roles,
  });
  const team = () => threads.get(leadId)!.team!;
  const plan =
    "```json\n" +
    JSON.stringify({
      tasks: [
        { title: "Export", brief: "b" },
        { title: "Bouton", brief: "b" },
      ],
    }) +
    "\n```";
  const byRole = (role: string) => started.filter((s) => s.role === role);
  return { replies, teams, leadId, team, plan, byRole };
}

describe("each role of a team thinks as hard as it was set to", () => {
  it("starts the lead, the coders and the merge on their own reasoning level", async () => {
    const { replies, teams, leadId, team, plan, byRole } = setup({
      lead: { agentId: "claude", model: "fable", settings: { effort: "max" } },
      coder: { agentId: "claude", model: "opus", settings: { effort: "high" } },
      merger: { agentId: "claude", model: "haiku", settings: { effort: "low" } },
      coders: 2,
    });
    expect(byRole("lead")[0]).toMatchObject({ model: "fable", settings: { effort: "max" } });

    replies.set(leadId, plan);
    teams.turnEnded(leadId, false);
    expect(byRole("coder")[0]).toMatchObject({ model: "opus", settings: { effort: "high" } });

    // Two pieces done, their branches are merged by the merge's own agent.
    teams.turnEnded(team().tasks[0]!.threadId!, false);
    teams.turnEnded(team().tasks[1]!.threadId!, false);
    await vi.waitFor(() => expect(byRole("merger")).toHaveLength(1));
    expect(byRole("merger")[0]).toMatchObject({ model: "haiku", settings: { effort: "low" } });
  });

  it("starts the reviewer on its own level, and a role set to none on the agent's own", async () => {
    const { replies, teams, leadId, team, plan, byRole } = setup({
      reviewer: { agentId: "gemini", model: "neon", settings: { thinking: "high" } },
    });
    expect(byRole("lead")[0]).not.toHaveProperty("settings");

    replies.set(leadId, plan);
    teams.turnEnded(leadId, false);
    expect(byRole("coder")[0]).not.toHaveProperty("settings");

    teams.turnEnded(team().tasks[0]!.threadId!, false);
    await vi.waitFor(() => expect(byRole("reviewer")).toHaveLength(1));
    expect(byRole("reviewer")[0]).toMatchObject({
      agentId: "gemini",
      model: "neon",
      settings: { thinking: "high" },
    });
  });
});
