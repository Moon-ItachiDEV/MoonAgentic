// A long answer written fast, in the built app against a real server: the page keeps up.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-flux-e2e-"));
  project = path.join(dir, "projet");
  const home = path.join(dir, "home");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
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

describe("streaming", () => {
  it("draws a fast answer a few times a second, follows it down, and ends on all of it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(project);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    // The demo agent, not a real one that may be installed on this machine.
    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");

    // Counts each time the answer's Markdown is put on the page again, and when.
    await page.evaluate(() => {
      const seen = { draws: 0, first: 0, last: 0, awayFromEnd: 0 };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver((changes) => {
        const drawn = changes.some(
          (c) => c.type === "childList" && (c.target as Element).classList?.contains("md"),
        );
        if (!drawn) return;
        seen.draws += 1;
        seen.first ||= performance.now();
        seen.last = performance.now();
        // Checked once the page has been laid out, followed and painted: a frame later.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const view = document.querySelector(".view")!;
            if (view.scrollHeight - view.scrollTop - view.clientHeight > 4) seen.awayFromEnd += 1;
          }),
        );
      }).observe(document.body, { subtree: true, childList: true });
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
            seen: { draws: number; first: number; last: number; awayFromEnd: number };
          }
        ).seen,
    );
    const seconds = (seen.last - seen.first) / 1000;
    // Nearly nine hundred words came, one at a time: the Markdown was worked out about ten
    // times a second, not once per word, and still while the answer was being written.
    expect(seen.draws).toBeGreaterThan(3);
    expect(seen.draws).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 4);
    // The reader stayed at the end of the answer all along, and is there now.
    expect(seen.awayFromEnd).toBe(0);
    const view = page.locator(".view");
    expect(
      await view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThanOrEqual(4);
    // All of it is there, to its last line.
    expect(await page.locator(".md").last().textContent()).toMatch(/return 42;\s*}\s*$/);
    await page.close();
  });
});
