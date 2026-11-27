// The desktop window hidden in the tray, or minimized, keeps `document.hidden` false: the shell
// says it instead (`moonDesktop.onVisible`). The built app then stops what it draws for nobody:
// the canvas moons, and the CSS animations through `html.page-hidden`.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-hidden-e2e-"));
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

interface Probe {
  /** Plays the main process: tells the page whether its window can be seen. */
  tell(visible: boolean): void;
  /** How many times a `<moon-mascot>` cleared its canvas to draw itself again. */
  draws(): number;
}
const probe = (page: Page) => ({
  tell: (visible: boolean) =>
    page.evaluate((v) => (window as unknown as { probe: Probe }).probe.tell(v), visible),
  draws: () => page.evaluate(() => (window as unknown as { probe: Probe }).probe.draws()),
  /** The moons' draws over a while. */
  async drawsDuring(ms: number) {
    const before = await this.draws();
    await page.waitForTimeout(ms);
    return (await this.draws()) - before;
  },
  hiddenClass: () =>
    page.evaluate(() => document.documentElement.classList.contains("page-hidden")),
});

/**
 * Réglages › Mascottes in a window of the desktop app: the shell as its preload exposes it,
 * which says again at subscription what it last heard. `hidden`: the window was hidden before
 * the page asked.
 */
async function mascotsPage(hidden = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.addInitScript((startHidden: boolean) => {
    const listeners = new Set<(visible: boolean) => void>();
    let last: boolean | undefined = startHidden ? false : undefined;
    let draws = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...area) {
      const host = (this.canvas.getRootNode() as ShadowRoot).host;
      if (host?.localName === "moon-mascot") draws++;
      return clear.apply(this, area);
    };
    Object.assign(window, {
      probe: {
        tell(visible: boolean) {
          last = visible;
          for (const listener of listeners) listener(visible);
        },
        draws: () => draws,
      },
      moonDesktop: {
        notify() {},
        close() {},
        onOpen() {},
        onVisible(listener: (visible: boolean) => void) {
          listeners.add(listener);
          if (last !== undefined) listener(last);
          return () => void listeners.delete(listener);
        },
      },
    });
  }, hidden);
  const target = new URL(url);
  target.pathname = "/reglages/mascots";
  await page.goto(target.href);
  await page.locator("moon-mascot").first().waitFor();
  return page;
}

describe("la fenêtre du bureau cachée", () => {
  it("arrête les lunes et les animations, puis les relance quand elle revient", async () => {
    const page = await mascotsPage();
    const seen = probe(page);
    await expect.poll(() => seen.draws()).toBeGreaterThan(5);
    expect(await seen.hiddenClass()).toBe(false);

    await seen.tell(false);
    await expect.poll(() => seen.hiddenClass()).toBe(true);
    // The frame already asked for may still be drawn; nothing after it.
    await page.waitForTimeout(200);
    expect(await seen.drawsDuring(1_000)).toBe(0);

    await seen.tell(true);
    await expect.poll(() => seen.hiddenClass()).toBe(false);
    expect(await seen.drawsDuring(1_000)).toBeGreaterThan(10);
    await page.close();
  });

  it("le sait aussi quand elle était cachée avant que la page ne le demande", async () => {
    const page = await mascotsPage(true);
    const seen = probe(page);
    await expect.poll(() => seen.hiddenClass()).toBe(true);
    await page.waitForTimeout(500);
    expect(await seen.drawsDuring(1_000)).toBe(0);

    await seen.tell(true);
    await expect.poll(() => seen.hiddenClass()).toBe(false);
    await expect.poll(() => seen.draws()).toBeGreaterThan(5);
    await page.close();
  });
});
