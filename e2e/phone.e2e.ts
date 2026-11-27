// The phone's finishes (audit of 2026-11-25, PR 11): the built app, the real server, the demo
// agent, on a touch screen the size of an iPhone.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { addProject, directThread, pickAgent, setAccess } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;
/** A thread waiting on a permission, and another one, idle. */
let waiting: string;
let idle: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-phone-e2e-"));
  project = path.join(dir, "projet");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src/app.ts"), "export const answer = 41;\n");
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

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

const PHONE = { width: 390, height: 844 };
/** An iPhone: touched, its keyboard on the screen. */
async function phone(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: shots ? 3 : 1,
  });
  const page = await context.newPage();
  // Once to pair the device, then each page by its address.
  await page.goto(url);
  await page.locator(".scr").waitFor();
  return { context, page };
}
async function go(page: Page, pathname: string) {
  await page.goto(new URL(pathname, url).href);
  await expect.poll(() => composer(page).isEnabled()).toBe(true);
}
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/** The controls on screen whose hit area, invisible margin included, is under 44 × 44 px. */
const smallTargets = (page: Page) =>
  page.evaluate(async () => {
    // Measured at rest: a button that pops in is drawn smaller for a moment.
    const moving = document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined));
    await Promise.race([Promise.all(moving), new Promise((r) => setTimeout(r, 2000))]);
    const small: string[] = [];
    const sel =
      "button, a[href], [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=option], [role=switch], [role=checkbox], input:not([type=hidden]), select, textarea, summary";
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || (e as HTMLButtonElement).disabled) continue;
      if (e.closest("[inert]") || getComputedStyle(e).visibility === "hidden") continue;
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      let opacity = 1;
      for (let x: HTMLElement | null = e; x; x = x.parentElement) {
        opacity *= Number(getComputedStyle(x).opacity);
      }
      if (opacity < 0.05) continue;
      let { width, height } = r;
      for (const pseudo of ["::before", "::after"]) {
        const p = getComputedStyle(e, pseudo);
        if (p.content === "none" || p.position !== "absolute") continue;
        const [t, b, l, rt] = [p.top, p.bottom, p.left, p.right].map(parseFloat);
        height = Math.max(height, r.height - Math.min(0, t!) - Math.min(0, b!));
        width = Math.max(width, r.width - Math.min(0, l!) - Math.min(0, rt!));
      }
      if (width < 43.5 || height < 43.5) {
        const name = e.getAttribute("aria-label") || e.textContent?.trim() || e.tagName;
        small.push(`${name.slice(0, 30)} ${Math.round(width)}×${Math.round(height)}`);
      }
    }
    return small;
  });

describe("on a phone", () => {
  it("has, from a computer, a thread waiting on a permission and another one idle", async () => {
    // From a computer: one thread asks before it writes, the other has answered.
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await addProject(page, project);
    await pickAgent(page);
    await setAccess(page, /Demande d'abord/);
    await say(page, "Corrige le calcul des frais de port");
    await page.locator(".dc").waitFor();
    waiting = new URL(page.url()).pathname;
    await directThread(page);
    await pickAgent(page);
    await setAccess(page, /Accès complet/);
    await say(page, "Bonjour");
    await page.waitForURL((u) => u.pathname.startsWith("/t/") && u.pathname !== waiting);
    idle = new URL(page.url()).pathname;
    await page.close();
  }, 120_000);

  it("folds the card of another thread to one line while the keyboard is up (N27)", async () => {
    const { context, page } = await phone();
    // The other thread waits on a permission: its card is here too.
    await go(page, idle);
    const card = page.locator(".dc");
    const folded = page.locator(".dcf");
    // No keyboard yet: the card is whole.
    await composer(page).blur();
    await card.waitFor();
    // The keyboard comes up: what is left of the screen goes to the conversation.
    await composer(page).tap();
    await page.setViewportSize({ width: PHONE.width, height: 464 });
    await folded.waitFor();
    expect(await card.count()).toBe(0);
    expect((await folded.boundingBox())!.height).toBeLessThan(60);
    await shot(page, "n27-clavier");
    // A tap opens it, the keyboard still up.
    await folded.tap();
    await card.waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message",
    );
    // The keyboard gone, it stays whole; up again, it folds again.
    await page.setViewportSize(PHONE);
    await composer(page).blur();
    await card.waitFor();
    await composer(page).tap();
    await page.setViewportSize({ width: PHONE.width, height: 464 });
    await folded.waitFor();
    await context.close();
  });

  it("goes to a new line with Enter, and sends with the button (N32)", async () => {
    const { context, page } = await phone();
    await go(page, idle);
    await composer(page).tap();
    await page.keyboard.type("Première ligne");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Seconde ligne");
    expect(await composer(page).inputValue()).toBe("Première ligne\nSeconde ligne");
    expect(await smallTargets(page)).toEqual([]);
    await page.getByRole("button", { name: "Envoyer", exact: true }).tap();
    await expect.poll(() => composer(page).inputValue()).toBe("");
    await page.locator(".feed .item", { hasText: "Seconde ligne" }).waitFor();
    await context.close();
  });

  it("says the quota in a few words, whole (N29)", async () => {
    const { context, page } = await phone();
    await go(page, idle);
    const warning = page.locator(".updb.qw .tx");
    await warning.waitFor();
    const text = (await warning.evaluate((el) => el.firstChild?.textContent ?? "")).replace(
      /\s/g,
      " ",
    );
    expect(text).toBe("86 % (5 h)");
    expect(await warning.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot(page, "n29-quota");
    await context.close();
  });

  it("keeps every control of the home page and the settings at 44 px under the finger (M3)", async () => {
    const { context, page } = await phone();
    await go(page, "/");
    expect(await smallTargets(page)).toEqual([]);
    await page.goto(new URL("/reglages/general", url).href);
    await page.getByRole("switch").first().waitFor();
    expect(await smallTargets(page)).toEqual([]);
    await context.close();
  });
  it("asks for a permission once, on the card, and keeps it with the steps once answered (M2)", async () => {
    const { context, page } = await phone();
    await go(page, waiting);
    const card = page.locator(".dc");
    await card.waitFor();
    expect(await page.locator(".feed .ask").count()).toBe(0);
    await shot(page, "m2-permission");
    expect(await smallTargets(page)).toEqual([]);
    await card
      .getByRole("button", { name: /Autoriser/ })
      .first()
      .tap();
    // Answered, it leaves the card, and the feed keeps it with the agent's steps.
    await expect.poll(() => card.count()).toBe(0);
    await page.locator(".det .fold").last().tap();
    await page.locator(".feed .ask.done").first().waitFor();
    await context.close();
  });
});

describe("on a computer", () => {
  it("sends with Enter, and says the quota whole", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.locator(".scr").waitFor();
    await page.goto(new URL(idle, url).href);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    const warning = page.locator(".updb.qw .tx");
    await warning.waitFor();
    expect((await warning.textContent())?.replace(/\s/g, " ")).toContain(
      "Agent de démo a utilisé 86 % (5 h).",
    );
    await say(page, "Encore une");
    await expect.poll(() => composer(page).inputValue()).toBe("");
    await page.close();
  });
});
