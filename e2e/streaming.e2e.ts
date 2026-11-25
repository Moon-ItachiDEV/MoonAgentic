// A long answer written fast, in the built app against a real server: the page keeps up.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-flux-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      // A short wait between two words, as a model writes: the answer takes a few seconds.
      env: { ...process.env, HOME: home, USERPROFILE: home, MOONAGENTIC_DEMO_DELAY_MS: "2" },
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

/** A new project's composer, set on the demo agent, on a device `slowdown` times slower. */
async function newThread(name: string, slowdown = 1) {
  const project = path.join(dir, name.replaceAll(" ", "-"));
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
  await page.goto(url);
  await addProject(page, project);
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await pickAgent(page);
  return { page, composer };
}

describe("streaming", () => {
  // On a slow device a lot is written between two looks at the page: it still follows.
  it.each([
    ["on a fast device", 1],
    ["on a slow device", 8],
  ])(
    "draws a fast answer a few times a second, follows it down, and ends on all of it, %s",
    async (name, slowdown) => {
      const { page, composer } = await newThread(name, slowdown);

      // Counts each time the answer's Markdown is put on the page again, and when.
      await page.evaluate(() => {
        const seen = { draws: 0, grown: 0, first: 0, last: 0, awayFromEnd: 0 };
        (window as unknown as { seen: typeof seen }).seen = seen;
        new MutationObserver((changes) => {
          const drawn = changes.some(
            (c) => c.type === "childList" && (c.target as Element).classList?.contains("md"),
          );
          if (!drawn) return;
          seen.draws += 1;
          seen.first ||= performance.now();
          seen.last = performance.now();
        }).observe(document.body, { subtree: true, childList: true });
        // Whenever the answer grows, the page follows before it is painted. Looked at right
        // after the app's own watch of that growth, which is set first and so runs first:
        // looked at any later, a piece drawn meanwhile would be read before it is followed.
        const watchGrowth = () => {
          const view = document.querySelector(".view");
          const feed = document.querySelector(".feed");
          if (!view || !feed) return requestAnimationFrame(watchGrowth);
          // The app sets its watch once the thread is on the page: ours a moment after.
          setTimeout(() => {
            new ResizeObserver(() => {
              seen.grown += 1;
              if (view.scrollHeight - view.scrollTop - view.clientHeight > 4) seen.awayFromEnd += 1;
            }).observe(feed);
          }, 50);
        };
        watchGrowth();
      });

      await composer.fill("/flux");
      await page.keyboard.press("Enter");
      // The turn is over: the composer offers to send again, not to stop.
      await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(12);
      await expect.poll(() => page.locator(".md pre").count()).toBe(12);
      await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);

      const seen = await page.evaluate(
        () =>
          (
            window as unknown as {
              seen: {
                draws: number;
                grown: number;
                first: number;
                last: number;
                awayFromEnd: number;
              };
            }
          ).seen,
      );
      const seconds = (seen.last - seen.first) / 1000;
      // Nearly nine hundred words came, one at a time: the Markdown was worked out about ten
      // times a second, not once per word, and still while the answer was being written.
      expect(seen.draws).toBeGreaterThan(3);
      expect(seen.draws).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 4);
      // The reader stayed at the end of the answer all along, and is there now.
      expect(seen.grown).toBeGreaterThan(3);
      expect(seen.awayFromEnd).toBe(0);
      const view = page.locator(".view");
      expect(
        await view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      ).toBeLessThanOrEqual(4);
      // All of it is there, to its last line.
      expect(await page.locator(".md").last().textContent()).toMatch(/return 42;\s*}\s*$/);
      await page.close();
    },
  );

  it("leaves the reader where they went up to, while the answer goes on", async () => {
    const { page, composer } = await newThread("reader goes up");
    await composer.fill("/flux");
    await page.keyboard.press("Enter");
    const view = page.locator(".view");
    const fromEnd = () => view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    // Enough is written to go up in.
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBeGreaterThan(4);
    await view.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(fromEnd).toBeGreaterThan(300);
    const at = await view.evaluate((el) => el.scrollTop);
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);
    expect(await view.evaluate((el) => el.scrollTop)).toBe(at);
    // Back at the end, the next answer is followed again.
    await view.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await composer.fill("/flux");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(24);
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);
    expect(await fromEnd()).toBeLessThanOrEqual(4);
    await page.close();
  });
});
