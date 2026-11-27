// A newer version in the built app, against a real server started as the desktop app starts
// it: a stand-in for the app says what is downloaded and replaces the server when asked to
// install. The capsule announces the version on the home page and on a project's page, the
// card follows the install, and says what the version brought once the app is back.
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

const NOTES = [
  { title: "Fenêtre de mise à jour repensée", number: 197 },
  { title: "Annonce dans la capsule", number: 197 },
  { title: "Une note sans numéro" },
];
const NEWER = { version: "0.1.16", size: 88_080_384, notes: NOTES };

/** The desktop app, as the server hears it: it starts the server and reports on itself. */
class Shell {
  version = "0.1.15";
  update: Record<string, unknown> = { state: "none" };
  /** Set to the address the server prints, each time it starts. */
  url: Promise<string> = Promise.resolve("");
  /** How many times the server asked to be replaced. */
  installs = 0;
  private child: ChildProcess | undefined;
  private readonly port: number;
  private readonly dataDir: string;
  private readonly home: string;

  constructor(port: number, dataDir: string, home: string) {
    this.port = port;
    this.dataDir = dataDir;
    this.home = home;
  }

  start(): Promise<string> {
    const child = fork(
      "apps/server/src/bin.ts",
      ["--demo", "--port", String(this.port), "--data-dir", this.dataDir],
      {
        cwd: root,
        env: { ...process.env, HOME: this.home, USERPROFILE: this.home },
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.child = child;
    child.on("message", (message) => {
      const asked = (message as { moon?: unknown } | null)?.moon;
      if (asked === "hello" || asked === "check") this.report();
      if (asked === "install") void this.replace();
    });
    this.url = new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const found = /http:\/\/\S+#token=\S+/.exec(out);
        if (found) resolve(found[0]);
      });
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
    });
    // Rejected when the server is stopped on purpose: nobody waits for it then.
    this.url.catch(() => undefined);
    return this.url;
  }

  say(update: Record<string, unknown>): void {
    this.update = { ...update, checkedAt: Date.now() };
    this.report();
  }

  private report(): void {
    if (!this.child?.connected) return;
    this.child.send({
      moon: "desktop",
      desktop: { platform: "win32", version: this.version, packaged: true, update: this.update },
    });
  }

  /** As the installer does: the server stops, the app comes back as the version downloaded. */
  private async replace(): Promise<void> {
    this.installs++;
    await this.stop();
    this.version = String(this.update.version);
    this.update = { state: "none", checkedAt: Date.now() };
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // Closing the channel is how the desktop app stops its server, on Windows too.
    if (child.connected) child.disconnect();
    else child.kill("SIGTERM");
    await exited;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let shell: Shell;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-update-e2e-"));
  repo = path.join(dir, "atelier");
  const home = path.join(dir, "home");
  for (const d of [repo, home]) mkdirSync(d);
  shell = new Shell(await freePort(), path.join(dir, "data"), home);
  url = await shell.start();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await shell?.stop();
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly keep a handle on a temp directory after process shutdown.
    }
  }
});

const capsule = (page: Page) => page.getByRole("button", { name: /^Mise à jour : / });
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `app-update-${name}.png`) });
};

