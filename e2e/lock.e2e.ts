// /lock in the built app against a real server: a project locked with its code leaves every
// window, this one and another device's, and comes back once the code is given.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-lock-e2e-"));
  repo = path.join(dir, "secret");
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

const ANSWER = "C'est fait, la réponse vaut 42.";

describe("/lock", () => {
  it("hides a project from every window until its code is given, and locks the whole app", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await addProject(page, repo);
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await pickAgent(page);
    await setAccess(page, /Accès complet/);
    await composer.fill("Corrige la réponse");
    await composer.press("Enter");
    await page.getByText(ANSWER).waitFor();
    await page.waitForURL(/\/t\//);
    const threadUrl = page.url();
    const menu = page.getByRole("complementary", { name: "Menu" });

    // Another device, with the thread open too.
    const other = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await other.goto(url);
    await other.goto(threadUrl);
    await other.getByText(ANSWER).waitFor();

    // No code yet: the first lock, from the project's menu, asks for one, twice.
    await menu.getByRole("button", { name: /^secret/ }).click();
    await page.waitForURL(/\/p\//);
    await page.getByRole("button", { name: "Projet secret" }).click();
    await page.getByRole("menuitem", { name: "Verrouiller par code" }).click();
    await page.getByRole("dialog", { name: "Choisis ton code" }).waitFor();
    await page.keyboard.type("123456");
    await page.getByRole("dialog", { name: "Confirme ton code" }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "lock-code.png") });
    await page.keyboard.type("123456");
    await page.getByText("secret verrouillé").waitFor();
    // Nothing of it is left on either screen: its page says so, and asks for the code.
    await menu.getByRole("img", { name: "Verrouillé" }).waitFor();
    await expect.poll(() => page.getByText(ANSWER).count()).toBe(0);
    await expect.poll(() => page.getByText("Corrige la réponse").count()).toBe(0);
    await other.getByText("Ce fil n'existe plus, ou son projet est verrouillé").waitFor();
    await expect.poll(() => other.getByText(ANSWER).count()).toBe(0);
    await page.getByText("secret est verrouillé").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "lock-projet.png") });

    // A wrong code is refused; the right one opens it for every window.
    await page.getByRole("button", { name: "Déverrouiller", exact: true }).click();
    const pad = page.getByRole("dialog", { name: "secret est verrouillé" });
    await pad.waitFor();
    await page.keyboard.type("000000");
    await pad.getByText("Code incorrect.").waitFor();
    await expect.poll(() => pad.getByText("Code incorrect.").count()).toBe(0);
    await page.keyboard.type("123456");
    await pad.getByText("Déverrouillé", { exact: true }).waitFor();
    const line = menu.getByRole("button", { name: /^Corrige la réponse/ }).first();
    await line.waitFor();
    await other.getByText(ANSWER).waitFor();

    // /lock from the composer does the same, the code being set now.
    await line.click();
    await page.getByText(ANSWER).waitFor();
    await composer.fill("/lock");
    await composer.press("Enter");
    await menu.getByRole("img", { name: "Verrouillé" }).waitFor();
    await expect.poll(() => other.getByText(ANSWER).count()).toBe(0);
    // Réglages show it among the locked ones.
    await page.goto(new URL("/reglages/general", url).toString());
    await page.getByRole("button", { name: "Changer le code" }).waitFor();
    const locked = page.getByRole("switch", { name: "Déverrouiller secret" });
    expect(await locked.getAttribute("aria-checked")).toBe("true");
    if (shots) await page.screenshot({ path: path.join(shots, "lock-reglages.png") });

    // Ctrl Maj L locks the whole app on this device: the agents go on, the screen is shut
    // until the code is typed.
    await page.keyboard.press("Control+Shift+L");
    const shut = page.getByRole("dialog", { name: "App verrouillée" });
    await shut.waitFor();
    await page.keyboard.type("000000");
    await expect.poll(() => shut.count()).toBe(1);
    await page.waitForTimeout(1200);
    await page.keyboard.type("123456");
    await expect.poll(() => shut.count()).toBe(0);
    // Loaded again while locked, it stays locked.
    await page.keyboard.press("Control+Shift+L");
    await shut.waitFor();
    await page.reload();
    await shut.waitFor();
    await page.keyboard.type("123456");
    await expect.poll(() => shut.count()).toBe(0);
    // Typed before the server is reached again, on a slow network, the code still opens it.
    await page.keyboard.press("Control+Shift+L");
    await shut.waitFor();
    await page.route("**/api/ws-ticket", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.reload();
    await shut.waitFor();
    await page.keyboard.type("123456");
    await expect.poll(() => shut.count()).toBe(0);
    await page.unroute("**/api/ws-ticket");
    expect(errors).toEqual([]);
    await other.close();
    await page.close();
  });

  it("shows the pad on a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Projets" })
      .click();
    await page.getByRole("menuitem", { name: /^secret/ }).click();
    await page.getByRole("button", { name: "Déverrouiller", exact: true }).click();
    const pad = page.getByRole("dialog", { name: "secret est verrouillé" });
    await pad.waitFor();
    const tap = (digit: string) => pad.getByRole("button", { name: digit, exact: true }).click();
    for (const digit of "123") await tap(digit);
    if (shots) await page.screenshot({ path: path.join(shots, "lock-telephone.png") });
    for (const digit of "456") await tap(digit);
    await pad.getByText("Déverrouillé", { exact: true }).waitFor();
    await page.close();
  });
});
