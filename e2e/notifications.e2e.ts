// Browser notifications in the built app: turned on in the settings, shown when a thread
// starts waiting for the user's answer.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-notif-e2e-"));
  project = path.join(dir, "projet");
  const home = path.join(dir, "home");
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(project, "src/app.ts"), "export const answer = 41;\n");
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+\?token=\S+/.exec(out);
      if (found) resolve(found[0]);
    });
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
  });
  // The full browser: the lighter headless shell answers wrongly about notification permission.
  browser = await chromium.launch({ channel: "chromium" });
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

/** The notifications this site has on screen, as the browser lists them. */
const shown = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const list = (await registration?.getNotifications()) ?? [];
    return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
  });

describe("browser notifications", () => {
  it("are asked for in the settings, then tell when a thread waits for an answer", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByLabel("Dossier").fill(project);
    await page.getByRole("button", { name: "Créer" }).click();
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");

    // Off until asked for; the browser's refusal is said, and leaves them off.
    await page.getByRole("button", { name: "Réglages" }).first().click();
    const toggle = page.getByRole("switch", { name: "Notifications" });
    await toggle.waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await toggle.click();
    await page.getByText("Bloquées par le navigateur pour ce site").waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await context.grantPermissions(["notifications"]);
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
    await page.getByText("quand un fil attend ta réponse").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "n1-reglage.png") });

    // The trial button shows a real notification.
    await page.getByRole("button", { name: "Essayer" }).click();
    await page.getByRole("button", { name: "Envoyée" }).waitFor();
    await expect.poll(async () => (await shown(page)).map((n) => n.title)).toEqual(["MoonAgentic"]);

    // A thread asks for an agreement while the user is elsewhere in the app: one notification.
    await page.getByRole("button", { name: "Retour" }).click();
    await composer.fill("Corrige la réponse");
    await composer.press("Enter");
    await page.waitForURL(/\/t\//);
    await page.getByRole("button", { name: "Réglages" }).first().click();
    await expect
      .poll(async () => (await shown(page)).filter((n) => n.title === "Attend ta réponse"))
      .toMatchObject([{ body: "Corrige la réponse" }]);

    // Turned off, nothing more is shown; the choice is kept on this device.
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
    await page.reload();
    await toggle.waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(errors).toEqual([]);
    await context.close();
  });
});
