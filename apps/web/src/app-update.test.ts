import type { AppInfo, AppUpdate } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  announceDelay,
  announceDue,
  capsuleOf,
  cardState,
  downloadPace,
  etaLabel,
  formatSize,
  glideStep,
  installMemo,
  installSteps,
  litPath,
  lookFailure,
  memoFate,
  pillOf,
  readMemo,
  stopwatch,
  updateNotice,
  updateShown,
  versionRoll,
  watchInstall,
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
    expect(updateNotice(app({ state: "available", version: "0.1.6" }), null)).toBeUndefined();
    expect(
      updateNotice(app({ state: "available", version: "0.1.6" }, { kind: "mac" }), null),
    ).toMatchObject({ title: "Mise à jour 0.1.6 prête" });
  });
});

describe("an install seen from one screen", () => {
  const follow = (steps: [AppUpdate["phase"], boolean][]) => {
    let watch = { saw: false, lost: false };
    const reloads: boolean[] = [];
    for (const [phase, connected] of steps) {
      const next = watchInstall(watch, phase, connected);
      watch = next.watch;
      reloads.push(next.reload);
    }
    return reloads;
  };

  it("loads the new build once the server is back", () => {
    expect(
      follow([
        [undefined, true],
        ["backup", true],
        ["installing", true],
        ["installing", false],
        [undefined, true],
      ]),
    ).toEqual([false, false, false, false, true]);
  });

  it("also when the phone lost the server during the copy of the base", () => {
    expect(
      follow([
        ["backup", true],
        ["backup", false],
        [undefined, true],
      ]),
    ).toEqual([false, false, true]);
  });

  it("forgets an install that never replaced anything", () => {
    // The copy failed: the server never went away.
    expect(
      follow([
        ["backup", true],
        [undefined, true],
        [undefined, false],
        [undefined, true],
      ]),
    ).toEqual([false, false, false, false]);
  });
});

describe("a look that failed before finding a version", () => {
  it("is said in the settings", () => {
    expect(lookFailure(app({ state: "failed", error: "GitHub a répondu 403." }))).toBe(
      "Vérification impossible : GitHub a répondu 403.",
    );
    expect(lookFailure(app({ state: "failed", version: "0.1.6", error: "x" }))).toBeUndefined();
    expect(lookFailure(app({ state: "none" }))).toBeUndefined();
    expect(lookFailure(app({ state: "failed", error: "x" }, { kind: "other" }))).toBeUndefined();
  });
});

describe("the card of an update", () => {
  it("takes one look per state", () => {
    expect(cardState(app({ state: "ready", version: "0.1.6" }))).toBe("ready");
    expect(cardState(app({ state: "downloading", version: "0.1.6", progress: 0.2 }))).toBe(
      "downloading",
    );
    const install = { when: "idle" as const, at: 1, by: "depuis iPhone" };
    expect(cardState(app({ state: "ready", version: "0.1.6", install, working: 2 }))).toBe(
      "waiting",
    );
    expect(cardState(app({ state: "ready", version: "0.1.6", install, phase: "backup" }))).toBe(
      "installing",
    );
    expect(cardState(app({ state: "failed", version: "0.1.6", error: "coupé" }))).toBe("failed");
    expect(cardState(app({ state: "available", version: "abc", behind: 2 }, { kind: "git" }))).toBe(
      "git",
    );
    expect(cardState(app({ state: "available", version: "0.1.6" }, { kind: "mac" }))).toBe("mac");
  });

  it("rolls the one number that changes", () => {
    expect(versionRoll("0.1.15", "0.1.16")).toEqual({
      head: "0.1.",
      was: "15",
      now: "16",
      tail: "",
    });
    expect(versionRoll("0.1.15", "0.2.0")).toEqual({ head: "0.", was: "1", now: "2", tail: ".0" });
    expect(versionRoll("0.9.3", "1.0.0")).toEqual({ head: "", was: "0", now: "1", tail: ".0.0" });
    // Nothing to roll: the same version, a commit, a version cut otherwise.
    expect(versionRoll("0.1.16", "0.1.16")).toBeUndefined();
    expect(versionRoll("0.1.15", "a1b2c3d")).toBeUndefined();
    expect(versionRoll("0.1", "0.1.16")).toBeUndefined();
    expect(versionRoll("0.1.x", "0.1.16")).toBeUndefined();
  });

  it("lights the moon by the share downloaded, exact in area", () => {
    expect(litPath(0)).toBe("");
    expect(litPath(-1)).toBe("");
    // Half: the right limb closed by a straight terminator.
    expect(litPath(0.5)).toMatch(/^M24 9A15 15 0 0 1 24 39A0\.00 15 0 0 [01] 24 9Z$/);
    // A crescent bulges towards the limb, a gibbous moon away from it.
    expect(litPath(0.25)).toBe("M24 9A15 15 0 0 1 24 39A7.50 15 0 0 0 24 9Z");
    expect(litPath(0.75)).toBe("M24 9A15 15 0 0 1 24 39A7.50 15 0 0 1 24 9Z");
    // Full, and beyond: the whole disc.
    expect(litPath(1)).toBe("M24 9A15 15 0 1 1 24 39A15 15 0 1 1 24 9Z");
    expect(litPath(3)).toBe(litPath(1));
  });

  it("says what is left only from a pace that was measured", () => {
    expect(etaLabel(0.5, 0)).toBe("");
    expect(etaLabel(0.5, Number.NaN)).toBe("");
    expect(etaLabel(1, 0.1)).toBe("");
    expect(etaLabel(0.5, 0.025)).toBe("≈ 20 s");
    expect(etaLabel(0.99, 0.5)).toBe("≈ 1 s");
    expect(etaLabel(0.1, 0.005)).toBe("≈ 3 min");
    expect(stopwatch(0)).toBe("0:00");
    expect(stopwatch(7_400)).toBe("0:07");
    expect(stopwatch(83_000)).toBe("1:23");
    expect(stopwatch(-5)).toBe("0:00");
  });
});

