// Browser notifications in the built app: turned on in the settings, shown when a thread
// starts waiting for the user's answer.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
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
      const found = /http:\/\/\S+#token=\S+/.exec(out);
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

/**
 * Whether the page has the user's attention. The test browser gives every page the focus at
 * once, which no real one does, so each page says for itself whether it is in front.
 */
const FOCUS = "window.__inFront = true; document.hasFocus = () => window.__inFront;";
const inFront = (page: Page, yes: boolean) =>
  page.evaluate((value) => {
    (window as unknown as { __inFront: boolean }).__inFront = value;
  }, yes);
const waiting = async (page: Page) =>
  (await shown(page)).filter((n) => n.title === "Attend ta réponse");

async function pickDemoAgent(page: Page) {
  await pickAgent(page);
}

describe("browser notifications", () => {
  it("are asked for in the settings, then tell when a thread waits for an answer", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await context.addInitScript(FOCUS);
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await addProject(page, project);
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await pickDemoAgent(page);

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
    if (shots) await page.screenshot({ path: path.join(shots, "n1-reglage.png") });

    // The trial button shows a real notification.
    await page.getByRole("button", { name: "Essayer" }).click();
    await page.getByRole("button", { name: "Envoyée" }).waitFor();
    await expect.poll(async () => (await shown(page)).map((n) => n.title)).toEqual(["MoonAgentic"]);

    // With MoonAgentic in front of the user, a thread that asks for an agreement shows no
    // notification, even from another screen of the app: the app itself says it.
    await page.getByRole("button", { name: "Fermer les réglages" }).click();
    await composer.fill("Corrige la réponse");
    await composer.press("Enter");
    await page.waitForURL(/\/t\//);
    await page.getByRole("button", { name: "Réglages" }).first().click();
    await toggle.waitFor();
    await page.goBack();
    const allow = page.getByRole("button", { name: "Autoriser" });
    await allow.waitFor();
    expect(await waiting(page)).toEqual([]);
    await allow.click();

    // The user looks elsewhere: the next thread that waits tells them, once.
    await inFront(page, false);
    await page.getByRole("button", { name: "Nouvelle discussion" }).first().click();
    // On the home page before writing: typed into the thread still at work, the message
    // would wait in its queue and nothing would ask for an answer.
    await page.waitForURL((u) => !u.pathname.includes("/t/"));
    await composer.fill("Corrige encore");
    await composer.press("Enter");
    // A new thread starts an agent of its own first, which a busy CI machine takes its time over.
    await expect
      .poll(() => waiting(page), { timeout: 20_000 })
      .toMatchObject([{ body: "Corrige encore" }]);

    // Answered in the app, the notification about it goes away by itself.
    await page.getByRole("button", { name: "Autoriser" }).click();
    await expect.poll(() => waiting(page)).toEqual([]);

    // A second tab in front of the user keeps the first, in the background, quiet.
    const other = await context.newPage();
    await other.goto(new URL("/", url).href);
    await other.getByRole("button", { name: "Nouvelle discussion" }).first().waitFor();
    await page.getByRole("button", { name: "Nouvelle discussion" }).first().click();
    await page.waitForURL((u) => !u.pathname.includes("/t/"));
    await composer.fill("Corrige une troisième fois");
    await composer.press("Enter");
    await page.getByRole("button", { name: "Autoriser" }).waitFor();
    // Longer than a background tab waits for the answer of one in front.
    await page.waitForTimeout(600);
    expect(await waiting(page)).toEqual([]);
    await other.close();

    // Turned off, nothing more is shown; the choice is kept on this device.
    await page.getByRole("button", { name: "Réglages" }).first().click();
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
    await page.reload();
    await toggle.waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(errors).toEqual([]);
    await context.close();
  });
});