describe("a newer version of MoonAgentic", () => {
  it("is announced by the capsule on the home page and on a project's page, once per device", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await page.getByRole("combobox", { name: "Message" }).waitFor();
    // Nothing newer: the capsule holds what it held, and says nothing of an update.
    expect(await capsule(page).count()).toBe(0);

    // While it downloads, the small moon is there and fills; nothing is announced yet.
    shell.say({ ...NEWER, state: "downloading", progress: 0.42 });
    await capsule(page).waitFor();
    expect(await capsule(page).getAttribute("aria-label")).toBe(
      "Mise à jour : Téléchargement, 42 %",
    );
    expect(await page.locator(".gcap.upc.ann").count()).toBe(0);

    // Ready: the capsule stretches to say so, then folds back by itself.
    shell.say({ ...NEWER, state: "ready" });
    await page.locator(".gcap.upc.ann").waitFor();
    expect(await capsule(page).getAttribute("aria-label")).toBe(
      "Mise à jour : Version 0.1.16, Prête",
    );
    await expect.poll(() => capsule(page).locator(".ul").isVisible()).toBe(true);
    await shot(page, "accueil-annonce");
    await expect.poll(() => page.locator(".gcap.upc.ann, .gcap.upc.fold").count()).toBe(0);

    // On a project's page the small moon is still there, and says nothing twice.
    await addProject(page, repo, false);
    await capsule(page).waitFor();
    await page.waitForTimeout(2500);
    expect(await page.locator(".gcap.upc.ann").count()).toBe(0);
    const projectUrl = page.url();

    // Another device opens the app on that project's page: it is announced there too.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    phone.on("pageerror", (err) => errors.push(err));
    await phone.goto(url);
    await phone.getByRole("combobox", { name: "Message" }).waitFor();
    await phone.evaluate(() => localStorage.removeItem("moonagentic.update.announced"));
    await phone.goto(projectUrl);
    await phone.locator(".tru .gcap.upc.solo.ann").waitFor();
    await expect.poll(() => capsule(phone).locator(".ul").isVisible()).toBe(true);
    await shot(phone, "projet-annonce");
    // The stretched capsule stays in the screen.
    const box = await phone.locator(".gcap.upc.ann").boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await expect.poll(() => phone.locator(".gcap.upc.ann, .gcap.upc.fold").count()).toBe(0);

    expect(errors).toEqual([]);
    await phone.close();
    await page.close();
  });

  it("opens its card from the capsule, installs, and says what came once the app is back", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await capsule(page).click();
    const card = page.getByRole("dialog", { name: "Mise à jour 0.1.16" });
    await card.waitFor();
    await card.getByText("Fenêtre de mise à jour repensée").waitFor();
    await card.getByText("#197").first().waitFor();
    await card.getByText("actuelle 0.1.15").waitFor();
    await shot(page, "carte-prete");

    // « Plus tard » only closes it; the capsule opens it again.
    await card.getByRole("button", { name: "Plus tard" }).click();
    await expect.poll(() => card.isVisible()).toBe(false);
    expect(shell.installs).toBe(0);
    await capsule(page).click();
    await card.getByRole("button", { name: "Installer", exact: true }).click();

    // The steps cover the page until the app is back: no way to close them.
    const steps = page.getByRole("dialog", { name: "Installation de MoonAgentic 0.1.16" });
    await steps.waitFor();
    await steps.getByText("Redémarrage et reconnexion").waitFor();
    expect(await steps.getByRole("button", { name: "Fermer" }).count()).toBe(0);
    await expect.poll(() => shell.installs).toBe(1);

    // The server now runs 0.1.16: the card says what it brought, until it is closed.
    const done = page.getByRole("dialog", { name: "MoonAgentic 0.1.16 installée" });
    await done.waitFor({ timeout: 30_000 });
    await done.getByText("Mise à jour installée").waitFor();
    await done.getByText("était 0.1.15").waitFor();
    await done.getByText("Une note sans numéro").waitFor();
    await shot(page, "installee");
    await done.getByRole("button", { name: "Continuer" }).click();
    await expect.poll(() => done.isVisible()).toBe(false);
    expect(await capsule(page).count()).toBe(0);

    // Said once: a page loaded again shows nothing of it.
    await page.reload();
    await page.getByRole("combobox", { name: "Message" }).waitFor();
    await page.waitForTimeout(1500);
    expect(await page.getByText("Mise à jour installée").count()).toBe(0);
    // The page's own errors only: a socket cut by the restart is the restart itself.
    expect(errors).toEqual([]);
    await page.close();
  });
});
