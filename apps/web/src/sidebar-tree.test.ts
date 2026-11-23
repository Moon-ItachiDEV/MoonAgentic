import type { Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  childrenOf,
  conversationsByProject,
  lineStatus,
  projectOpen,
  teamOpen,
} from "./sidebar-tree.ts";

let at = 0;
const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, title: id, projectId: "p", status: "idle", createdAt: at++, ...extra }) as Thread;

describe("lineStatus", () => {
  it("shows a folded team at work or waiting through its members", () => {
    const lead = thread("lead");
    expect(lineStatus(lead, [thread("c1"), thread("c2", { status: "running" })])).toBe("running");
    expect(
      lineStatus(lead, [thread("c1", { status: "running" }), thread("r", { status: "waiting" })]),
    ).toBe("waiting");
    expect(lineStatus(lead, [thread("c1", { status: "error" })])).toBe("error");
    expect(lineStatus(lead, [thread("c1")])).toBeUndefined();
  });

  it("keeps a running team at work between two of its agents", () => {
    const team = { phase: "coding" } as Team;
    expect(lineStatus(thread("lead", { team }), [thread("c1")])).toBe("running");
    expect(lineStatus(thread("lead", { team: { ...team, phase: "done" } }))).toBeUndefined();
  });
});

describe("conversationsByProject", () => {
  it("counts a team once, and a member whose lead is gone on its own", () => {
    const threads = [
      thread("lead"),
      thread("c1", { parentId: "lead" }),
      thread("r1", { parentId: "lead", role: "reviewer" }),
      thread("solo"),
      thread("orphan", { parentId: "deleted" }),
      thread("other", { projectId: "q" }),
    ];
    const byProject = conversationsByProject(threads);
    expect(byProject.get("p")?.map((t) => t.id)).toEqual(["lead", "solo", "orphan"]);
    expect(byProject.get("q")?.map((t) => t.id)).toEqual(["other"]);
    expect(
      childrenOf(threads)
        .get("lead")
        ?.map((t) => t.id),
    ).toEqual(["c1", "r1"]);
  });
});

describe("projectOpen", () => {
  it("unfolds the only project, and keeps the user's choice", () => {
    expect(projectOpen(undefined, true)).toBe(true);
    expect(projectOpen(undefined, false)).toBe(false);
    expect(projectOpen(false, true)).toBe(false);
    expect(projectOpen(true, false)).toBe(true);
  });
});

describe("teamOpen", () => {
  it("unfolds the active team unless folded during this visit, and folds back on leave", () => {
    const empty = new Set<string>();
    expect(teamOpen("lead", true, empty, empty)).toBe(true);
    expect(teamOpen("lead", true, empty, new Set(["lead"]))).toBe(false);
    // Leaving the team folds it back when the user did not manually unfold it.
    expect(teamOpen("lead", false, empty, empty)).toBe(false);
    // A team explicitly unfolded while inactive stays open.
    expect(teamOpen("lead", false, new Set(["lead"]), empty)).toBe(true);
    // Folding an active team still wins even if it had been unfolded beforehand.
    expect(teamOpen("lead", true, new Set(["lead"]), new Set(["lead"]))).toBe(false);
  });
});
