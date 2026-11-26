// A phone's connection that dies without a word (audit of 2026-11-25, N25 and N26): the
// network changed, the box restarted, the computer lost power. The browser thinks it still
// open for half a minute, and what the user did meanwhile was lost. A relay between the
// browser and the server swallows, at a « cut », all that passes on the connections it holds;
// new ones go through as before.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, pickAgent } from "./ui.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let relay: net.Server;
/** The app's address through the relay, token included. */
let url: string;
let dir: string;
let project: string;

/** The connections the relay holds: a cut makes each swallow what it is given. */
const held = new Set<{ dead: boolean; end: () => void }>();
const cut = () => {
  for (const conn of held) conn.dead = true;
  held.clear();
};
/** While set, the relay closes each new connection at once: the server can't be reached. */
let refusing = false;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-dead-e2e-"));
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
  const direct = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+#token=\S+/.exec(out);
      if (found) resolve(found[0]);
    });
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code}).`)));
  });
  const target = new URL(direct);
  relay = net.createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    const conn = {
      dead: false,
      end: () => {
        client.destroy();
        upstream.destroy();
      },
    };
    held.add(conn);
    client.on("data", (data) => {
      if (!conn.dead) upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (!conn.dead) client.write(data);
    });
    // A swallowed connection says nothing either when it ends: as a dead route does.
    const ended = () => {
      if (conn.dead) return;
      held.delete(conn);
      conn.end();
    };
    client.on("close", ended);
    upstream.on("close", ended);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address() as net.AddressInfo;
  url = `http://127.0.0.1:${address.port}/${target.hash}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  for (const conn of held) conn.end();
  relay?.close();
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
const say = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press("Enter");
};
const idle = (page: Page) =>
  expect
    .poll(() => page.getByRole("button", { name: "Arrêter", exact: true }).count(), {
      timeout: 15_000,
    })
    .toBe(0);

describe("a connection that dies without a word", () => {
  it("still delivers the message and the « Autoriser » sent on it, once", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await addProject(page, project);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await pickAgent(page);
    // The demo agent asks before it changes a file: refused, its turn is over.
    await say(page, "Bonjour");
    await page.waitForURL(/\/t\//);
    const card = page.locator(".dc");
    await card.getByRole("button", { name: /Refuser/ }).click();
    await page.getByText("D'accord, je ne touche à rien.").waitFor();
    await idle(page);

    cut();
    await say(page, "Corrige la réponse");
    const bubble = page.locator(".uw", { hasText: "Corrige la réponse" });
    await bubble.first().waitFor({ timeout: 30_000 });
    await card.getByRole("heading", { name: "Modifier src/app.ts" }).waitFor({ timeout: 30_000 });

    cut();
    await card.getByRole("button", { name: "Autoriser cette fois" }).click();
    await page.getByText("C'est fait, la réponse vaut 42.").last().waitFor({ timeout: 30_000 });
    await idle(page);
    expect(await card.count()).toBe(0);
    // Sent again on the new connection, neither is there twice.
    await page.waitForTimeout(1_000);
    expect(await bubble.count()).toBe(1);
    expect(await page.getByText("C'est fait, la réponse vaut 42.").count()).toBe(1);
    await page.close();
  });

  it("keeps what was typed in a thread through going elsewhere, back, and a reload", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page
      .getByRole("button", { name: /^Bonjour/ })
      .first()
      .click();
    await page.waitForURL(/\/t\//);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await composer(page).fill("Moitié d'une idée");

    await page.getByRole("button", { name: "Nouvelle discussion" }).first().click();
    await expect.poll(() => composer(page).inputValue()).toBe("");
    await page.goBack();
    await page.waitForURL(/\/t\//);
    await expect.poll(() => composer(page).inputValue()).toBe("Moitié d'une idée");
    await page.reload();
    await expect.poll(() => composer(page).inputValue()).toBe("Moitié d'une idée");

    // Sent, it is not kept any more.
    await composer(page).press("Enter");
    await page.locator(".uw", { hasText: "Moitié d'une idée" }).first().waitFor();
    await page.reload();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    expect(await composer(page).inputValue()).toBe("");
    await page.close();
  });

  it("shows « Reconnexion » under the phone's top bar, not over the thread's title", async () => {
    // The thread's address, found on the computer's screen.
    const computer = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await computer.goto(url);
    await computer
      .getByRole("button", { name: /^Bonjour/ })
      .first()
      .click();
    await computer.waitForURL(/\/t\//);
    const thread = new URL(computer.url()).pathname;
    await computer.close();
    const context = await browser.newContext({ ...devices["iPhone 15 Pro"] });
    const page = await context.newPage();
    const address = new URL(url);
    address.pathname = thread;
    await page.goto(address.toString());
    const title = page.locator(".mtop .ttl");
    await title.waitFor();
    refusing = true;
    try {
      for (const conn of held) conn.end();
      held.clear();
      const pill = page.locator(".offp", { hasText: "Reconnexion" });
      await pill.waitFor({ timeout: 15_000 });
      const over = (await title.boundingBox())!;
      const shown = (await pill.boundingBox())!;
      expect(shown.y).toBeGreaterThanOrEqual(over.y + over.height);
    } finally {
      refusing = false;
    }
    await page.locator(".offp").waitFor({ state: "detached", timeout: 30_000 });
    await context.close();
  });
});
