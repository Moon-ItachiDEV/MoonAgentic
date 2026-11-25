// An agent that stops in the middle of a turn, in the built app against a real server: the
// thread says so plainly, keeps what was done, lets the model change and « Reprendre ».
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-stopped-e2e-"));
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

/** A new project's composer, set on the demo agent, which asks before it acts. */
async function newThread(name: string) {
  const project = path.join(dir, name);
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await addProject(page, project);
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await pickAgent(page);
  return { page, composer };
}

describe("agent stopped mid-turn", () => {
  it("says it plainly, lets the model change, and « Reprendre » goes on", async () => {
    const { page, composer } = await newThread("arret");
    await composer.fill("/crash");
    await page.keyboard.press("Enter");

    const card = page.getByRole("alert").filter({ hasText: "s'est arrêté" });
    await card.waitFor({ timeout: 15_000 });
    expect(await card.locator("b").textContent()).toBe("Agent de démo s'est arrêté");
    // No raw connection message up front: it is under « Détail ».
    expect(await card.locator("code").isVisible()).toBe(false);
    // What the agent said before it stopped is still there.
    await page.getByText("Je commence le travail…").waitFor();
    if (shots) {
      await page.screenshot({ path: path.join(shots, "s1-arret.png") });
      await page.setViewportSize({ width: 390, height: 820 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(shots, "s1-arret-mobile.png") });
      await page.setViewportSize({ width: 1280, height: 820 });
    }

    // « Changer de modèle » opens the composer's picker, usable after the stop.
    await card.getByRole("button", { name: "Changer de modèle" }).click();
    const chip = page.getByRole("button", { name: /^Agent : / });
    expect(await chip.isDisabled()).toBe(false);
    await expect.poll(() => chip.getAttribute("aria-expanded")).toBe("true");
    if (shots) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "s2-modele.png") });
    }
    await page.getByRole("button", { name: "Plus", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Démo rapide/ }).click();
    await page.keyboard.press("Escape");
    // The composer folds once the focus is out of it, its model with it: it is opened to read it.
    await composer.click();
    await expect.poll(() => chip.textContent()).toContain("Démo rapide");

    await card.getByRole("button", { name: "Reprendre" }).click();
    await card.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Tu as été interrompu : reprends là où tu t'es arrêté.").waitFor();
    // A new session took the thread up, with the model picked after the stop.
    await composer.click();
    expect(await chip.textContent()).toContain("Démo rapide");
    if (shots) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "s3-repris.png") });
    }
    await page.close();
  });
});