describe("the capsule of an update", () => {
  it("says in two lines what it announces", () => {
    expect(capsuleOf(app({ state: "ready", version: "0.1.6" }))).toEqual({
      title: "Version 0.1.6",
      sub: "Prête",
      tone: "ready",
    });
    expect(capsuleOf(app({ state: "downloading", version: "0.1.6", progress: 0.42 }))).toEqual({
      title: "Téléchargement",
      sub: "42 %",
      tone: "run",
    });
    const install = { when: "idle" as const, at: 1, by: "depuis iPhone" };
    expect(capsuleOf(app({ state: "ready", version: "0.1.6", install, working: 2 }))).toEqual({
      title: "0.1.6 en attente",
      sub: "2 fils au travail",
      tone: "wait",
    });
    expect(capsuleOf(app({ state: "failed", version: "0.1.6" })).tone).toBe("fail");
    expect(
      capsuleOf(app({ state: "available", version: "abc", behind: 1 }, { kind: "git" })),
    ).toEqual({ title: "Nouvelle version", sub: "1 commit", tone: "ready" });
    expect(capsuleOf(app({ state: "available", version: "0.1.6" }, { kind: "mac" })).sub).toBe(
      "Sortie",
    );
  });

  it("announces a version once per device, and only once it is ready", () => {
    const ready = app({ state: "ready", version: "0.1.6" });
    expect(announceDue(ready, null)).toBe("0.1.6");
    expect(announceDue(ready, "0.1.5")).toBe("0.1.6");
    expect(announceDue(ready, "0.1.6")).toBeUndefined();
    expect(announceDue(null, null)).toBeUndefined();
    // Not while it downloads, nor once the install is asked or under way.
    expect(
      announceDue(app({ state: "downloading", version: "0.1.6", progress: 0.9 }), null),
    ).toBeUndefined();
    const install = { when: "idle" as const, at: 1, by: "depuis iPhone" };
    expect(announceDue(app({ state: "ready", version: "0.1.6", install }), null)).toBeUndefined();
    expect(
      announceDue(app({ state: "ready", version: "0.1.6", install, phase: "installing" }), null),
    ).toBeUndefined();
    // A clone and a Mac have nothing downloaded: a version found is what they announce.
    expect(
      announceDue(app({ state: "available", version: "abc", behind: 2 }, { kind: "git" }), null),
    ).toBe("abc");
    expect(announceDue(app({ state: "available", version: "0.1.6" }, { kind: "mac" }), null)).toBe(
      "0.1.6",
    );
    expect(announceDue(app({ state: "available", version: "0.1.6" }), null)).toBeUndefined();
    expect(
      announceDue(app({ state: "ready", version: "0.1.6" }, { kind: "other" }), null),
    ).toBeUndefined();
  });
});

