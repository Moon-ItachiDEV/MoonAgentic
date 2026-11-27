// Long threads in the built app, against a real server: what is heavy comes when asked for.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent, setAccess } from "./ui.ts";
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
  // An answer of 300 KB, as an agent gives a whole report.
  store.addThread({
    id: "gros-fil",
    projectId: "long",
    title: "Gros rapport",
    agentId: "demo",
    status: "idle",
    permissionMode: "full",
    createdAt: 2,
    updatedAt: 2,
  });
  store.putItem("gros-fil", { id: "q", kind: "user", text: "Fais le rapport complet", at: 1 });
  const parts = Array.from(
    { length: 3_000 },
    (_, n) => `Paragraphe ${n + 1} du rapport, avec \`fichier${n}.ts\` et **un point** à voir.`,
  );
  store.putItem("gros-fil", {
    id: "a",
    kind: "agent",
    text: [...parts, "Fin du rapport : tout est vert."].join("\n\n"),
    at: 2,
  });
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
    await addProject(page, project);
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    // The demo agent, not a real one that may be installed on this machine.
    await pickAgent(page);
    await setAccess(page, /Accès complet/);

    await composer.fill("Lis le gros fichier");
    await composer.press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    // The file's 1,200 lines never came with the timeline.
    expect(frames.some((f) => f.includes("ligne600"))).toBe(false);

    await page.reload();
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    await page.locator(".det .fold").last().click();
    const read = page.locator(".tl", { hasText: "Lire src/app.ts" });
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
    const edit = page.locator(".tl", { hasText: "Modifier src/app.ts" });
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
    // Drawn from its end, the rest above a moment after.
    await expect.poll(messages).toBe(120);
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
    // The button asks for the next one. Pressed without being scrolled to: brought into sight,
    // it would fetch a page by itself first, and the press, once the button is enabled again,
    // a second one (seen on Windows, which is slower to press).
    await page
      .getByRole("button", { name: "Afficher les messages précédents" })
      .dispatchEvent("click");
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

  // Audit of 2026-11-25, N16: the whole thread in one answer held the server for 0.7 s.
  it("exports a long thread whole, asking for it by pages the screen does not show", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const sent: { type: string; apart?: boolean; size?: number }[] = [];
    await page.routeWebSocket(/\/ws\b/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((data) => {
        sent.push(JSON.parse(String(data)) as (typeof sent)[number]);
        server.send(data);
      });
    });
    await page.goto(url);
    await page.getByText("Long fil").first().click();
    await page.getByText(`Question ${TURNS} ?`, { exact: true }).waitFor();
    const messages = () => page.locator(".feed > .item").count();
    // Drawn from its end: what is above has all come once the count holds.
    await expect
      .poll(async () => {
        const now = await messages();
        await page.waitForTimeout(300);
        return now === (await messages());
      })
      .toBe(true);
    const shown = await messages();

    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    const download = page.waitForEvent("download");
    await composer.fill("/exporter");
    await composer.press("Enter");
    const file = await (await download).path();
    const markdown = readFileSync(file, "utf8");
    for (const n of [1, 7, 240, 241, TURNS]) expect(markdown).toContain(`Question ${n}`);
    expect(markdown.match(/Réponse \d+\./g)?.length).toBeGreaterThanOrEqual(TURNS);
    // Asked for by pages, kept apart: the screen still shows what it did.
    const pages = sent.filter((m) => m.type === "thread.page");
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((m) => m.apart === true && m.size === 1000)).toBe(true);
    expect(sent.some((m) => m.type === "thread.read")).toBe(false);
    expect(await messages()).toBe(shown);
    await page.close();
  });
  it("draws the start of a very long answer, the rest when asked, and leaves what is far out of sight unpainted (audit N35)", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.goto(new URL("/t/gros-fil", url).href);
    const answer = page.locator('.feed [data-item="a"]');
    await answer.getByText("Paragraphe 1 du rapport", { exact: false }).first().waitFor();
    const more = answer.getByRole("button", { name: "Afficher la suite" });
    await more.waitFor();
    expect(await answer.getByText("Fin du rapport").count()).toBe(0);
    // Some 3,000 paragraphs would be 3,000 nodes and more: a few hundred are drawn.
    expect(await answer.evaluate((el) => el.querySelectorAll("*").length)).toBeLessThan(2_000);
    expect(await answer.evaluate((el) => getComputedStyle(el).contentVisibility)).toBe("auto");
    await more.tap();
    await answer.getByText("Fin du rapport : tout est vert.").waitFor();
    expect(await more.count()).toBe(0);
    await context.close();
  });
});
