// An artifact the agent publishes, in the built app against a real server: a card in the
// conversation, outside any project, that opens the page with its script running in a
// sandbox of its own; a second publication is a new version, the first a tap away; on the
// phone too.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickAgent } from "./ui.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let threadPath: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-published-e2e-"));
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

const TITLE = "Maquette de l'accueil";

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  await composer.fill(text);
  await page.keyboard.press("Enter");
}

/** The page shown in the sheet, once its script has run. */
async function shownPage(page: Page) {
  const sheet = page.getByRole("dialog", { name: TITLE });
  const frame = sheet.frameLocator("iframe");
  await frame.getByRole("heading", { name: TITLE }).waitFor();
  await frame.locator("#lance").waitFor();
  return { sheet, frame };
}

describe("published artifacts", () => {
  it("shows a card in the conversation that opens the page, version by version", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    const outside: string[] = [];
    page.on("request", (req) => {
      if (!req.url().startsWith(new URL(url).origin) && !req.url().startsWith("data:"))
        outside.push(req.url());
    });
    await page.goto(url);
    await page.getByRole("combobox", { name: "Message" }).waitFor();
    await pickAgent(page);
    await send(page, `/publie ${TITLE}`);
    const card = page.getByRole("button", { name: `Ouvrir l'artefact ${TITLE}` });
    await card.waitFor();
    threadPath = new URL(page.url()).pathname;
    expect(await card.textContent()).toContain("Page HTML");
    // HTML artifacts preview inline in the thread with the same opaque-origin sandbox.
    const inlineFrame = page.frameLocator(`iframe[title="Aperçu de ${TITLE}"]`);
    await inlineFrame.getByRole("heading", { name: TITLE }).waitFor();
    await inlineFrame.getByRole("button", { name: "Toucher" }).click();
    await inlineFrame.getByRole("button", { name: "Touché" }).waitFor();
    const inlineOrigin = page.frames().find((f) => f.url().includes("/api/artifacts/"))!;
    expect(await inlineOrigin.evaluate(() => window.origin)).toBe("null");
    if (shots) await page.screenshot({ path: path.join(shots, "publie-carte.png") });

    // Folding unmounts the inline preview; unfolding brings it back.
    await page.getByRole("button", { name: `Réduire l'aperçu de ${TITLE}` }).click();
    await page.locator(`iframe[title="Aperçu de ${TITLE}"]`).waitFor({ state: "detached" });
    await page.getByRole("button", { name: `Afficher l'aperçu de ${TITLE}` }).click();
    await inlineFrame.getByRole("heading", { name: TITLE }).waitFor();

    await card.click();
    const { sheet, frame } = await shownPage(page);
    // Its script runs: a button of the page answers a tap.
    await frame.getByRole("button", { name: "Toucher" }).click();
    await frame.getByRole("button", { name: "Touché" }).waitFor();
    const shown = page.frames().find((f) => f.url().includes("/api/artifacts/"))!;
    expect(await shown.evaluate(() => window.origin)).toBe("null");
    if (shots) await page.screenshot({ path: path.join(shots, "publie-apercu.png") });
    await sheet.getByRole("button", { name: "Fermer", exact: true }).click();

    // Published again with its id: a second version, the first still there.
    const said = (await page
      .locator(".md")
      .filter({ hasText: "artifact_id" })
      .last()
      .textContent())!;
    const id = /"artifact_id": "([\w-]+)"/.exec(said)?.[1];
    expect(id).toBeTruthy();
    await send(page, `/publie ${TITLE} # ${id}`);
    await page.getByText("Page HTML · version 2").waitFor();
    await card.last().click();
    const again = await shownPage(page);
    await again.frame.getByText("Version suivante").waitFor();
    await again.sheet.getByRole("button", { name: "Version" }).click();
    const versions = page.getByRole("menu", { name: "Version" });
    await versions.getByRole("menuitemradio", { name: /^Version 2 · actuelle/ }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "publie-versions.png") });
    await versions.getByRole("menuitemradio", { name: /^Version 1/ }).click();
    await again.sheet.frameLocator("iframe").getByText("Première version").waitFor();
    await again.sheet.getByRole("button", { name: "Fermer", exact: true }).click();

    // Listed with the others, under its name.
    const pages = page.getByRole("navigation", { name: "Pages" });
    await pages.getByRole("button", { name: "Artefacts", exact: true }).click();
    const list = page.getByRole("region", { name: "Artefacts" });
    await list.getByRole("button", { name: new RegExp(`^${TITLE}`) }).click();
    await shownPage(page);
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("opens it from the phone too", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    // The token is kept first, as on any device already paired.
    await page.goto(url);
    await page.getByRole("combobox", { name: "Message" }).waitFor();
    await page.goto(new URL(threadPath, url).href);
    const card = page.getByRole("button", { name: `Ouvrir l'artefact ${TITLE}` }).first();
    await card.waitFor({ timeout: 15_000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (shots) await page.screenshot({ path: path.join(shots, "publie-telephone-carte.png") });
    await card.click();
    await shownPage(page);
    if (shots) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "publie-telephone-apercu.png") });
    }
    await page.close();
  }, 60_000);
});
