import type { Team, Thread } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { homeCards } from "./components/HomeCards.tsx";

const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({
    id,
    projectId: "p",
    title: id,
    agentId: "claude",
    status: "idle",
    permissionMode: "supervised",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Thread;

describe("homeCards", () => {
  it("shows only live conversations, newest first", () => {
    const cards = homeCards({
      threads: [
        thread("calme"),
        thread("travaille", { status: "running", updatedAt: 1 }),
        thread("attend", { status: "waiting", updatedAt: 2 }),
        thread("archivé", { status: "running", archived: true, updatedAt: 3 }),
      ],
      reviews: {},
    });
    expect(cards.map((c) => [c.thread.id, c.sub])).toEqual([
      ["attend", "Attend ta réponse"],
      ["travaille", "Au travail"],
    ]);
  });

  it("counts a team's pieces as they really are", () => {
    const team = {
      phase: "coding",
      task: "t",
      coder: { agentId: "codex" },
      reviewer: { agentId: "agy" },
      coders: 2,
      permissionMode: "full",
      tasks: [
        { title: "a", brief: "", status: "done" },
        { title: "b", brief: "", status: "running" },
        { title: "c", brief: "", status: "waiting" },
      ],
    } as Team;
    const [card] = homeCards({ threads: [thread("équipe", { team })], reviews: {} });
    expect(card?.sub).toBe("1 agent au travail · 1 sur 3 terminés");
    expect(card?.pieces).toEqual(["done", "busy", "todo"]);
    expect(card?.agentIds).toEqual(["claude", "codex", "agy"]);
  });

  it("shows changes waiting for review, with their count", () => {
    const [card] = homeCards({
      threads: [thread("revue", { workspace: { branch: "b" } as Thread["workspace"] })],
      reviews: { revue: { files: [{}, {}] } as never },
    });
    expect(card?.sub).toBe("À revoir · 2 fichiers");
  });
});

describe("codeThread", () => {
  it("opens your latest conversation with a branch before a team member's", async () => {
    const { codeThread } = await import("./components/TabBar.tsx");
    const ws = { branch: "b" } as Thread["workspace"];
    expect(
      codeThread({
        threads: [
          thread("membre", { workspace: ws, parentId: "chef", updatedAt: 5 }),
          thread("à moi", { workspace: ws, updatedAt: 2 }),
          thread("sans branche", { updatedAt: 9 }),
        ],
      })?.id,
    ).toBe("à moi");
  });
});
