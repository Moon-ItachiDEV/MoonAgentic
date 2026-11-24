import type { AppInfo, AppUpdate } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  formatSize,
  installSteps,
  pillOf,
  updateNotice,
  updateShown,
  workingLine,
} from "./app-update.ts";

const app = (update: AppUpdate, over: Partial<AppInfo> = {}): AppInfo => ({
  kind: "windows",
  version: "0.1.5",
  checks: true,
  notify: true,
  update,
  ...over,
});

describe("the update pill", () => {
  it("shows only when there is something to say", () => {
    expect(updateShown(null)).toBe(false);
    expect(updateShown(app({ state: "none" }))).toBe(false);
    expect(updateShown(app({ state: "checking" }))).toBe(false);
    expect(updateShown(app({ state: "failed" }))).toBe(false);
    expect(updateShown(app({ state: "failed", version: "0.1.6" }))).toBe(true);
    expect(updateShown(app({ state: "ready", version: "0.1.6" }))).toBe(true);
    expect(updateShown(app({ state: "ready", version: "0.1.6" }, { kind: "other" }))).toBe(false);
  });

  it("says where the update stands", () => {
    expect(pillOf(app({ state: "ready", version: "0.1.6" }))).toEqual({
      text: "Mise à jour 0.1.6",
      tail: "Prête",
      tone: "ready",
    });
    expect(pillOf(app({ state: "downloading", version: "0.1.6", progress: 0.42 })).tail).toBe(
      "42 %",
    );
    expect(
      pillOf(
        app({
          state: "ready",
          version: "0.1.6",
          install: { when: "idle", at: 0, by: "x" },
          working: 2,
        }),
      ),
    ).toMatchObject({ tail: "Attend 2 fils", tone: "wait" });
    expect(pillOf(app({ state: "ready", version: "0.1.6", phase: "backup" })).tone).toBe("run");
    expect(pillOf(app({ state: "available", version: "abc", behind: 1 }, { kind: "git" }))).toEqual(
      {
        text: "Nouvelle version",
        tail: "1 commit",
        tone: "ready",
      },
    );
    expect(pillOf(app({ state: "available", version: "0.1.6" }, { kind: "mac" })).tail).toBe(
      "Sortie",
    );
  });

  it("counts the threads at work without naming one", () => {
    expect(workingLine(1)).toBe("1 fil au travail");
    expect(workingLine(3)).toBe("3 fils au travail");
  });

  it("writes sizes as the user reads them", () => {
    expect(formatSize(88_000_000)).toBe("84 Mo");
    expect(formatSize(2 * 1024 ** 3)).toBe("2,0 Go");
    expect(formatSize(10)).toBe("1 Ko");
  });
});

describe("the steps of an install", () => {
  const states = (u: AppUpdate, connected = true) =>
    installSteps(u, connected).map((s) => `${s.key}:${s.state}`);

  it("follows the install from the threads to the restart", () => {
    const waiting: AppUpdate = {
      state: "ready",
      install: { when: "idle", at: 0, by: "x" },
      working: 1,
    };
    expect(states(waiting)).toEqual(["threads:now", "backup:next", "install:next", "restart:next"]);
    expect(installSteps(waiting, true)[0]!.label).toBe("1 fil au travail");
    expect(states({ state: "ready", phase: "backup" })).toEqual([
      "threads:done",
      "backup:now",
      "install:next",
      "restart:next",
    ]);
    expect(states({ state: "ready", phase: "installing" })).toEqual([
      "threads:done",
      "backup:done",
      "install:now",
      "restart:next",
    ]);
    expect(states({ state: "ready", phase: "installing" }, false)).toEqual([
      "threads:done",
      "backup:done",
      "install:done",
      "restart:now",
    ]);
  });
});

describe("the notice of a version ready", () => {
  it("is told once per version and device", () => {
    const a = app({ state: "ready", version: "0.1.6" });
    expect(updateNotice(a, null)).toMatchObject({
      tag: "app-update",
      threadId: "",
      title: "Mise à jour 0.1.6 prête",
    });
    expect(updateNotice(a, "0.1.6")).toBeUndefined();
    expect(updateNotice({ ...a, notify: false }, null)).toBeUndefined();
    expect(updateNotice(app({ state: "downloading", version: "0.1.6" }), null)).toBeUndefined();
  });
});
