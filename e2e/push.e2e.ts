// Web Push in the built app: turned on in the settings once notifications are, kept by the
// server for this browser, and shown by the service worker when a push arrives.
import { type ChildProcess, spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-push-e2e-"));
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
 * The test browser reaches no push service: its subscription is played here, with keys made
 * as a browser makes them, so the server takes it as a real one.
 */
function fakePush(endpoint: string, p256dh: string, auth: string) {
  return `(() => {
    let current = null;
    const make = (key) => ({
      endpoint: ${JSON.stringify(endpoint)},
      options: { applicationServerKey: key.buffer },
      toJSON: () => ({ endpoint: ${JSON.stringify(endpoint)}, keys: { p256dh: ${JSON.stringify(p256dh)}, auth: ${JSON.stringify(auth)} } }),
      unsubscribe: async () => { current = null; localStorage.removeItem("e2e.push"); return true; },
    });
    PushManager.prototype.getSubscription = async () => {
      const kept = localStorage.getItem("e2e.push");
      if (kept && !current) current = make(new Uint8Array(JSON.parse(kept)));
      return current;
    };
    PushManager.prototype.subscribe = async (options) => {
      const key = new Uint8Array(options.applicationServerKey);
      localStorage.setItem("e2e.push", JSON.stringify([...key]));
      current = make(key);
      return current;
    };
  })();`;
}

describe("web push", () => {
  it("is turned on for this browser, and its service worker shows what arrives", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await context.grantPermissions(["notifications"]);
    const ecdh = createECDH("prime256v1");
    await context.addInitScript(
      fakePush(
        "https://fcm.googleapis.com/fcm/send/e2e",
        ecdh.generateKeys().toString("base64url"),
        randomBytes(16).toString("base64url"),
      ),
    );
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await page.getByRole("button", { name: "Réglages" }).first().click();
    const push = page.getByRole("switch", { name: "Recevoir quand l'app est fermée" });
    // Only once notifications are on.
    await page.getByRole("switch", { name: "Notifications", exact: true }).waitFor();
    expect(await push.count()).toBe(0);
    await page.getByRole("switch", { name: "Notifications", exact: true }).click();
    await push.waitFor();
    expect(await push.getAttribute("aria-checked")).toBe("false");
    await push.click();
    await expect.poll(() => push.getAttribute("aria-checked")).toBe("true");
    if (shots) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "push-reglage.png") });
    }
    // The server says it reaches this browser: still on after a reload.
    await page.reload();
    await expect.poll(() => push.getAttribute("aria-checked")).toBe("true");

    // A push arriving while the app is closed: the service worker shows it.
    const origin = new URL(url).origin;
    const blank = await context.newPage();
    const cdp = await context.newCDPSession(blank);
    const registered = new Promise<string>((resolve) => {
      cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        const mine = registrations.find((r) => r.scopeURL.startsWith(origin) && !r.isDeleted);
        if (mine) resolve(mine.registrationId);
      });
    });
    await cdp.send("ServiceWorker.enable");
    const registrationId = await registered;
    // Chromium forgets a notification for good when its list is read while it is being shown
    // (see notifications.e2e.ts), which takes longer on Windows: the service worker counts the
    // ones it has shown, and the list is read once it has shown this one.
    await expect
      .poll(() => context.serviceWorkers().some((w) => w.url().startsWith(origin)))
      .toBe(true);
    const worker = context.serviceWorkers().find((w) => w.url().startsWith(origin))!;
    await worker.evaluate(() => {
      const scope = self as unknown as { __shown: number; registration: ServiceWorkerRegistration };
      const show = ServiceWorkerRegistration.prototype.showNotification;
      scope.__shown = 0;
      ServiceWorkerRegistration.prototype.showNotification = async function (...args) {
        await show.apply(this, args);
        scope.__shown++;
      };
    });
    await page.close();
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId,
      data: JSON.stringify({
        title: "Attend ta réponse",
        body: "Corrige la réponse",
        tag: "t1:waiting",
        threadId: "t1",
      }),
    });
    await expect
      .poll(() => worker.evaluate(() => (self as unknown as { __shown: number }).__shown))
      .toBe(1);
    const again = await context.newPage();
    await again.goto(new URL("/reglages", url).href);
    await expect
      .poll(() => shown(again))
      .toEqual([{ title: "Attend ta réponse", body: "Corrige la réponse", tag: "t1:waiting" }]);

    // Turned off, the server forgets this browser.
    const off = again.getByRole("switch", { name: "Recevoir quand l'app est fermée" });
    await expect.poll(() => off.getAttribute("aria-checked")).toBe("true");
    await off.click();
    await expect.poll(() => off.getAttribute("aria-checked")).toBe("false");
    await again.reload();
    await off.waitFor();
    expect(await off.getAttribute("aria-checked")).toBe("false");
    expect(errors).toEqual([]);
    await context.close();
  });
});
