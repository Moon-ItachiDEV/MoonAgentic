import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppInfo, ServerMessage } from "@moonagentic/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppUpdates,
  type AppUpdatesOptions,
  type DesktopReport,
  gitNotes,
  gitSource,
  INSTALL_LIMIT_MS,
  readReport,
  type ToShell,
} from "../src/app-update.ts";
import { backupBeforeUpdate } from "../src/backups.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const folder = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const ready = (over: Partial<DesktopReport["update"]> = {}): unknown => ({
  moon: "desktop",
  desktop: {
    platform: "win32",
    version: "0.1.5",
    packaged: true,
    openAtLogin: true,
    update: { state: "ready", version: "0.1.6", size: 1000, checkedAt: 0, ...over },
  },
});

function setup(over: Partial<AppUpdatesOptions> = {}) {
  const settings = new Map<string, unknown>();
  const toShell: ToShell[] = [];
  const told: { title: string; body: string }[] = [];
  const backups: string[] = [];
  let listener: (message: unknown) => void = () => undefined;
  const sent: AppInfo[] = [];
  let working = 0;
  let paused = 0;
  let resumed = 0;
  let clock = 1_000;
  const app = new AppUpdates({
    settings: {
      getSetting: <T>(key: string, fallback: T) =>
        (settings.has(key) ? settings.get(key) : fallback) as T,
      setSetting: (key, value) => void settings.set(key, value),
    },
    broadcast: (m: ServerMessage) => {
      if (m.type === "app") sent.push(m.app);
    },
    working: () => working,
    backup: async (version) => void backups.push(version),
    notify: (title, body) => told.push({ title, body }),
    pause: () => paused++,
    resume: () => resumed++,
    shell: {
      send: (m) => toShell.push(m),
      onMessage: (l) => {
        listener = l;
      },
    },
    tickMs: 60_000,
    now: () => clock,
    ...over,
  });
  closers.push(() => app.close());
  return {
    app,
    toShell,
    told,
    backups,
    sent,
    settings,
    report: (m: unknown) => listener(m),
    setWorking: (n: number) => {
      working = n;
    },
    paused: () => paused,
    resumed: () => resumed,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => (app as unknown as { tick(): void }).tick(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("what the desktop app says", () => {
  it("keeps a report that is one, and only what it should", () => {
    const r = readReport({
      moon: "desktop",
      desktop: {
        platform: "win32",
        version: "0.1.5",
        packaged: true,
        update: {
          state: "available",
          url: "https://evil.example/",
          notes: [
            { title: "Une\nligne", number: 12 },
            { title: "" },
            { title: "Sans", number: -1 },
          ],
          progress: 3,
        },
      },
    });
    expect(r?.update).toEqual({
      state: "available",
      progress: 1,
      notes: [{ title: "Une", number: 12 }, { title: "Sans" }],
    });
    expect(
      readReport({ moon: "desktop", desktop: { platform: "win32", version: "1" } }),
    ).toBeUndefined();
    expect(readReport({ moon: "other" })).toBeUndefined();
    expect(readReport(ready({ state: "nope" as never }))).toBeUndefined();
  });

  it("reads the pull requests merged into main from git log", () => {
    const log = [
      "Merge pull request #130 from x/y\x1fDisque et gels\n\nplus\x1e",
      "\nCorrige une faute\x1f\x1e",
    ].join("");
    expect(gitNotes(log)).toEqual([
      { title: "Disque et gels", number: 130 },
      { title: "Corrige une faute" },
    ]);
  });
});

describe("AppUpdates", () => {
  it("says hello at start, and learns what the desktop app is", () => {
    const t = setup();
    expect(t.toShell).toEqual([{ moon: "hello" }]);
    expect(t.app.info().kind).toBe("other");
    t.report(ready());
    expect(t.app.info()).toMatchObject({
      kind: "windows",
      version: "0.1.5",
      openAtLogin: true,
      update: { state: "ready", version: "0.1.6" },
    });
    t.report({
      moon: "desktop",
      desktop: { platform: "darwin", version: "0.1.5", packaged: true, update: { state: "none" } },
    });
    expect(t.app.info().kind).toBe("mac");
  });

  it("tells every device once of a version ready, whatever the looks after", () => {
    const t = setup();
    t.report(ready());
    t.report(ready());
    expect(t.told).toEqual([
      { title: "Mise à jour 0.1.6 prête", body: "Touche pour choisir quand l'installer." },
    ]);
    t.report(ready({ version: "0.1.7" }));
    expect(t.told).toHaveLength(2);
  });

  it("does not notify Windows devices on state 'available' before the installer is ready", () => {
    const t = setup();
    t.report(ready({ state: "available", version: "0.1.6" }));
    expect(t.told).toEqual([]);
    t.report(ready({ state: "ready", version: "0.1.6" }));
    expect(t.told).toEqual([
      { title: "Mise à jour 0.1.6 prête", body: "Touche pour choisir quand l'installer." },
    ]);
  });

  it("tells nothing when the user said not to", () => {
    const t = setup();
    t.app.setSettings({ notify: false });
    t.report(ready());
    expect(t.told).toEqual([]);
  });

  it("waits for the threads at work, then copies the base, then asks to install", async () => {
    const t = setup();
    t.report(ready());
    t.setWorking(2);
    t.app.requestInstall("idle", "depuis iPhone");
    await flush();
    expect(t.app.info().update).toMatchObject({
      install: { when: "idle", by: "depuis iPhone" },
      working: 2,
    });
    expect(t.app.switching).toBe(false);
    expect(t.backups).toEqual([]);
    t.setWorking(1);
    t.tick();
    await flush();
    expect(t.app.info().update.working).toBe(1);
    t.setWorking(0);
    t.tick();
    expect(t.app.switching).toBe(true);
    expect(t.paused()).toBe(1);
    await flush();
    expect(t.backups).toEqual(["0.1.6"]);
    expect(t.app.info().update.phase).toBe("installing");
    expect(t.toShell.at(-1)).toEqual({ moon: "install" });
    // Nothing more can be asked once it has begun.
    expect(() => t.app.cancel()).toThrow(/déjà commencé/);
  });

  it("installs at once when asked, even with threads at work", async () => {
    const t = setup();
    t.report(ready());
    t.setWorking(3);
    t.app.requestInstall("now", "sur cet ordinateur");
    await flush();
    expect(t.toShell.at(-1)).toEqual({ moon: "install" });
  });

  it("can be called off while it waits", async () => {
    const t = setup();
    t.report(ready());
    t.setWorking(1);
    t.app.requestInstall("idle", "x");
    t.app.cancel();
    t.setWorking(0);
    t.tick();
    await flush();
    expect(t.app.info().update.install).toBeUndefined();
    expect(t.toShell).not.toContainEqual({ moon: "install" });
  });

  it("installs nothing without a version ready", () => {
    const t = setup();
    expect(() => t.app.requestInstall("now", "x")).toThrow(/Aucune version/);
    t.report(ready({ state: "available" }));
    expect(() => t.app.requestInstall("now", "x")).toThrow(/Aucune version/);
  });

  it("replaces nothing when the base could not be copied, and work starts again", async () => {
    const t = setup({
      backup: () => Promise.reject(new Error("disque plein")),
    });
    t.report(ready());
    t.app.requestInstall("now", "x");
    await flush();
    expect(t.toShell).not.toContainEqual({ moon: "install" });
    expect(t.app.switching).toBe(false);
    expect(t.resumed()).toBe(1);
    expect(t.app.info().update).toMatchObject({
      state: "ready",
      error: expect.stringMatching(/disque plein/),
    });
  });

  it("goes on when the desktop app could not start the installer", async () => {
    const t = setup();
    t.report(ready());
    t.app.requestInstall("now", "x");
    await flush();
    expect(t.app.switching).toBe(true);
    t.report(ready({ state: "failed", error: "L'installeur n'a pas démarré." }));
    expect(t.app.switching).toBe(false);
    expect(t.resumed()).toBe(1);
    expect(t.app.info().update).toMatchObject({
      state: "failed",
      error: "L'installeur n'a pas démarré.",
    });
  });

  it("starts work again when the desktop app never acts on « install » (N39)", async () => {
    const t = setup();
    t.report(ready());
    t.app.requestInstall("now", "x");
    await flush();
    await flush();
    expect(t.toShell.at(-1)).toEqual({ moon: "install" });
    t.advance(INSTALL_LIMIT_MS - 1_000);
    t.tick();
    expect(t.app.switching).toBe(true);
    t.advance(1_000);
    t.tick();
    expect(t.app.switching).toBe(false);
    expect(t.resumed()).toBe(1);
    expect(t.app.info().update.error).toMatch(/n'a pas lancé l'installation en 2 min/);
    // Nothing is asked again of its own: the user chooses when.
    await flush();
    expect(t.toShell.filter((m) => m.moon === "install")).toHaveLength(1);
  });

  it("asks for a look when one is due, not more often", () => {
    const t = setup({ everyMs: 1_000_000 });
    t.report(ready({ state: "none", checkedAt: 1_000 }));
    expect(t.toShell.filter((m) => m.moon === "check")).toHaveLength(0);
    t.advance(1_000_000);
    t.tick();
    expect(t.toShell.filter((m) => m.moon === "check")).toHaveLength(1);
    // Not answered yet: not asked again at once.
    t.tick();
    expect(t.toShell.filter((m) => m.moon === "check")).toHaveLength(1);
    t.app.setSettings({ checks: false });
    t.advance(60 * 60_000);
    t.tick();
    expect(t.toShell.filter((m) => m.moon === "check")).toHaveLength(1);
  });

  it("passes the start-up settings on to the desktop app", () => {
    const t = setup();
    expect(() => t.app.setSettings({ preventSleep: true })).toThrow(/app de bureau/);
    t.report(ready());
    t.app.setSettings({ preventSleep: true });
    expect(t.toShell.at(-1)).toEqual({ moon: "settings", preventSleep: true });
  });

  it("follows a clone's main branch", async () => {
    const t = setup({
      shell: undefined,
      git: {
        version: async () => "abc1234",
        check: async () => ({ version: "def5678", behind: 2, notes: [{ title: "X", number: 4 }] }),
      },
    });
    await flush();
    t.tick();
    await flush();
    expect(t.app.info()).toMatchObject({
      kind: "git",
      version: "abc1234",
      update: { state: "available", version: "def5678", behind: 2 },
    });
    expect(t.told[0]).toEqual({
      title: "Nouvelle version sur main",
      body: "2 commits à récupérer avec git pull.",
    });
    expect(() => t.app.requestInstall("now", "x")).toThrow(/Aucune version/);
  });
});

describe("a clone looked at with git", () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  it("counts the commits of main not here yet, and lists the pull requests merged", async () => {
    const origin = folder("moonagentic-origin-");
    run(origin, "init", "-q", "-b", "main");
    writeFileSync(path.join(origin, "a.txt"), "a");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "Début");
    const clone = path.join(folder("moonagentic-clone-"), "c");
    run(path.dirname(clone), "clone", "-q", origin, clone);
    run(origin, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(origin, "b.txt"), "b");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "Ajoute b");
    run(origin, "checkout", "-q", "main");
    run(
      origin,
      "merge",
      "-q",
      "--no-ff",
      "feature",
      "-m",
      "Merge pull request #7 from me/feature\n\nAjoute le fichier b",
    );
    const source = gitSource(clone)!;
    expect(gitSource(origin + "-nowhere")).toBeUndefined();
    expect(await source.version()).toMatch(/^[0-9a-f]{7,}$/);
    const found = await source.check();
    expect(found.behind).toBe(2);
    expect(found.notes).toEqual([{ title: "Ajoute le fichier b", number: 7 }]);
  });
});

describe("the copy before an update", () => {
  it("keeps only the latest copy, beside the daily ones", async () => {
    const dir = folder("moonagentic-backups-");
    const store = new Store(path.join(dir, "state.sqlite"));
    closers.push(() => store.close());
    const backups = path.join(dir, "backups");
    await backupBeforeUpdate(store, backups, "0.1.5");
    writeFileSync(path.join(backups, "state-2026-11-24.sqlite"), "");
    const file = await backupBeforeUpdate(store, backups, "0.1.6/../x");
    expect(path.basename(file)).toBe("state-avant-0.1.6..x.sqlite");
    expect(readdirSync(backups).sort()).toEqual([
      "state-2026-11-24.sqlite",
      "state-avant-0.1.6..x.sqlite",
    ]);
  });
});
