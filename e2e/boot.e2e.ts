// The page before the app: an iPhone app on the home screen that cannot load the app's
// files must say so, never stay white.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, devices } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let origin: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-boot-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  origin = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /(http:\/\/\S+?)\/#token=\S+/.exec(out);
      if (found) resolve(found[1]!);
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

/** A phone with nothing stored: an app just put on the home screen, never paired. */
const freshPhone = () => browser.newContext({ ...devices["iPhone 13"] });

describe("before the app", () => {
  it("leaves the page to the app once it loads: a phone never paired sees the pairing", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await expect.poll(() => page.getByText("Appairer cet appareil").isVisible()).toBe(true);
    expect(await page.locator("#boot").count()).toBe(0);
    await context.close();
  });

  it("fetches the page again once when a file of the app is missing", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    let missing = 0;
    // The first load asks for an app file the server no longer has, as an older page would.
    await page.route(/\/assets\/index-[^/]+\.js$/, (route) => {
      missing += 1;
      return missing === 1 ? route.fulfill({ status: 404, body: "" }) : route.continue();
    });
    await page.goto(`${origin}/`);
    await expect.poll(() => page.getByText("Appairer cet appareil").isVisible()).toBe(true);
    expect(missing).toBe(2);
    await context.close();
  });

  it("says what failed instead of a white page when the file stays missing", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    await page.route(/\/assets\/index-[^/]+\.js$/, (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await page.goto(`${origin}/`);
    const failed = page.getByText("MoonAgentic ne s'est pas chargé.");
    await expect.poll(() => failed.isVisible()).toBe(true);
    expect(await page.locator("#boot-why").textContent()).toMatch(
      /^Fichier non chargé : \/assets\/index-.+\.js$/,
    );
    await expect.poll(() => page.getByRole("link", { name: "Recharger" }).isVisible()).toBe(true);
    // Not white: the screen has the app's background, in light or dark.
    const background = await page.evaluate(
      () => getComputedStyle(document.getElementById("boot")!).backgroundColor,
    );
    expect(background).not.toBe("rgb(255, 255, 255)");
    await context.close();
  });

  it("says it after a while when nothing comes at all", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    // The app's code never answers: no error, no page.
    await page.route(/\/assets\/index-[^/]+\.js$/, () => new Promise(() => {}));
    await page.goto(`${origin}/`, { waitUntil: "commit" });
    const failed = page.getByText("MoonAgentic ne s'est pas chargé.");
    expect(await failed.isVisible()).toBe(false);
    await expect.poll(() => failed.isVisible(), { timeout: 15_000 }).toBe(true);
    await context.close();
  });

  it("leaves the app alone once shown: a part that fails later does not reload it", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    let loads = 0;
    page.on("load", () => (loads += 1));
    await page.goto(`${origin}/`);
    await expect.poll(() => page.getByText("Appairer cet appareil").isVisible()).toBe(true);
    // As a lazy screen of an older build would, after an update of the server.
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = "/assets/gone-0000.js";
      document.head.append(script);
    });
    await page.waitForTimeout(1000);
    expect(loads).toBe(1);
    expect(await page.getByText("Appairer cet appareil").isVisible()).toBe(true);
    await context.close();
  });

  it("does not reload for an icon or the manifest that fails", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    let loads = 0;
    page.on("load", () => (loads += 1));
    await page.route(
      /\/(manifest\.webmanifest|icon\.svg|apple-touch-icon\.png)(\?v=\d+)?$/,
      (route) => route.fulfill({ status: 404, body: "" }),
    );
    await page.goto(`${origin}/`);
    await expect.poll(() => page.getByText("Appairer cet appareil").isVisible()).toBe(true);
    await page.waitForTimeout(500);
    expect(loads).toBe(1);
    await context.close();
  });

  it("keeps the address on « Recharger », a pairing code included", async () => {
    const context = await freshPhone();
    const page = await context.newPage();
    await page.route(/\/assets\/index-[^/]+\.js$/, (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await page.goto(`${origin}/t/abc#pair=ABCD-EFGH`);
    const reload = page.getByRole("link", { name: "Recharger" });
    await expect.poll(() => reload.isVisible()).toBe(true);
    await Promise.all([page.waitForEvent("load"), reload.click()]);
    expect(page.url()).toBe(`${origin}/t/abc#pair=ABCD-EFGH`);
    await context.close();
  });

  it("never lets a browser keep the page itself", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
