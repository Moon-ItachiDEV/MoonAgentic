// A database that refuses writes, in the built app against a real server: another program
// holds the file, the app says on every page that nothing is saved, and stops saying it once
// the file is let go. The server stays up all along.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let output = "";

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-storage-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  mkdirSync(path.join(dir, "projet"));
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  url = await new Promise<string>((resolve, reject) => {
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const found = /http:\/\/\S+#token=\S+/.exec(output);
      if (found) resolve(found[0]);
    };
    server.stdout?.on("data", read);
    server.stderr?.on("data", read);
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

describe("a database another program holds", () => {
  it("is said on the page while nothing is saved, and no longer once it is let go", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().waitFor();
    const pill = page.locator(".offp.unsaved");
    expect(await pill.count()).toBe(0);

    // As a copy or an SQLite tool does: the write lock, kept for a while.
    const other = new DatabaseSync(path.join(dir, "data", "state.sqlite"));
    other.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    try {
      // Anything the app saves meanwhile is refused: here, a project added from the page's
      // own connection.
      await page.evaluate(
        async ({ token, projectPath }) => {
          const answer = await fetch("/api/ws-ticket", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          const { ticket } = (await answer.json()) as { ticket: string };
          const socket = new WebSocket(`ws://${location.host}/ws?ticket=${ticket}`);
          await new Promise((opened) => socket.addEventListener("open", opened, { once: true }));
          socket.send(
            JSON.stringify({
              type: "project.create",
              requestId: "e2e",
              name: "Projet",
              path: projectPath,
            }),
          );
        },
        { token: new URL(url).hash.replace("#token=", ""), projectPath: path.join(dir, "projet") },
      );

      await pill.waitFor({ timeout: 15_000 });
      expect(await pill.textContent()).toBe(
        "Base verrouillée par un autre programme : plus rien n'est enregistré",
      );
      // A screen that opens meanwhile is told too, from its first message.
      const late = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await late.goto(url);
      await late.locator(".offp.unsaved").waitFor({ timeout: 15_000 });
      await late.close();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }

    await pill.waitFor({ state: "detached", timeout: 15_000 });
    expect(server.exitCode).toBeNull();
    expect(output).not.toMatch(/Erreur imprévue|redémarre/);
    await page.close();
  });
});
