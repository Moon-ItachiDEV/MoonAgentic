// MCP servers by project, in the built app against a real server: who is given one.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { pickAgent } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../apps/server/src/store.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-mcp-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  // Two projects, in the database before the server starts.
  mkdirSync(path.join(dir, "data"));
  const store = new Store(path.join(dir, "data", "state.sqlite"));
  for (const [n, name] of ["Alpha", "Beta"].entries()) {
    mkdirSync(path.join(dir, name));
    store.addProject({ id: name.toLowerCase(), name, path: path.join(dir, name), createdAt: n });
  }
  store.close();
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

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/**
 * Asks the demo agent something in a new thread of that project; resolves once it answered.
 * Before it is sent, the « + » menu says how many servers a thread started there would get.
 */
async function ask(page: Page, project: string, text: string) {
  await page
    .getByRole("complementary", { name: "Menu" })
    .getByRole("button", { name: new RegExp(`^${project}`) })
    .click();
  await page.waitForURL(/\/p\//);
  await page.getByRole("button", { name: "Nouveau fil" }).first().click();
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await pickAgent(page);
  await composer.click();
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  const servers = (await page.getByRole("menuitem", { name: /^Serveurs MCP/ }).textContent()) ?? "";
  await page.keyboard.press("Escape");
  await composer.fill(text);
  await composer.press("Enter");
  const answer = page.getByText(`Tu m'as demandé : « ${text} »`);
  await answer.waitFor();
  return { servers, answer: (await answer.textContent()) ?? "" };
}

/** Réglages › Connexions et MCP, where the servers are listed. */
const openServers = async (page: Page) => {
  await page.getByRole("button", { name: "Réglages" }).click();
  await page
    .getByRole("navigation", { name: "Réglages" })
    .getByRole("button", { name: "Connexions et MCP" })
    .click();
  return page.getByRole("region", { name: "Connexions et MCP" });
};
const closeSettings = (page: Page) =>
  page.getByRole("button", { name: "Fermer les réglages" }).click();

describe("serveurs MCP par projet", () => {
  it("gives a server to the threads of the projects picked, and says for whom it is", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    let list = await openServers(page);
    // Added for one project from the start.
    await list.getByRole("button", { name: "Ajouter un serveur" }).click();
    const add = page.getByRole("dialog", { name: "Ajouter un serveur" });
    await add.getByLabel("Nom").fill("fichiers");
    await add.getByLabel("Commande", { exact: true }).fill("npx -y serveur-fichiers");
    await add.getByRole("button", { name: "Projets : Tous les projets" }).click();
    await add.getByRole("button", { name: "Alpha", exact: true }).click();
    await add.getByRole("button", { name: "Projets : Alpha" }).waitFor();
    await shot(page, "s1-ajout");
    await add.getByRole("button", { name: "Ajouter", exact: true }).click();
    // The settings say for whom it is.
    const row = list.getByRole("button", { name: /^fichiers/ });
    await row.waitFor();
    expect(await row.locator("small").textContent()).toBe("Alpha");
    await closeSettings(page);

    // A thread of that project gets it, a thread of the other does not, and the « + » menu
    // counts what a thread started there would get.
    const inAlpha = await ask(page, "Alpha", "Un");
    expect(inAlpha.servers).toBe("Serveurs MCP1");
    expect(inAlpha.answer).toContain("Serveurs MCP reçus : fichiers.");
    const inBeta = await ask(page, "Beta", "Deux");
    expect(inBeta.servers).toBe("Serveurs MCP");
    expect(inBeta.answer).not.toContain("Serveurs MCP reçus");

    // Changed in its sheet: for every project, and for a team's every role.
    list = await openServers(page);
    await row.click();
    const sheet = page.getByRole("dialog", { name: "fichiers" });
    await sheet.getByRole("button", { name: "Projets : Alpha" }).click();
    const pressed = (name: string) =>
      sheet.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
    expect(await pressed("Alpha")).toBe("true");
    expect(await pressed("Beta")).toBe("false");
    await shot(page, "s1-pour-qui");
    await sheet.getByRole("button", { name: "Tous les projets", exact: true }).click();
    await sheet.getByRole("switch", { name: /relecteurs, testeurs et fusionneurs/ }).click();
    await expect
      .poll(() => row.locator("small").textContent())
      .toBe("Tous les projets · toute l'équipe");
    await sheet.getByRole("button", { name: "Fermer", exact: true }).click();
    await closeSettings(page);
    const again = await ask(page, "Beta", "Trois");
    expect(again.servers).toBe("Serveurs MCP1");
    expect(again.answer).toContain("Serveurs MCP reçus : fichiers.");

    // Kept by the server: still so after the page is loaded again.
    await page.reload();
    list = await openServers(page);
    await expect
      .poll(() => row.locator("small").textContent())
      .toBe("Tous les projets · toute l'équipe");
    await page.close();
  });

  it("lists a server's tools, and gives it only to the agents picked", async () => {
    // A real server, started by a command: it lists its tools when asked.
    const script = path.join(dir, "outils.cjs");
    writeFileSync(
      script,
      `const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: {} }
    : { tools: [{ name: "browser_click", description: "Clique" }, { name: "browser_type" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`,
    );
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const list = await openServers(page);
    await list.getByRole("button", { name: "Ajouter un serveur" }).click();
    const add = page.getByRole("dialog", { name: "Ajouter un serveur" });
    await add.getByLabel("Nom").fill("navigateur");
    await add.getByLabel("Commande", { exact: true }).fill(`node ${script}`);
    await add.getByRole("button", { name: "Ajouter", exact: true }).click();
    const row = list.getByRole("button", { name: /^navigateur/ });
    await row.click();
    const sheet = page.getByRole("dialog", { name: "navigateur" });
    await sheet.getByRole("button", { name: /^Outils/ }).click();
    const tools = sheet.getByLabel("Outils de navigateur");
    await tools.getByText("browser_click").waitFor({ timeout: 30_000 });
    await tools.getByText("browser_type").waitFor();
    await sheet.getByRole("button", { name: /^Outils\s*2/ }).waitFor();
    // Every agent gets it until one is left out.
    const demo = sheet.getByRole("switch", { name: "Donner à Agent de démo" });
    expect(await demo.getAttribute("aria-checked")).toBe("true");
    await demo.click();
    await expect.poll(() => demo.getAttribute("aria-checked")).toBe("false");
    await shot(page, "s3-outils-agents");
    await expect.poll(() => row.locator("small").textContent()).not.toBe("Tous les projets");
    await sheet.getByRole("button", { name: "Fermer", exact: true }).click();
    await closeSettings(page);
    // The demo agent's threads no longer get it, and its « + » menu does not count it.
    const inAlpha = await ask(page, "Alpha", "Quatre");
    expect(inAlpha.answer).not.toContain("navigateur");
    await page.close();
  });

  it("fits the choice of projects on a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    // From the composer's « + », one press away on a phone.
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Serveurs MCP/ }).click();
    await page.getByRole("button", { name: /^fichiers/ }).click();
    const sheet = page.getByRole("dialog", { name: "fichiers" });
    await sheet.getByRole("button", { name: /^Projets : / }).click();
    await sheet.getByRole("button", { name: "Beta", exact: true }).click();
    await sheet.getByRole("button", { name: "Projets : Beta", exact: true }).waitFor();
    await shot(page, "s1-telephone");
    // Nothing is wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const box = await sheet.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.close();
  });
});