describe("what a screen keeps of an install", () => {
  const install = { when: "now" as const, at: 1, by: "sur cet ordinateur" };
  const notes = [{ title: "Une carte", number: 12 }, { title: "Sans numéro" }];
  const memo = { version: "0.1.6", from: "0.1.5", notes };

  it("is written when the install begins, not before", () => {
    expect(installMemo(app({ state: "ready", version: "0.1.6", notes, install }))).toBeUndefined();
    expect(
      installMemo(app({ state: "ready", version: "0.1.6", notes, install, phase: "backup" })),
    ).toEqual(memo);
  });

  it("is read back whole, or not at all", () => {
    expect(readMemo(JSON.stringify(memo))).toEqual(memo);
    expect(readMemo(null)).toBeUndefined();
    expect(readMemo("")).toBeUndefined();
    expect(readMemo("{")).toBeUndefined();
    expect(readMemo(JSON.stringify({ version: "0.1.6" }))).toBeUndefined();
    expect(
      readMemo(JSON.stringify({ ...memo, notes: [null, { title: 3 }, { title: "Gardée" }] }))
        ?.notes,
    ).toEqual([{ title: "Gardée" }]);
  });

  it("is shown once the server runs that version, and dropped when it does not", () => {
    const before = app({ state: "ready", version: "0.1.6", install, phase: "installing" });
    const after = app({ state: "none" }, { version: "0.1.6" });
    expect(memoFate(undefined, after, true)).toBe("none");
    // Still under way, or the server is not heard: nothing is concluded.
    expect(memoFate(memo, before, true)).toBe("keep");
    expect(memoFate(memo, null, false)).toBe("keep");
    expect(memoFate(memo, after, false)).toBe("keep");
    expect(memoFate(memo, after, true)).toBe("show");
    // The install did not go: the server still runs the version of before.
    expect(memoFate(memo, app({ state: "ready", version: "0.1.6" }), true)).toBe("drop");
  });
});

describe("what Neon's review of the card found", () => {
  it("measures a download anew when it starts again from lower", () => {
    const start = { at: 0, progress: 0, pace: 0 };
    // 10 % a second, then faster: smoothed, one fast packet does not promise the rest.
    const first = downloadPace(start, 0.1, 1000);
    expect(first).toEqual({ at: 1000, progress: 0.1, pace: 0.1 });
    const second = downloadPace(first, 0.5, 2000);
    expect(second.pace).toBeCloseTo(0.1 * 0.6 + 0.4 * 0.4);
    // The same figure told again changes nothing.
    expect(downloadPace(second, 0.5, 2500)).toBe(second);
    // Another version, or the download tried again: it starts from that figure, with no pace
    // kept from the first, instead of waiting to pass the 50 % of before.
    const again = downloadPace(second, 0.02, 3000);
    expect(again).toEqual({ at: 3000, progress: 0.02, pace: 0 });
    expect(etaLabel(0.02, again.pace)).toBe("");
    const then = downloadPace(again, 0.12, 5000);
    expect(then.pace).toBeCloseTo(0.05);
    expect(etaLabel(0.12, then.pace)).toBe("≈ 18 s");
  });

  it("leaves a moon already at its share alone, and brings another there", () => {
    // A full moon drawn full: nothing to glide, no frame to ask for.
    expect(glideStep(1, 1)).toBe(1);
    expect(glideStep(0.4, 0.4)).toBe(0.4);
    expect(glideStep(0.3995, 0.4)).toBe(0.4);
    // On its way: a part of the gap each frame, up or down, never past the figure.
    expect(glideStep(0, 1)).toBeCloseTo(0.09);
    expect(glideStep(1, 0)).toBeCloseTo(0.91);
    let shown = 0;
    let frames = 0;
    while (shown !== 0.42 && frames < 200) {
      shown = glideStep(shown, 0.42);
      expect(shown).toBeLessThanOrEqual(0.42);
      frames++;
    }
    expect(shown).toBe(0.42);
    expect(frames).toBeLessThan(80);
  });

  it("announces 100 ms after the moon's rise, whenever the wait is set again", () => {
    // The capsule just showed and its moon rises for 1.3 s.
    expect(announceDelay(true, 0)).toBe(1400);
    // Set again during the rise or as it ends: the same moment, not half a second more.
    expect(announceDelay(true, 900)).toBe(500);
    expect(announceDelay(true, 1300)).toBe(100);
    // No rise (another page was opened), or a version ready long after: the usual pause.
    expect(announceDelay(false, 0)).toBe(500);
    expect(announceDelay(true, 1400)).toBe(500);
    expect(announceDelay(true, 60_000)).toBe(500);
  });
});
