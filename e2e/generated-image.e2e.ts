// An image an agent generated, named in its answer as a path of the computer (as Antigravity
// does): shown in the thread and opened at full size, from a computer and from a phone, with
// its file to open or keep; the address it is served from serves that file alone.
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;
/** The thread the first check made, which the phone opens again. */
let threadPath: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-image-e2e-"));
  repo = path.join(dir, "demo");
  const home = path.join(dir, "home");
  for (const d of [repo, home]) mkdirSync(d);
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n\nPremière ligne.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  url = await startServer("0");
  browser = await chromium.launch();
});

/** The server on this port, with the same data: it gives the address it serves. */
function startServer(port: string): Promise<string> {
  const home = path.join(dir, "home");
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", port, "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home, MOONAGENTIC_DEMO_IMAGE_MS: "2500" },
      stdio: "pipe",
    },
  );
  return new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+#token=\S+/.exec(out);
      if (found) resolve(found[0]);
    });
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
  });
}

async function stopServer() {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
}

afterAll(async () => {
  await browser?.close();
  await stopServer();
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly keep a handle on a temp directory after process shutdown.
    }
  }
});

async function newThread(page: Page, ask = "Stp génère une image d'un pingouin") {
  await page.goto(url);
  await page.getByRole("button", { name: "Nouveau projet" }).first().click();
  await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
  await page.getByLabel("Dossier", { exact: true }).fill(repo);
  await page.getByRole("button", { name: "Ajouter le projet" }).click();
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  await page.locator(".agentchip").click();
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
  await page.keyboard.press("Escape");
  await composer.fill(ask);
  await composer.press("Enter");
}

describe("generated image", () => {
  it("shows in the thread, opens at full size, and can be opened or kept", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await newThread(page);

    const image = page.locator(".md img.md-img");
    await image.waitFor();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    threadPath = new URL(page.url()).pathname;
    const src = (await image.getAttribute("src"))!;
    expect(src).toMatch(/^\/api\/artifacts\/[\w-]{43}\/pingouin_\d+\.png$/);
    if (shots) await page.screenshot({ path: path.join(shots, "image-fil.png") });

    // Its address serves it without the token, and nothing else.
    const status = (to: string) =>
      page.evaluate(async (to) => (await fetch(to, { credentials: "omit" })).status, to);
    expect(await status(src)).toBe(200);
    expect(await status(src.replace(/pingouin_\d+\.png$/, "notes.md"))).toBe(404);
    expect(await status(src.replace(/pingouin_\d+\.png$/, "..%2Fnotes.md"))).toBe(404);

    await image.click();
    const viewer = page.getByRole("dialog");
    await expect
      .poll(() => viewer.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(480);
    expect(
      await viewer.getByRole("link", { name: "Télécharger" }).getAttribute("download"),
    ).toMatch(/^pingouin_\d+\.png$/);
    expect(await viewer.getByRole("link", { name: "Ouvrir" }).getAttribute("href")).toBe(src);
    if (shots) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(shots, "image-agrandie.png") });
    }
    await page.keyboard.press("Escape");
    await expect.poll(() => viewer.count()).toBe(0);

    // The copy in the project, named by a file address, opens the same way.
    await page.locator(".md a.md-file", { hasText: "pingouin.png" }).click();
    await expect
      .poll(() => viewer.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(480);
    await page.getByRole("button", { name: "Fermer" }).click();
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows on a phone too", async () => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await page.goto(url);
    await page.goto(new URL(threadPath, url).href);
    const image = page.locator(".md img.md-img");
    await image.waitFor();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    // Never wider than the screen.
    const width = await image.evaluate((img) => img.getBoundingClientRect().right);
    expect(width).toBeLessThanOrEqual(390);
    if (shots) await page.screenshot({ path: path.join(shots, "image-telephone.png") });
    await image.tap();
    await page.getByRole("link", { name: "Télécharger" }).waitFor();
    if (shots) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(shots, "image-telephone-agrandie.png") });
    }
    await context.close();
  });

  it("shows again once the server has started again", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.goto(new URL(threadPath, url).href);
    const image = page.locator(".md img.md-img");
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    const before = await image.getAttribute("src");

    // Started again: the addresses it gave are gone with it.
    await stopServer();
    await startServer(new URL(url).port);
    expect(await page.evaluate((src) => fetch(src!).then((r) => r.status), before)).toBe(404);

    // The thread shown again asks for a new address once the app is connected again.
    await expect
      .poll(() => page.getByRole("combobox", { name: "Message" }).isEnabled(), { timeout: 20_000 })
      .toBe(true);
    await page.getByRole("button", { name: "Artefacts", exact: true }).click();
    await page.waitForURL(/\/artefacts$/);
    await page.goBack();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    expect(await image.getAttribute("src")).not.toBe(before);
    expect(await page.locator(".md-img-gone").count()).toBe(0);
    await page.close();
  });

  it("is drawn in its place while generated, then shown though linked by its name alone", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 820 },
      acceptDownloads: true,
    });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await newThread(page, "Stp dessine une image de la lune");

    // While the agent's image tool works: its place, the time spent, no made-up percentage.
    const draft = page.locator(".img-draft");
    await draft.waitFor();
    expect(await draft.getByText("Crée l'image…").count()).toBe(1);
    expect(await draft.locator(".img-draft-time").textContent()).toMatch(/^\d+ s$/);
    if (shots) await page.screenshot({ path: path.join(shots, "image-esquisse.png") });

    // « [lune_….png](lune_….png) »: a name alone, the file in Antigravity's own folder.
    const image = page.locator(".md img.md-img");
    await image.waitFor({ timeout: 15_000 });
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    expect(await image.getAttribute("src")).toMatch(/\/lune_\d+\.png$/);
    await expect.poll(() => draft.count()).toBe(0);
    expect(await page.locator(".md a.md-file").count()).toBe(0);

    // Over its corner, what keeps it: a download on a computer.
    const keep = page.getByRole("button", { name: /l'image$/ });
    await keep.waitFor();
    const download = page.waitForEvent("download");
    await keep.click();
    expect((await download).suggestedFilename()).toMatch(/^lune_\d+\.png$/);
    if (shots) await page.screenshot({ path: path.join(shots, "image-nom-seul.png") });
    expect(errors).toEqual([]);
    await page.close();
  });

  it("is shown once made though the answer names no file, as Codex's is", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await newThread(page, "Stp peins une image de la lune");

    const draft = page.locator(".img-draft");
    await draft.waitFor();
    // « Voici la lune au-dessus des toits. »: the file is told in the tool's result only.
    const image = page.locator(".made-imgs img.md-img");
    await image.waitFor({ timeout: 15_000 });
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    expect(await image.getAttribute("src")).toMatch(/\/ig_\d+\.png$/);
    await expect.poll(() => draft.count()).toBe(0);
    await page.getByText("Voici la lune au-dessus des toits.").waitFor();
    expect(await page.locator(".md-img-gone").count()).toBe(0);
    if (shots) await page.screenshot({ path: path.join(shots, "image-outil-seul.png") });
    expect(errors).toEqual([]);
    await page.close();
  });
});
