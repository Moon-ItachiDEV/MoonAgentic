// The app as a phone installs it: its manifest, its PNG icons, and what iOS reads.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pwa-e2e-"));
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

describe("installable app", () => {
  it("serves a manifest with PNG icons a phone can use, and the iPhone's own tags", async () => {
    const origin = new URL(url).origin;
    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    const app = (await manifest.json()) as {
      display: string;
      start_url: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    expect(app.display).toBe("standalone");
    expect(app.start_url).toBe("/");
    // Android needs 192 and 512 pixel PNGs, and a maskable one.
    const png = app.icons.filter((i) => i.type === "image/png");
    expect(png.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
    for (const icon of [...png.map((i) => i.src), "/apple-touch-icon.png"]) {
      const res = await fetch(`${origin}${icon}`);
      expect(res.status, icon).toBe(200);
      expect(res.headers.get("content-type"), icon).toBe("image/png");
      // A real PNG, whatever its name says.
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(String.fromCharCode(...bytes.subarray(1, 4)), icon).toBe("PNG");
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(url);
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', "href")).toBe(
      "/apple-touch-icon.png",
    );
    expect(await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content")).toBe(
      "yes",
    );
    await page.close();
  });
});
