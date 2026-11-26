// A quota that runs out, in the built app against a real server: the project's « Modèle de
// secours » takes over at once and says so above the composer; « Attendre » puts the thread
// back on its own model, to start again by itself once the quota is reset.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent, setAccess } from "./ui.ts";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-quota-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MOONAGENTIC_DEMO_QUOTA_FILE: path.join(dir, "spent.txt"),
      },
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

describe("a quota that runs out", () => {
  it("goes on with the fallback model, and « Attendre » waits for the reset instead", async () => {
    const project = path.join(dir, "secours");
    mkdirSync(project);
    writeFileSync(path.join(project, "README.md"), "# Démo\n");
    // The demo agent's « précis » model has no quota left.
    writeFileSync(path.join(dir, "spent.txt"), "precis\n");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await addProject(page, project, false);

    await page.getByRole("button", { name: "Réglages du projet" }).click();
    const dialog = page.getByRole("dialog", { name: "Réglages du projet" });
    await dialog
      .getByRole("switch", { name: "Reprendre les fils quand les quotas sont remis à zéro" })
      .click();
    await expect
      .poll(() =>
        dialog
          .getByRole("switch", { name: "Reprendre les fils quand les quotas sont remis à zéro" })
          .getAttribute("aria-checked"),
      )
      .toBe("true");
    await dialog.getByRole("button", { name: /^Modèle de secours/ }).click();
    const fallback = page.getByRole("dialog", { name: "Modèle de secours" });
    await fallback.getByRole("switch", { name: "Passer au secours" }).click();
    // Its models are read on asking, as no thread used it yet.
    const demo = fallback.locator(".gl2", { hasText: /^Agent de démo/ });
    const read = demo.getByRole("button", { name: "Lire ses modèles" });
    if (await read.isVisible()) await read.click();
    await fallback.getByRole("button", { name: "Démo rapide" }).first().click();
    await expect
      .poll(() =>
        fallback.getByRole("button", { name: "Démo rapide" }).first().getAttribute("aria-pressed"),
      )
      .toBe("true");
    if (shots) await page.screenshot({ path: path.join(shots, "secours-reglage.png") });
    await fallback.getByRole("button", { name: "Retour", exact: true }).click();
    await dialog.getByRole("button", { name: /^Modèle de secours.*Démo rapide/ }).waitFor();
    if (shots) {
      await dialog.getByRole("button", { name: /^Modèle de secours/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, "secours-projet.png") });
    }
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nouveau fil" }).first().click();
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await pickAgent(page);
    await setAccess(page, /Accès complet/);
    await composer.fill("Corrige le test");
    await composer.press("Enter");

    const bar = page.locator(".fbc");
    await bar.getByText("Démo rapide prend le relais").waitFor({ timeout: 30_000 });
    await bar.getByText(/Quota Démo précis fini · retour à \d\d:\d\d/).waitFor();
    // The agent goes on where it stopped, on the fallback model.
    await page.getByText("Tu as été interrompu : reprends là où tu t'es arrêté.").waitFor();
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor({ timeout: 20_000 });
    if (shots) await page.screenshot({ path: path.join(shots, "secours-fil.png") });

    await bar.getByRole("button", { name: "Attendre" }).click();
    await bar.getByText(/^Reprend à \d\d:\d\d/).waitFor({ timeout: 20_000 });
    await bar.getByText("Quota Démo précis fini").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "secours-attente.png") });
    await bar.getByRole("button", { name: "Annuler" }).click();
    await expect.poll(() => bar.count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
