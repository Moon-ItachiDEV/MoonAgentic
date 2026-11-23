// MCP servers by project, in the built app against a real server: who is given one.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
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

/** Asks the demo agent something in a new thread of that project; resolves once it answered. */
async function ask(page: Page, project: string, text: string) {
  await page.getByRole("button", { name: `Nouvelle discussion dans ${project}` }).click();
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await page.locator(".agentchip").click();
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
  await page.keyboard.press("Escape");
  const sub = (await page.locator(".greet-sub").textContent()) ?? "";
  await composer.fill(text);
  await composer.press("Enter");
  const answer = page.getByText(`Tu m'as demandé : « ${text} »`);
  await answer.waitFor();
  return { sub, answer: (await answer.textContent()) ?? "" };
}

const openServers = async (page: Page) => {
  await page.getByRole("button", { name: "Réglages" }).click();
  await page.getByRole("button", { name: "Serveurs MCP" }).click();
  await page.getByRole("button", { name: "Gérer les serveurs MCP" }).click();
  return page.getByRole("dialog", { name: "Serveurs MCP" });
};

describe("serveurs MCP par projet", () => {
  it("gives a server to the threads of the projects picked, and says for whom it is", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    let dialog = await openServers(page);
    // Added for one project from the start.
    await dialog.getByLabel("Nom").fill("fichiers");
    await dialog.getByLabel("Commande ou adresse").fill("npx -y serveur-fichiers");
    await dialog.getByRole("radio", { name: "Seulement certains" }).check();
    await dialog.getByText("Coche au moins un projet").waitFor();
    await dialog.getByRole("checkbox", { name: "Alpha" }).check();
    expect(await dialog.getByText("Coche au moins un projet").count()).toBe(0);
    await shot(page, "s1-ajout");
    await dialog.getByRole("button", { name: "Ajouter", exact: true }).click();
    const forWhom = dialog.getByRole("button", { name: /Pour qui est fichiers/ });
    await forWhom.waitFor();
    expect(await forWhom.textContent()).toBe("Pour : Alpha");
    await dialog.getByRole("button", { name: "Fermer" }).click();
    // The settings say it too.
    await page.getByText("Commande · npx -y serveur-fichiers · Alpha").waitFor();
    await page.getByRole("button", { name: "Retour" }).click();

    // A thread of that project gets it, a thread of the other does not, and the home page
    // counts what a thread started there would get.
    const inAlpha = await ask(page, "Alpha", "Un");
    expect(inAlpha.sub).toContain("1 serveur MCP");
    expect(inAlpha.answer).toContain("Serveurs MCP reçus : fichiers.");
    const inBeta = await ask(page, "Beta", "Deux");
    expect(inBeta.sub).not.toContain("MCP");
    expect(inBeta.answer).not.toContain("Serveurs MCP reçus");

    // Changed in its row: for every project, and for a team's every role.
    dialog = await openServers(page);
    await dialog.getByRole("button", { name: /Pour qui est fichiers/ }).click();
    expect(await dialog.getByRole("checkbox", { name: "Alpha" }).isChecked()).toBe(true);
    expect(await dialog.getByRole("checkbox", { name: "Beta" }).isChecked()).toBe(false);
    await shot(page, "s1-pour-qui");
    await dialog.getByRole("radio", { name: "Tous les projets" }).check();
    await dialog.getByRole("checkbox", { name: /relecteurs, testeurs et fusionneurs/ }).check();
    await expect
      .poll(() => dialog.getByRole("button", { name: /Pour qui est fichiers/ }).textContent())
      .toBe("Pour : Tous les projets · toute l'équipe");
    await dialog.getByRole("button", { name: "Fermer" }).click();
    await page.getByRole("button", { name: "Retour" }).click();
    const again = await ask(page, "Beta", "Trois");
    expect(again.sub).toContain("1 serveur MCP");
    expect(again.answer).toContain("Serveurs MCP reçus : fichiers.");

    // Kept by the server: still so after the page is loaded again.
    await page.reload();
    dialog = await openServers(page);
    expect(await dialog.getByRole("button", { name: /Pour qui est fichiers/ }).textContent()).toBe(
      "Pour : Tous les projets · toute l'équipe",
    );
    await page.close();
  });

  it("fits the choice of projects on a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    // From the connections, one press away on a phone.
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Connexions" }).click();
    await page.getByRole("button", { name: "Gérer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Serveurs MCP" });
    await dialog.getByRole("button", { name: /Pour qui est fichiers/ }).click();
    await dialog.getByRole("radio", { name: "Seulement certains" }).check();
    await dialog.getByRole("checkbox", { name: "Beta" }).check();
    await expect
      .poll(() => dialog.getByRole("button", { name: /Pour qui est fichiers/ }).textContent())
      .toBe("Pour : Beta · toute l'équipe");
    await shot(page, "s1-telephone");
    // Nothing is wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.close();
  });
});
