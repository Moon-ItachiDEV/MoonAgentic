import type { Item } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  activityFeed,
  activityGlyph,
  activityLabel,
  activitySteps,
  imageInProgress,
  imagesMarkdown,
  isImageGeneration,
  isPlanModeSwitch,
  unshownImages,
} from "./activity.ts";
import { Marked } from "marked";
import { localFiles, markedRef } from "./local-files.ts";

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

describe("tests commands", () => {
  it("knows the usual test runners", () => {
    for (const title of ["pnpm test", "npx vitest run", "pytest -q", "jest --ci", "cargo test"]) {
      expect(activityGlyph(tool("x", { toolKind: "execute", title }))).toBe("tests");
      expect(activityLabel(tool("x", { toolKind: "execute", title }))).toBe("Lance les tests…");
    }
    expect(activityGlyph(tool("x", { toolKind: "execute", title: "pnpm build" }))).toBe("commande");
  });
});

describe("image generation", () => {
  it("knows a tool that makes an image, and while its image is not there yet", () => {
    for (const title of ["generate_image", "Generate Image", "Générer une image", "image_gen"]) {
      expect(isImageGeneration(tool("i", { title })), title).toBe(true);
    }
    for (const title of ["Lire images/plan.png", "view_file image.png", "`pnpm test`"]) {
      expect(isImageGeneration(tool("i", { title })), title).toBe(false);
    }
    const running = { ...tool("i", { title: "generate_image" }), status: "in_progress" } as Item;
    expect(activityLabel(running)).toBe("Crée l'image…");
    expect(imageInProgress([thought("t"), running], [0, 1])).toBe(running);
    const done = tool("i", { title: "generate_image", status: "completed" });
    expect(imageInProgress([running, done], [0, 1])).toBeUndefined();
  });

  it("shows the image a tool made when no answer of the turn names it", () => {
    // Codex: the file is in the tool's result only, the answer says « Voici Naruto ».
    const saved = "C:\\Users\\BreezyHomeCinéma\\.codex\\generated_images\\019a\\ig_1.png";
    const made = (status: "completed" | "in_progress") =>
      ({ ...tool("i", { title: "Image generation" }), status, images: [saved] }) as Item;
    const turn = [user("u"), made("completed"), agent("Voici Naruto sur les toits.")];
    expect(unshownImages(turn, [1])).toEqual([saved]);
    // Not while it is being made, nor when the answer shows or links it, nor for a later turn.
    expect(unshownImages([user("u"), made("in_progress")], [1])).toEqual([]);
    expect(unshownImages([user("u"), made("completed"), agent(`![a](${saved})`)], [1])).toEqual([]);
    expect(
      unshownImages([user("u"), made("completed"), agent("Voici."), user("v"), agent(saved)], [1]),
    ).toEqual([saved]);
    // Written as an answer would, it reaches the server exactly as the tool gave it.
    const html = new Marked(localFiles).parse(imagesMarkdown([saved]), { async: false });
    const href = /<img src="([^"]+)"/.exec(html)?.[1];
    expect(markedRef(href!.replace(/&amp;/g, "&"))).toBe(saved);
  });
});
