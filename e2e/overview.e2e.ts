// A long answer written fast, in the built app against a real server: the page keeps up.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let project: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-accueil-e2e-"));
  project = path.join(dir, "projet");
  const home = path.join(dir, "home");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      // A short wait between two words, as a model writes: the answer takes a few seconds.
      env: { ...process.env, HOME: home, USERPROFILE: home, MOONAGENTIC_DEMO_DELAY_MS: "2" },
      stdio: "pipe",
    },
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

describe("home overview", () => {
  it("shows the day's messages, the thread to come back to, and folds away", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(project);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    // No thread yet: the greeting stands alone.
    expect(await page.locator(".ov").count()).toBe(0);

    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");
    await composer.fill("Bonjour");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);

    await page.getByRole("button", { name: "Nouvelle discussion" }).first().click();
    await expect.poll(() => page.locator(".ov").count()).toBe(1);
    // Today's cell counts the user's message and the agent's answer.
    await expect
      .poll(() => page.locator(".ov-heat i.today").getAttribute("title"))
      .toMatch(/· [2-9]\d* messages/);
    await expect.poll(() => page.locator(".ov-foot b").first().textContent()).not.toBe("0");
    expect(await page.locator(".ov-heat i").count()).toBe(26 * 7);

    await page.getByRole("button", { name: "Masquer l'aperçu" }).click();
    expect(await page.locator(".ov").count()).toBe(0);
    await page.getByRole("button", { name: "Afficher l'aperçu" }).click();
    expect(await page.locator(".ov").count()).toBe(1);
    await page.close();
  });
});
