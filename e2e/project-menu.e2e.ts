// The project's menu, dropped from its name, in the built app against a real server: its
// « Notifications » line says what this device does now, and on a phone it leaves on the page
// it was closed from, like a discussion's menu.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium } from "playwright";
import { addProject, whereChoices } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-menu-projet-e2e-"));
  repo = path.join(dir, "atelier");
  const home = path.join(dir, "home");
  for (const d of [repo, home]) mkdirSync(d);
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await addProject(page, repo, false);
  projectUrl = page.url();
  await page.close();
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

/** A device that notifies, the permission given and the setting on. */
async function notifying(viewport: { width: number; height: number }, touch = false) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  // Headless Chromium says « denied » until asked, whatever is granted: told « granted » here.
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    localStorage.setItem("moonagentic.notifications", "true");
  });
  return context;
}

/** The project every check opens, made before them. */
let projectUrl: string;

/**
 * Presses the page under a phone's menu, which closes it, and says which of its pages each
 * frame showed while it left. The frames are watched from before the press.
 */
async function closedSeeing(page: Page, menu: string, sub: string) {
  await page.evaluate(
    ([menu, sub]) => {
      const pick = (p: Element) => (p.classList.contains("fwd") ? sub : "main");
      const pages: string[] = [];
      (window as unknown as { seen: Promise<string[]> }).seen = new Promise((resolve) => {
        let was = false;
        const look = () => {
          const el = document.querySelector(menu);
          if (!el && was) return resolve(pages);
          if (el) {
            was = true;
            pages.push(pick(el.querySelector(".pjp")!));
          }
          requestAnimationFrame(look);
        };
        look();
      });
    },
    [menu, sub] as const,
  );
  await page.mouse.click(195, 760);
  return page.evaluate(() => (window as unknown as { seen: Promise<string[]> }).seen);
}

describe("the project's menu", () => {
  // Neon's review of PR #192: the menu read the mute once, and kept it ever after.
  it("says the notifications as they are now, changed in another window", async () => {
    const context = await notifying({ width: 1280, height: 820 });
    const page = await context.newPage();
    await page.goto(url);
    await page.goto(projectUrl);
    const menuOf = (p: typeof page) => p.getByRole("button", { name: /^Projet / });
    const line = (p: typeof page) => p.getByRole("menuitem", { name: /^Notifications/ });
    await menuOf(page).click();
    await expect.poll(() => line(page).textContent()).toContain("Activées");
    await page.keyboard.press("Escape");

    const other = await context.newPage();
    await other.goto(projectUrl);
    await menuOf(other).click();
    await line(other).click();
    await other.getByRole("menuitemradio", { name: "Coupées" }).click();
    await other.close();

    await menuOf(page).click();
    await expect.poll(() => line(page).textContent()).toContain("Coupées");
    await context.close();
  });

  // Neon's review of PR #192: the Enter that ends a word typed through an IME (Japanese,
  // Chinese…) saved the name half typed, and took the field away.
  it("keeps the project's name field while a word is being composed", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.goto(projectUrl);
    await page.getByRole("button", { name: "Paramètres du projet" }).click();
    const field = page
      .getByRole("dialog", { name: "Paramètres du projet" })
      .getByLabel("Nom du projet");
    await field.click();
    await field.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      ),
    );
    expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
    await context.close();
  });

  // Neon's review of PR #192: closed from its « Notifications » page, the phone's menu showed
  // its first page while it went away.
  it("leaves on a phone with the page it was closed from", async () => {
    const context = await notifying({ width: 390, height: 780 }, true);
    const page = await context.newPage();
    await page.goto(url);
    await page.goto(projectUrl);
    await page.getByRole("button", { name: /^Projet / }).click();
    await page.getByRole("menuitem", { name: /^Notifications/ }).click();
    await page.getByRole("menuitemradio", { name: "Activées" }).waitFor();
    // The page under the menu takes the press that closes it.
    const seen = await closedSeeing(page, ".ddm.pjm", "notif");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === "notif")).toBe(true);
    await context.close();
  });

  // Neon's review of PR #193: the discussion's menu on a phone did the same.
  it("leaves a discussion's menu on a phone with the page it was closed from", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(url);
    const composer = page.getByRole("combobox", { name: "Message" });
    await composer.waitFor();
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await composer.click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Projet/ }).click();
    await whereChoices(page)
      .getByText(/^Hors projet/)
      .first()
      .click();
    await composer.fill("Bonjour");
    // On a touch screen Enter goes to a new line (audit N32): the button sends.
    await page.getByRole("button", { name: "Envoyer", exact: true }).tap();
    await page.getByRole("button", { name: "Paramètres de la discussion" }).click();
    await page.getByRole("menuitem", { name: /^Accès/ }).click();
    await page.getByRole("menuitemradio", { name: /^Demande d'abord/ }).waitFor();
    const seen = await closedSeeing(page, ".ddm.dsm", "access");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === "access")).toBe(true);
    await context.close();
  });
});
