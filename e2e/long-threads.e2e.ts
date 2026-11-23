// Long threads in the built app, against a real server: what is heavy comes when asked for.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../apps/server/src/store.ts";

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
  seedLongThread();
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

/** How many times the user spoke in the long thread: each time, the agent answered. */
const TURNS = 300;

/** A thread of 600 messages, in the database before the server starts. */
function seedLongThread(): void {
  const folder = path.join(dir, "long");
  mkdirSync(folder);
  mkdirSync(path.join(dir, "data"));
  const store = new Store(path.join(dir, "data", "state.sqlite"));
  store.addProject({ id: "long", name: "Archives", path: folder, createdAt: 1 });
  store.addThread({
    id: "long-fil",
    projectId: "long",
    title: "Long fil",
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    createdAt: 1,
    updatedAt: 1,
  });
  store.db.exec("BEGIN");
  for (let n = 1; n <= TURNS; n++) {
    const about = n === 7 ? " : où est la licorne ?" : " ?";
    store.putItem("long-fil", { id: `q${n}`, kind: "user", text: `Question ${n}${about}`, at: n });
    store.putItem("long-fil", {
      id: `a${n}`,
      kind: "agent",
      text: `Réponse ${n}.\n\nElle tient en deux paragraphes, pour prendre un peu de place.`,
      at: n,
    });
  }
  store.db.exec("COMMIT");
  store.close();
}

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

  it("opens a long thread by its end, fetches what is before a page at a time, and keeps it all when the connection comes back", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const received: string[] = [];
    const sent: { type: string; since?: object; reach?: string }[] = [];
    const sockets: { close: () => Promise<void> }[] = [];
    await page.routeWebSocket(/\/ws\b/, (socket) => {
      const server = socket.connectToServer();
      sockets.push(socket);
      socket.onMessage((data) => {
        sent.push(JSON.parse(String(data)) as (typeof sent)[number]);
        server.send(data);
      });
      server.onMessage((data) => {
        received.push(String(data));
        socket.send(data);
      });
    });
    const got = (type: string) => received.filter((f) => f.includes(`"type":"${type}"`));
    await page.goto(url);
    await page.getByText("Long fil").first().click();
    const view = page.locator(".view");
    const question = (n: number) => page.getByText(`Question ${n} ?`, { exact: true });
    const top = (n: number) => question(n).evaluate((el) => el.getBoundingClientRect().top);
    const messages = () => page.locator(".feed > .item").count();

    // The last 60 turns came, 120 messages of 600, and the page is at its end.
    await question(TURNS).waitFor();
    expect(await messages()).toBe(120);
    expect(got("items")).toHaveLength(1);
    expect(got("items")[0]).toContain("Question 241 ?");
    expect(got("items")[0]).not.toContain("Question 240 ?");
    expect(
      await view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThanOrEqual(4);
    expect(got("page")).toHaveLength(0);

    // Going up to the first message shown fetches the page before it, and that message
    // stays where it was on screen.
    await view.evaluate((el) => el.scrollTo(0, 0));
    const before = await top(241);
    await question(181).waitFor({ state: "attached" });
    expect(await messages()).toBe(240);
    expect(Math.abs((await top(241)) - before)).toBeLessThanOrEqual(2);
    expect(got("page")).toHaveLength(1);
    // The button asks for the next one.
    await page.getByRole("button", { name: "Afficher les messages précédents" }).click();
    await question(121).waitFor({ state: "attached" });
    await expect.poll(messages).toBe(360);
    expect(got("page")).toHaveLength(2);

    // A message found by the search, from before what is here, is fetched with all that
    // follows it, and shown.
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Rechercher" }).fill("licorne");
    await page.getByRole("option", { name: /licorne/ }).click();
    const found = page.locator('[data-item="q7"]');
    await found.waitFor();
    await expect.poll(() => found.evaluate((el) => el.classList.contains("flash"))).toBe(true);
    expect(sent.filter((m) => m.type === "thread.page").map((m) => m.reach)).toContain("q7");
    // It is near the start: the little that is before it comes too, and it stays in sight.
    await expect.poll(messages).toBe(600);
    expect(await page.getByRole("button", { name: /messages précédents/ }).count()).toBe(0);
    const y = await found.evaluate((el) => el.getBoundingClientRect().top);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(820);
    const held = 600;

    // The connection drops and comes back: the thread is asked for from where the screen
    // is, nothing is sent again, and the reader is still on the message found.
    const at = await view.evaluate((el) => el.scrollTop);
    await sockets[0]!.close();
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => got("changes").length, { timeout: 15_000 }).toBe(1);
    expect(sent.findLast((m) => m.type === "thread.open")?.since).toMatchObject({ first: 1 });
    expect(got("changes")[0]).toContain('"items":[]');
    expect(got("items")).toHaveLength(1);
    expect(await messages()).toBe(held);
    expect(await view.evaluate((el) => el.scrollTop)).toBe(at);

    // What is written next comes at the end, as before.
    await page.getByRole("combobox", { name: "Message" }).fill("Et maintenant ?");
    await page.keyboard.press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    expect(got("items")).toHaveLength(1);
    await page.close();
  });
});
