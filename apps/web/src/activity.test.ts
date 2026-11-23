import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  activityFeed,
  activityGlyph,
  activityLabel,
  activitySteps,
  isPlanModeSwitch,
} from "./activity.ts";

const user = (id: string): Item => ({ id, kind: "user", text: id, at: 0 });
const agent = (id: string): Item => ({ id, kind: "agent", text: id, at: 0 });
const thought = (id: string): Item => ({ id, kind: "thought", text: id, at: 0 });
const tool = (
  id: string,
  extra: { title?: string; toolKind?: string; status?: "completed" | "failed" } = {},
  questions = false,
): Item => ({
  id,
  kind: "tool",
  title: extra.title ?? id,
  toolKind: extra.toolKind ?? "read",
  status: extra.status ?? "completed",
  content: [],
  ...(questions ? { questions: [{ question: "?", options: ["a"] }] } : {}),
  at: 0,
});
const permission = (id: string, outcome: string | null): Item => ({
  id,
  kind: "permission",
  title: id,
  options: [],
  outcome,
  at: 0,
});

describe("activityFeed", () => {
  it("folds a turn's thoughts, tools and words on the way into one line before its answer", () => {
    const items = [
      user("ask"),
      thought("t1"),
      tool("read"),
      agent("on the way"),
      tool("edit"),
      permission("allowed", "allow"),
      agent("answer"),
    ];
    expect(activityFeed(items)).toEqual([
      { kind: "item", index: 0 },
      { kind: "detail", key: "t1", indices: [1, 2, 3, 4, 5] },
      { kind: "item", index: 6 },
    ]);
  });

  it("keeps in sight what waits on the user, and each turn apart", () => {
    const items = [
      user("a"),
      tool("r1"),
      permission("ok?", null),
      tool("q", {}, true),
      user("b"),
      tool("r2"),
    ];
    expect(activityFeed(items)).toEqual([
      { kind: "item", index: 0 },
      { kind: "detail", key: "r1", indices: [1] },
      { kind: "item", index: 2 },
      { kind: "item", index: 3 },
      { kind: "item", index: 4 },
      { kind: "detail", key: "r2", indices: [5] },
    ]);
  });

  it("leaves out Antigravity's switches in and out of plan mode", () => {
    const items = [
      user("a"),
      tool("p1", { title: "Run exit_plan_mode", toolKind: "other" }),
      tool("r"),
      tool("p2", { title: "Run enter_plan_mode", toolKind: "other" }),
      agent("done"),
    ];
    expect(isPlanModeSwitch(items[1])).toBe(true);
    expect(activityFeed(items)).toEqual([
      { kind: "item", index: 0 },
      { kind: "detail", key: "r", indices: [2] },
      { kind: "item", index: 4 },
    ]);
  });
});

describe("activityLabel", () => {
  it("says what the agent does from its real step, with the file's name only", () => {
    expect(
      activityLabel(
        tool("x", { title: "File /C:/Users/a/code/MoonAgentic/apps/server/src/session.ts" }),
      ),
    ).toBe("Lit session.ts…");
    expect(activityLabel(tool("x", { title: "Edit `src/App.tsx`", toolKind: "edit" }))).toBe(
      "Modifie App.tsx…",
    );
    expect(activityLabel(tool("x", { title: "pnpm test", toolKind: "execute" }))).toBe(
      "Lance les tests…",
    );
    expect(activityLabel(tool("x", { title: "git status", toolKind: "execute" }))).toBe(
      "Lance une commande…",
    );
    expect(activityLabel(tool("x", { title: "grep foo", toolKind: "search" }))).toBe(
      "Cherche dans le code…",
    );
    expect(activityLabel(thought("t"))).toBe("Réfléchit…");
    expect(activityLabel(agent("a"))).toBe("Écrit…");
    expect(activityLabel(undefined)).toBe("Travaille…");
  });

  it("counts the steps of a stretch and those that failed", () => {
    const items = [tool("a"), thought("t"), tool("b", { status: "failed" })];
    expect(activitySteps(items, [0, 1, 2])).toEqual({ steps: 2, failed: 1 });
  });
});

describe("activityGlyph", () => {
  it("draws what the agent really does", () => {
    expect(activityGlyph(undefined)).toBe("demarre");
    expect(activityGlyph(user("u"))).toBe("demarre");
    expect(activityGlyph(thought("t"))).toBe("pense");
    expect(activityGlyph(agent("a"))).toBe("ecrit");
    expect(activityGlyph(tool("r", { toolKind: "read" }))).toBe("lit");
    expect(activityGlyph(tool("e", { toolKind: "edit" }))).toBe("modifie");
    expect(activityGlyph(tool("m", { toolKind: "move" }))).toBe("modifie");
    expect(activityGlyph(tool("s", { toolKind: "search" }))).toBe("cherche");
    expect(activityGlyph(tool("x", { toolKind: "execute", title: "pnpm lint" }))).toBe("commande");
    expect(activityGlyph(tool("x", { toolKind: "execute", title: "pnpm test" }))).toBe("tests");
    expect(activityGlyph(tool("f", { toolKind: "fetch" }))).toBe("web");
    expect(activityGlyph(tool("o", { toolKind: "other" }))).toBe("travaille");
  });

  it("shows a wait for the person apart from work", () => {
    expect(activityGlyph(permission("p", null))).toBe("attend");
    expect(activityGlyph(permission("p", "allow_once"))).toBe("travaille");
    expect(activityGlyph(tool("q", {}, true))).toBe("attend");
  });
});
