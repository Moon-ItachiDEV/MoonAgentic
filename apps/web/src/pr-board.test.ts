import type { PullRequestInfo, Thread, ThreadPullRequest } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import { canMerge, fixCiRequest, prBoard, prKind, prSteps } from "./pr-board.ts";

const pr = (number: number, patch: Partial<ThreadPullRequest> = {}): ThreadPullRequest => ({
  url: `https://github.com/o/r/pull/${number}`,
  number,
  state: "open",
  checks: "passed",
  ...patch,
});
const thread = (id: string, p?: ThreadPullRequest, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p",
  title: id,
  agentId: "demo",
  status: "idle",
  permissionMode: "supervised",
  createdAt: 0,
  updatedAt: 0,
  ...(p ? { pr: p } : {}),
  ...patch,
});
const info = (patch: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repo: "o/r",
  number: 9,
  url: "https://github.com/o/r/pull/9",
  title: "Une PR",
  state: "open",
  head: "claude/x",
  base: "main",
  conflicts: false,
  blocked: false,
  checks: [],
  ...patch,
});

describe("prKind", () => {
  it("puts a red CI before a conflict, and a draft apart", () => {
    expect(prKind(pr(1, { checks: "failed", conflicts: true }))).toBe("failed");
    expect(prKind(pr(1, { conflicts: true }))).toBe("conflict");
    expect(prKind(pr(1, { checks: "pending" }))).toBe("pending");
    expect(prKind(pr(1, { state: "draft", checks: "failed" }))).toBe("draft");
    expect(prKind(pr(1, { checks: "none" }))).toBe("ready");
  });
});

describe("prBoard", () => {
  it("lists what needs the user first and numbers ready ones oldest first", () => {
    const board = prBoard([
      thread("r2", pr(14)),
      thread("ci", pr(9, { checks: "failed" })),
      thread("r1", pr(12)),
      thread("cf", pr(7, { conflicts: true }), {
        workspace: { path: "/w", branch: "b", baseBranch: "develop" } as Thread["workspace"],
      }),
      thread("none"),
    ]);
    expect(board.rows.map((r) => r.thread.id)).toEqual(["ci", "cf", "r1", "r2"]);
    expect(board.rows.map((r) => r.order)).toEqual([undefined, undefined, 1, 2]);
    expect(board.rows[1]!.note).toBe("Conflits avec develop");
    expect(board.rows[2]!.note).toBe("En 1ʳᵉ · prête à fusionner");
    expect([board.red, board.green]).toEqual([2, 2]);
  });

  it("shows a team's pull request once and counts only today's merges", () => {
    const now = new Date(2026, 10, 23, 15).getTime();
    const board = prBoard(
      [
        thread("lead", pr(5)),
        thread("member", pr(5)),
        thread("old", pr(3, { state: "merged" }), { updatedAt: now - 2 * 86_400_000 }),
        thread("new", pr(4, { state: "merged" }), { updatedAt: now - 1000 }),
      ],
      now,
    );
    expect(board.rows).toHaveLength(1);
    expect(board.merged.map((t) => t.id)).toEqual(["new"]);
  });
});

describe("prSteps", () => {
  it("draws the checks, the conflicts and the merge that waits for the user", () => {
    const steps = prSteps(
      info({
        checks: [
          { name: "lint", state: "passed" },
          { name: "tests", state: "failed", url: "https://github.com/o/r/runs/1" },
          { name: "docs", state: "skipped" },
        ],
      }),
    );
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["lint", "done"],
      ["tests", "failed"],
      ["Pas de conflit avec main", "done"],
      ["Fusion dans main", "yours"],
    ]);
    expect(steps[1]!.tag?.text).toBe("Échec");
  });

  it("ends on the merge once merged", () => {
    expect(prSteps(info({ state: "merged" })).at(-1)).toMatchObject({
      label: "Fusionnée dans main",
      state: "done",
    });
  });
});

describe("canMerge", () => {
  it("only when GitHub says nothing holds it back", () => {
    expect(canMerge(info({ checks: [{ name: "ci", state: "passed" }] }))).toBe(true);
    expect(canMerge(info({ checks: [{ name: "ci", state: "pending" }] }))).toBe(false);
    expect(canMerge(info({ conflicts: true }))).toBe(false);
    expect(canMerge(info({ state: "draft" }))).toBe(false);
  });
});

describe("fixCiRequest", () => {
  it("names the checks that failed", () => {
    expect(fixCiRequest(info({ checks: [{ name: "tests", state: "failed" }] }))).toContain(
      "#9 est rouge : tests.",
    );
  });
});
