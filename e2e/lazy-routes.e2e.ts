// Verifies that Planner and Settings are loaded on demand in the built app,
// with stable Suspense fallbacks and working navigation.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

const isPlannerChunk = (reqUrl: string) => /\/assets\/Planner-[^/]+\.js(?:$|\?)/.test(reqUrl);
const isSettingsChunk = (reqUrl: string) => /\/assets\/Settings-[^/]+\.js(?:$|\?)/.test(reqUrl);

function routeUrl(routePath: string) {
  const parsed = new URL(url);
  parsed.pathname = routePath;
  return parsed.href;
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lazy-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+#token=\S+/.exec(out);
      if (found) resolve(found[0]);
    });
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly keep a handle on a temp directory after process shutdown.
    }
  }
});

describe("lazy-loaded routes", () => {
  it("loads Planner and Settings only when opened, keeping layout stable during Suspense", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    const requested: string[] = [];
    page.on("pageerror", (err) => errors.push(err));
    page.on("request", (req) => requested.push(req.url()));

    await page.goto(url);
    await page.getByRole("button", { name: "Planner", exact: true }).waitFor();

    // Neither on-demand chunk is requested on initial load of the home page.
    expect(requested.some(isPlannerChunk)).toBe(false);
    expect(requested.some(isSettingsChunk)).toBe(false);

    // Delay the Planner chunk so we can verify its Suspense fallback before it resolves.
    let plannerIntercepted!: () => void;
    let releasePlanner!: () => void;
    const plannerSeen = new Promise<void>((r) => {
      plannerIntercepted = r;
    });
    const plannerGate = new Promise<void>((r) => {
      releasePlanner = r;
    });
    await page.route(/\/assets\/Planner-[^/]+\.js/, async (route) => {
      plannerIntercepted();
      await plannerGate;
      await route.continue();
    });

    await page.getByRole("button", { name: "Planner", exact: true }).click();
    await plannerSeen;
    await page.locator("main.center > .view").waitFor();
    expect(requested.some(isSettingsChunk)).toBe(false);

    releasePlanner();
    await page.getByText("Le planner range les tâches d'un projet.").waitFor();
    expect(requested.filter(isPlannerChunk)).toHaveLength(1);

    // Delay the Settings chunk to verify the sidebar fallback keeps the layout steady.
    let settingsIntercepted!: () => void;
    let releaseSettings!: () => void;
    const settingsSeen = new Promise<void>((r) => {
      settingsIntercepted = r;
    });
    const settingsGate = new Promise<void>((r) => {
      releaseSettings = r;
    });
    await page.route(/\/assets\/Settings-[^/]+\.js/, async (route) => {
      settingsIntercepted();
      await settingsGate;
      await route.continue();
    });

    await page.getByRole("button", { name: "Réglages" }).click();
    await settingsSeen;

    const settingsAside = page.locator('aside.side.set-side[aria-label="Réglages"]');
    await settingsAside.waitFor();
    await page.locator("main.center > .view").waitFor();
    const fallbackBox = await settingsAside.boundingBox();
    expect(fallbackBox).not.toBeNull();
    expect(fallbackBox!.width).toBeGreaterThan(200);

    releaseSettings();
    await page.getByRole("heading", { name: "Général" }).waitFor();
    await page.getByRole("button", { name: "Retour" }).waitFor();

    const loadedBox = await settingsAside.boundingBox();
    expect(loadedBox).not.toBeNull();
    expect(loadedBox!.x).toBe(fallbackBox!.x);
    expect(loadedBox!.width).toBe(fallbackBox!.width);
    // SettingsNav and SettingsPage come from one single chunk request.
    expect(requested.filter(isSettingsChunk)).toHaveLength(1);

    // Switching settings sections and going back works as expected.
    await page.getByRole("button", { name: "Apparence" }).click();
    await page.getByRole("heading", { name: "Apparence" }).waitFor();
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("heading", { name: "Agents" }).waitFor();
    await page.getByRole("button", { name: "Modèles" }).click();
    await page.getByRole("heading", { name: "Modèles" }).waitFor();
    await page.getByRole("button", { name: "Serveurs MCP" }).click();
    await page.getByRole("heading", { name: "Serveurs MCP" }).waitFor();

    await page.getByRole("button", { name: "Retour" }).click();
    await page.getByRole("button", { name: "Nouvelle discussion" }).waitFor();

    expect(errors).toEqual([]);
    await page.close();
  });

  it("supports direct navigation to /reglages/appearance and /planner", async () => {
    const settingsPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const settingsErrors: Error[] = [];
    const settingsRequests: string[] = [];
    settingsPage.on("pageerror", (err) => settingsErrors.push(err));
    settingsPage.on("request", (req) => settingsRequests.push(req.url()));

    await settingsPage.goto(routeUrl("/reglages/appearance"));
    await settingsPage.getByRole("heading", { name: "Apparence" }).waitFor();
    expect(settingsRequests.some(isSettingsChunk)).toBe(true);
    expect(settingsRequests.some(isPlannerChunk)).toBe(false);
    expect(settingsErrors).toEqual([]);
    await settingsPage.close();

    const plannerPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const plannerErrors: Error[] = [];
    const plannerRequests: string[] = [];
    plannerPage.on("pageerror", (err) => plannerErrors.push(err));
    plannerPage.on("request", (req) => plannerRequests.push(req.url()));

    await plannerPage.goto(routeUrl("/planner"));
    await plannerPage.getByText("Le planner range les tâches d'un projet.").waitFor();
    expect(plannerRequests.some(isPlannerChunk)).toBe(true);
    expect(plannerRequests.some(isSettingsChunk)).toBe(false);
    expect(plannerErrors).toEqual([]);
    await plannerPage.close();
  });
});
