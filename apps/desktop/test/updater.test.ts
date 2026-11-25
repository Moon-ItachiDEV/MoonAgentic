import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INCOMPLETE_RETRY_MS,
  INCOMPLETE_RETRY_STEPS,
  installerArgs,
  installerOf,
  installerSpawn,
  isNewer,
  parseNotes,
  readRelease,
  REPO,
  type ShellUpdate,
  sumFor,
  Updater,
} from "../src/updater.ts";

const dirs: string[] = [];
const updaters: Updater[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const u of updaters.splice(0)) u.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const DL = `https://github.com/${REPO}/releases/download/v0.1.5`;
const EXE = "MoonAgentic-0.1.5-windows-x64.exe";
const NOTES = [
  "## What's Changed",
  `* Disque et gels by @Moon-ItachiDEV in https://github.com/${REPO}/pull/130`,
  `* Notifications natives sur Windows by @someone in https://github.com/${REPO}/pull/131`,
  "",
  `**Full Changelog**: https://github.com/${REPO}/compare/v0.1.4...v0.1.5`,
].join("\n");

function release(
  installer: Buffer,
  opts: { sums?: string | null; tag?: string; withExe?: boolean } = {},
) {
  const tag = opts.tag ?? "v0.1.5";
  const ver = tag.replace(/^v/, "");
  const dl = `https://github.com/${REPO}/releases/download/${tag}`;
  const exe = `MoonAgentic-${ver}-windows-x64.exe`;
  const sha = createHash("sha256").update(installer).digest("hex");
  const sums = opts.sums === undefined ? `${sha}  ${exe}\n${"a".repeat(64)}  x.dmg\n` : opts.sums;
  const json = {
    tag_name: tag,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    body: NOTES,
    assets: [
      ...(opts.withExe === false
        ? []
        : [{ name: exe, browser_download_url: `${dl}/${exe}`, size: installer.length }]),
      {
        name: `MoonAgentic-${ver}-mac-arm64.dmg`,
        browser_download_url: `${dl}/MoonAgentic-${ver}-mac-arm64.dmg`,
        size: 10,
      },
      ...(sums === null
        ? []
        : [{ name: "SHA256SUMS.txt", browser_download_url: `${dl}/SHA256SUMS.txt`, size: 10 }]),
    ],
  };
  const asked: string[] = [];
  const fetch = (async (url: string | URL) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith("https://api.github.com/")) return Response.json(json);
    if (u.endsWith("/SHA256SUMS.txt"))
      return new Response(sums ?? "", { status: sums ? 200 : 404 });
    if (u.endsWith(`/${exe}`)) return new Response(new Uint8Array(installer));
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

function updater(
  fetch: typeof globalThis.fetch,
  platform: NodeJS.Platform = "win32",
  incompleteRetryMs = 0,
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-updates-"));
  dirs.push(dir);
  const states: ShellUpdate[] = [];
  const u = new Updater({
    current: "0.1.4",
    platform,
    dir,
    fetch,
    now: () => 1_000,
    incompleteRetryMs,
    onState: (s) => states.push(s),
  });
  updaters.push(u);
  return { u, dir, states };
}

/** Lets a look started by a retry end: what it reads and writes is real, whatever the clock. */
async function settled(u: Updater): Promise<void> {
  await (u as unknown as { running?: Promise<void> }).running;
  await new Promise((r) => setImmediate(r));
}

describe("versions and notes", () => {
  it("compares versions number by number", () => {
    expect(isNewer("v0.1.5", "0.1.4")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
    expect(isNewer("nightly", "0.1.4")).toBe(false);
  });

  it("reads the pull requests GitHub lists in a release's notes", () => {
    expect(parseNotes(NOTES)).toEqual([
      { title: "Disque et gels", number: 130 },
      { title: "Notifications natives sur Windows", number: 131 },
    ]);
  });

  it("keeps only files downloaded from the repository's own releases", () => {
    const r = readRelease({
      tag_name: "v0.1.5",
      html_url: "https://evil.example/",
      assets: [
        { name: EXE, browser_download_url: "https://evil.example/x.exe", size: 1 },
        { name: "../x.exe", browser_download_url: `${DL}/x.exe`, size: 1 },
        { name: EXE, browser_download_url: `${DL}/${EXE}`, size: 5 },
      ],
    });
    expect(r?.assets).toEqual([{ name: EXE, url: `${DL}/${EXE}`, size: 5 }]);
    expect(r?.page).toBe(`https://github.com/${REPO}/releases`);
    expect(readRelease({ tag_name: "v0.1.5", prerelease: true })).toBeUndefined();
    expect(installerOf(r!, "darwin")).toBeUndefined();
  });

  it("finds a file's SHA-256 in a sha256sum listing", () => {
    const sha = "AB".repeat(32);
    expect(sumFor(`${sha}  ${EXE}\n`, EXE)).toBe(sha.toLowerCase());
    expect(sumFor(`${sha} *${EXE}\n`, EXE)).toBe(sha.toLowerCase());
    expect(sumFor(`${sha}  other.exe\n`, EXE)).toBeUndefined();
  });

  it("starts the installer silent, in the app's folder, then the app again", () => {
    expect(installerArgs("C:\\Users\\moi\\AppData\\Local\\Programs\\MoonAgentic")).toEqual([
      "--updated",
      "/S",
      "--force-run",
      "/D=C:\\Users\\moi\\AppData\\Local\\Programs\\MoonAgentic",
    ]);
  });
});

describe("starting the installer on Windows", () => {
  it("writes the command line as is, the installer's own path between quotes", () => {
    const run = installerSpawn("C:\\Users\\Prénom Nom\\setup.exe", "C:\\Programs\\MoonAgentic");
    expect(run.options).toMatchObject({
      argv0: '"C:\\Users\\Prénom Nom\\setup.exe"',
      windowsVerbatimArguments: true,
      detached: true,
    });
    expect(run.args.at(-1)).toBe("/D=C:\\Programs\\MoonAgentic");
  });

  // What the installer really receives: a program that reads its command line says it.
  it.runIf(process.platform === "win32")(
    "leaves /D= without quotes, with a space or an accent in the folder",
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-args-"));
      dirs.push(dir);
      const script = path.join(dir, "args.js");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      const argsOf = (installDir: string) => {
        const { options } = installerSpawn(process.execPath, installDir);
        const out = spawnSync(process.execPath, [script, ...installerArgs(installDir)], {
          argv0: options.argv0,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          encoding: "utf8",
        });
        return JSON.parse(out.stdout) as string[];
      };
      // The mini-PC's folder: an accent, no space. One argument, as it is.
      expect(argsOf("C:\\Users\\BreezyHomeCinéma\\AppData\\Local\\Programs\\MoonAgentic")).toEqual([
        "--updated",
        "/S",
        "--force-run",
        "/D=C:\\Users\\BreezyHomeCinéma\\AppData\\Local\\Programs\\MoonAgentic",
      ]);
      // With a space, no quote is added: NSIS reads /D= to the end of the line, and Node,
      // which splits on spaces, sees two pieces.
      expect(argsOf("C:\\Users\\Prénom Nom\\MoonAgentic").slice(3)).toEqual([
        "/D=C:\\Users\\Prénom",
        "Nom\\MoonAgentic",
      ]);
    },
  );
});

describe("Updater", () => {
  it("downloads a newer installer, checks its fingerprint, and holds it ready", async () => {
    const installer = Buffer.from("installeur ".repeat(5000));
    const { fetch } = release(installer);
    const { u, dir, states } = updater(fetch);
    await u.check();
    expect(u.state).toMatchObject({
      state: "ready",
      version: "0.1.5",
      size: installer.length,
      notes: [{ title: "Disque et gels", number: 130 }, expect.anything()],
    });
    expect(states.map((s) => s.state)).toContain("downloading");
    expect(u.installer).toBe(path.join(dir, EXE));
    expect(readdirSync(dir)).toEqual([EXE]);
  });

  it("refuses an installer whose fingerprint does not match, and keeps nothing of it", async () => {
    const { fetch } = release(Buffer.from("vrai"), { sums: `${"0".repeat(64)}  ${EXE}\n` });
    const { u, dir } = updater(fetch);
    await u.check();
    expect(u.state.state).toBe("failed");
    expect(u.state.error).toMatch(/empreinte/);
    expect(u.installer).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("downloads nothing from a release without SHA256SUMS.txt", async () => {
    const { fetch, asked } = release(Buffer.from("x"), { sums: null });
    const { u } = updater(fetch);
    await u.check();
    expect(u.state).toMatchObject({ state: "failed", version: "0.1.5" });
    expect(asked.some((a) => a.endsWith(".exe"))).toBe(false);
  });

  it("on a Mac, only says where to download the newer version", async () => {
    const { fetch, asked } = release(Buffer.from("x"));
    const { u } = updater(fetch, "darwin");
    await u.check();
    expect(u.state).toMatchObject({
      state: "available",
      version: "0.1.5",
      url: `https://github.com/${REPO}/releases/tag/v0.1.5`,
    });
    expect(asked).toHaveLength(1);
  });

  it("says nothing when the latest release is not newer", async () => {
    const { fetch } = release(Buffer.from("x"), { tag: "v0.1.4" });
    const { u } = updater(fetch);
    await u.check();
    expect(u.state).toEqual({ state: "none", checkedAt: 1_000 });
  });

  it("does not download again an installer kept from an earlier look", async () => {
    const installer = Buffer.from("déjà là");
    const { fetch, asked } = release(installer);
    const { u, dir } = updater(fetch);
    writeFileSync(path.join(dir, EXE), installer);
    writeFileSync(path.join(dir, "MoonAgentic-0.1.3-windows-x64.exe"), "vieux");
    await u.check();
    expect(u.state.state).toBe("ready");
    expect(asked.some((a) => a.endsWith(".exe"))).toBe(false);
    expect(readdirSync(dir)).toEqual([EXE]);
  });

  it("keeps a version ready when a later look fails", async () => {
    const installer = Buffer.from("prêt");
    const { fetch } = release(installer);
    let offline = false;
    const { u } = updater(((url: string) =>
      offline ? Promise.reject(new Error("hors ligne")) : fetch(url)) as typeof globalThis.fetch);
    await u.check();
    expect(u.state.state).toBe("ready");
    offline = true;
    await u.check();
    expect(u.state.state).toBe("ready");
    expect(existsSync(u.installer!)).toBe(true);
  });

  it("on Windows, waits for the .exe to be attached before announcing a release", async () => {
    const { fetch, asked } = release(Buffer.from("x"), { withExe: false, sums: null });
    const { u } = updater(fetch, "win32");
    await u.check();
    expect(u.state).toEqual({ state: "none", checkedAt: 1_000 });
    expect(u.installer).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it("on Windows, keeps an already-ready installer when a newer release has no .exe yet", async () => {
    const installer = Buffer.from("prêt");
    const readyRelease = release(installer, { tag: "v0.1.5" });
    const pendingRelease = release(Buffer.from("x"), { tag: "v0.1.6", withExe: false, sums: null });
    let pending = false;
    const { u } = updater(((url: string | URL) =>
      pending ? pendingRelease.fetch(url) : readyRelease.fetch(url)) as typeof globalThis.fetch);
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });
    pending = true;
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });
    expect(existsSync(u.installer!)).toBe(true);
  });

  it("keeps an already-ready installer usable if a newer release has .exe before SHA256SUMS.txt or fails mid-download", async () => {
    const v5 = Buffer.from("installeur-0.1.5");
    const v6 = Buffer.from("installeur-0.1.6");
    const r5 = release(v5, { tag: "v0.1.5" });
    const r6NoSums = release(v6, { tag: "v0.1.6", sums: null });
    const r6BadHash = release(v6, {
      tag: "v0.1.6",
      sums: `${"0".repeat(64)}  MoonAgentic-0.1.6-windows-x64.exe\n`,
    });
    const r6Complete = release(v6, { tag: "v0.1.6" });
    let stage: "v5" | "noSums" | "badHash" | "v6" = "v5";
    const { u, dir } = updater(((url: string | URL) => {
      if (stage === "v5") return r5.fetch(url);
      if (stage === "noSums") return r6NoSums.fetch(url);
      if (stage === "badHash") return r6BadHash.fetch(url);
      return r6Complete.fetch(url);
    }) as typeof globalThis.fetch);

    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });
    const v5File = u.installer!;
    expect(existsSync(v5File)).toBe(true);

    // Parallel upload race: .exe visible before SHA256SUMS.txt -> 0.1.5 stays ready and on disk.
    stage = "noSums";
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });
    expect(u.installer).toBe(v5File);
    expect(existsSync(v5File)).toBe(true);

    // Failed download of 0.1.6 -> 0.1.5 still stays ready and on disk.
    stage = "badHash";
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });
    expect(u.installer).toBe(v5File);
    expect(existsSync(v5File)).toBe(true);

    // Once 0.1.6 is complete, it swaps in cleanly and removes 0.1.5.
    stage = "v6";
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.6" });
    expect(readdirSync(dir)).toEqual(["MoonAgentic-0.1.6-windows-x64.exe"]);
  });

  it("retries shortly when a Windows release is still missing its .exe and picks it up once uploaded", async () => {
    const installer = Buffer.from("installeur-0.1.6");
    const incomplete = release(installer, { tag: "v0.1.6", withExe: false, sums: null });
    const complete = release(installer, { tag: "v0.1.6" });
    let calls = 0;
    const { u } = updater(
      ((url: string | URL) => {
        if (String(url).startsWith("https://api.github.com/")) calls += 1;
        return calls >= 2 ? complete.fetch(url) : incomplete.fetch(url);
      }) as typeof globalThis.fetch,
      "win32",
      25,
    );

    await u.check();
    expect(u.state).toEqual({ state: "none", checkedAt: 1_000 });
    await expect.poll(() => u.state.state, { timeout: 1_000 }).toBe("ready");
    expect(u.state.version).toBe("0.1.6");
    expect(calls).toBe(2);
  });

  it("spreads the quick retries over an hour, then leaves it to the next look", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const incomplete = release(Buffer.from("x"), { tag: "v0.1.6", withExe: false, sums: null });
    const start = Date.now();
    const looks: number[] = [];
    const { u } = updater(
      ((url: string | URL) => {
        looks.push((Date.now() - start) / 60_000);
        return incomplete.fetch(url);
      }) as typeof globalThis.fetch,
      "win32",
      INCOMPLETE_RETRY_MS,
    );

    await u.check();
    for (let minute = 0; minute < 3 * 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await settled(u);
    }
    // Every 3 minutes while CI usually builds, then further apart: a Mac runner that waits its
    // turn holds the Windows installer back for longer than 18 minutes.
    expect(looks).toEqual([0, 3, 6, 9, 12, 15, 18, 24, 30, 39, 48, 63]);
    expect(looks).toHaveLength(INCOMPLETE_RETRY_STEPS.length + 1);
  });

  it("goes on with the quick retries after one that could not reach GitHub", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const installer = Buffer.from("installeur-0.1.6");
    const incomplete = release(installer, { tag: "v0.1.6", withExe: false, sums: null });
    const complete = release(installer, { tag: "v0.1.6" });
    let stage: "incomplete" | "offline" | "complete" = "incomplete";
    const { u } = updater(
      ((url: string | URL) => {
        if (stage === "offline") return Promise.reject(new Error("hors ligne"));
        return stage === "complete" ? complete.fetch(url) : incomplete.fetch(url);
      }) as typeof globalThis.fetch,
      "win32",
      INCOMPLETE_RETRY_MS,
    );

    await u.check();
    expect(u.state.state).toBe("none");
    stage = "offline";
    await vi.advanceTimersByTimeAsync(INCOMPLETE_RETRY_MS);
    await settled(u);
    expect(u.state).toMatchObject({ state: "failed", error: "hors ligne" });
    // The installer is attached meanwhile: found at the next quick retry, not six hours later.
    stage = "complete";
    await vi.advanceTimersByTimeAsync(INCOMPLETE_RETRY_MS);
    await settled(u);
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.6" });
  });

  it("retries shortly when the .exe is there before SHA256SUMS.txt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const installer = Buffer.from("installeur-0.1.6");
    const noSums = release(installer, { tag: "v0.1.6", sums: null });
    const complete = release(installer, { tag: "v0.1.6" });
    let uploaded = false;
    const { u } = updater(
      ((url: string | URL) =>
        uploaded ? complete.fetch(url) : noSums.fetch(url)) as typeof globalThis.fetch,
      "win32",
      INCOMPLETE_RETRY_MS,
    );

    await u.check();
    expect(u.state).toMatchObject({ state: "failed", version: "0.1.6" });
    expect(noSums.asked.some((a) => a.endsWith(".exe"))).toBe(false);
    uploaded = true;
    await vi.advanceTimersByTimeAsync(INCOMPLETE_RETRY_MS);
    await settled(u);
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.6" });
  });

  it("leaves the installer being started on disk when a newer one is swapped in", async () => {
    const r5 = release(Buffer.from("installeur-0.1.5"), { tag: "v0.1.5" });
    const r6 = release(Buffer.from("installeur-0.1.6"), { tag: "v0.1.6" });
    let latest = r5;
    const { u, dir } = updater(((url: string | URL) =>
      latest.fetch(url)) as typeof globalThis.fetch);
    expect(u.hold()).toBeUndefined();
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.5" });

    // The user asks to install 0.1.5: the app takes its installer, then stops the server. A
    // look ends meanwhile with 0.1.6 downloaded.
    const started = u.hold()!;
    expect(started).toBe(path.join(dir, "MoonAgentic-0.1.5-windows-x64.exe"));
    latest = r6;
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.6" });
    expect(existsSync(started)).toBe(true);

    // It could not start after all: nothing holds it any more, the next look removes it.
    u.fail("L'installeur n'a pas pu démarrer.");
    await u.check();
    expect(u.state).toMatchObject({ state: "ready", version: "0.1.6" });
    expect(readdirSync(dir)).toEqual(["MoonAgentic-0.1.6-windows-x64.exe"]);
  });
});
