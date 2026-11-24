import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
afterEach(() => {
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

function release(installer: Buffer, opts: { sums?: string | null; tag?: string } = {}) {
  const sha = createHash("sha256").update(installer).digest("hex");
  const sums = opts.sums === undefined ? `${sha}  ${EXE}\n${"a".repeat(64)}  x.dmg\n` : opts.sums;
  const json = {
    tag_name: opts.tag ?? "v0.1.5",
    html_url: `https://github.com/${REPO}/releases/tag/v0.1.5`,
    body: NOTES,
    assets: [
      { name: EXE, browser_download_url: `${DL}/${EXE}`, size: installer.length },
      {
        name: "MoonAgentic-0.1.5-mac-arm64.dmg",
        browser_download_url: `${DL}/MoonAgentic-0.1.5-mac-arm64.dmg`,
        size: 10,
      },
      ...(sums === null
        ? []
        : [{ name: "SHA256SUMS.txt", browser_download_url: `${DL}/SHA256SUMS.txt`, size: 10 }]),
    ],
  };
  const asked: string[] = [];
  const fetch = (async (url: string | URL) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith("https://api.github.com/")) return Response.json(json);
    if (u.endsWith("/SHA256SUMS.txt"))
      return new Response(sums ?? "", { status: sums ? 200 : 404 });
    if (u.endsWith(`/${EXE}`)) return new Response(new Uint8Array(installer));
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

function updater(fetch: typeof globalThis.fetch, platform: NodeJS.Platform = "win32") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-updates-"));
  dirs.push(dir);
  const states: ShellUpdate[] = [];
  const u = new Updater({
    current: "0.1.4",
    platform,
    dir,
    fetch,
    now: () => 1_000,
    onState: (s) => states.push(s),
  });
  return { u, dir, states };
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
});
