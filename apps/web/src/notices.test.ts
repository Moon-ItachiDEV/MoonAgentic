import type { Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { noticesFor, settledTags } from "@moonagentic/protocol";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "Corrige le README",
  agentId: "demo",
  status: "running",
  permissionMode: "supervised",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const team = (phase: Team["phase"]) => ({ phase, task: "x", tasks: [] }) as unknown as Team;

describe("what is worth a notification", () => {
  it("tells when a thread starts waiting for an answer, once", () => {
    const waiting = thread({ status: "waiting" });
    expect(noticesFor([thread()], [waiting])).toEqual([
      { tag: "t1:waiting", threadId: "t1", title: "Attend ta réponse", body: "Corrige le README" },
    ]);
    expect(noticesFor([waiting], [{ ...waiting, updatedAt: 2 }])).toEqual([]);
    expect(noticesFor([waiting], [thread({ status: "idle" })])).toEqual([]);
  });

  it("says nothing of a thread seen for the first time, nor of an archived one", () => {
    expect(noticesFor([], [thread({ status: "waiting" })])).toEqual([]);
    expect(noticesFor([thread()], [thread({ status: "waiting", archived: true })])).toEqual([]);
  });

  it("tells when a team finishes, fails or is stuck, not each step on the way", () => {
    const of = (from: Team["phase"], to: Team["phase"]) =>
      noticesFor([thread({ team: team(from) })], [thread({ team: team(to) })]).map((n) => n.title);
    expect(of("planning", "coding")).toEqual([]);
    expect(of("coding", "merging")).toEqual([]);
    expect(of("merging", "done")).toEqual(["Équipe terminée"]);
    expect(of("coding", "failed")).toEqual(["Équipe en échec"]);
    expect(of("coding", "blocked")).toEqual(["Équipe bloquée : à toi de décider"]);
    expect(of("done", "done")).toEqual([]);
    expect(of("coding", "stopped")).toEqual([]);
  });

  it("tells both when a team's lead waits as its team ends", () => {
    const tags = noticesFor(
      [thread({ team: team("coding") })],
      [thread({ status: "waiting", team: team("failed") })],
    ).map((n) => n.tag);
    expect(tags).toEqual(["t1:waiting", "t1:team"]);
  });

  it("takes the notice back once the thread no longer waits", () => {
    const waiting = thread({ status: "waiting" });
    expect(settledTags([waiting], [thread({ status: "running" })])).toEqual(["t1:waiting"]);
    expect(settledTags([waiting], [thread({ status: "waiting", archived: true })])).toEqual([
      "t1:waiting",
    ]);
    expect(settledTags([waiting], [])).toEqual(["t1:waiting"]);
    expect(settledTags([waiting], [waiting])).toEqual([]);
    expect(settledTags([thread()], [thread({ status: "idle" })])).toEqual([]);
  });
});
