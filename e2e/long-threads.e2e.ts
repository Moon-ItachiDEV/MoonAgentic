// Long threads in the built app, against a real server: what is heavy comes when asked for.
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-longs-e2e-"));
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
      env: { ...process.env, HOME: home, USERPROFILE: home },
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

describe("longs fils", () => {
  it("leaves a tool's large result on the server until its line is opened", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // What the server sends for the thread's timeline, as the page receives it.
    const frames: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => frames.push(String(frame.payload))),
    );
    // The first time a whole result is asked for, the answer is a failure.
    let refusals = 1;
    await page.routeWebSocket(/\/ws\b/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((data) => {
        const message = JSON.parse(String(data)) as { type: string; requestId?: string };
        if (message.type !== "item.get" || refusals-- <= 0) return server.send(data);
        socket.send(
          JSON.stringify({
            type: "error",
            requestId: message.requestId,
            message: "Connexion perdue.",
          }),
        );
      });
    });
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
    await page.getByRole("button", { name: /Mode d'accès/ }).click();
    await page.getByRole("menuitemradio", { name: /Accès complet/ }).click();

    await composer.fill("Lis le gros fichier");
    await composer.press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    // The file's 1,200 lines never came with the timeline.
    expect(frames.some((f) => f.includes("ligne600"))).toBe(false);

    await page.reload();
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    await page.locator(".team-detail-h").last().click();
    const read = page.locator(".tool", { hasText: "Lire src/app.ts" });
    await read.getByRole("button", { name: /Lire src\/app\.ts/ }).click();
    // A result that could not be fetched says so, and can be asked for again.
    await read.getByRole("alert").getByText("Connexion perdue.").waitFor();
    expect(frames.some((f) => f.includes("ligne600"))).toBe(false);
    await read.getByRole("button", { name: "Réessayer" }).click();
    // Opened, the line fetches its result and draws its first lines only.
    await read.getByText("export const ligne1 = 1;").waitFor();
    expect(await read.getByRole("alert").count()).toBe(0);
    expect(frames.some((f) => f.includes("ligne600"))).toBe(true);
    expect(await read.getByText("export const ligne400 = 400;").count()).toBe(1);
    expect(await read.getByText("export const ligne401 = 401;").count()).toBe(0);
    await read.getByRole("button", { name: "Afficher tout (800 lignes de plus)" }).click();
    await read.getByText("export const ligne1200 = 1200;").waitFor();
    // A small result came with its line: nothing to wait for.
    const edit = page.locator(".tool", { hasText: "Modifier src/app.ts" });
    await edit.getByRole("button", { name: /Modifier src\/app\.ts/ }).click();
    await edit.getByText("+ export const answer = 42;").waitFor();
    await page.close();
  });
});
