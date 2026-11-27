// The project's menu, dropped from its name, in the built app against a real server: its
// « Notifications » line says what this device does now, and on a phone it leaves on the page
// it was closed from.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject } from "./ui.ts";
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

/** The project made by the first check, which the second opens on a phone. */
let projectUrl: string;

describe("the project's menu", () => {
  // Neon's review of PR #192: the menu read the mute once, and kept it ever after.
  it("says the notifications as they are now, changed in another window", async () => {
    const context = await notifying({ width: 1280, height: 820 });
    const page = await context.newPage();
    await page.goto(url);
    await addProject(page, repo, false);
    projectUrl = page.url();
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
    await page.mouse.click(195, 760);
    const seen = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const pages: string[] = [];
          const look = () => {
            const menu = document.querySelector(".ddm.pjm");
            if (!menu) return resolve(pages);
            pages.push(menu.querySelector(".pjp")?.classList.contains("fwd") ? "notif" : "main");
            requestAnimationFrame(look);
          };
          look();
        }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === "notif")).toBe(true);
    await context.close();
  });
});
