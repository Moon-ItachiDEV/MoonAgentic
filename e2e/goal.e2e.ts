// A goal in the built app against a real server: « /goal » starts a thread that works toward
// it turn after turn, shown above the composer, with pause, take up again and drop.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-goal-e2e-"));
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

/** A new project's composer, set on the demo agent, which asks before it acts. */
async function newThread(name: string) {
  const project = path.join(dir, name);
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
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
  return { page, composer };
}

describe("goal", () => {
  it("starts a thread on a goal, follows it turn by turn, and is taken up again", async () => {
    const { page, composer } = await newThread("objectif");
    // Let through, so each turn ends by itself.
    await page.getByRole("button", { name: /Mode d'accès/ }).click();
    await page.getByRole("menuitemradio", { name: /Accès complet/ }).click();
    const said = () => page.locator(".u-wrap").allTextContents();

    // Picked in the list, the command waits for the goal after it.
    await composer.fill("/go");
    await page.getByRole("option", { name: /goal/ }).first().click();
    expect(await composer.inputValue()).toBe("/goal ");
    await composer.pressSequentially("Les tests passent, atteint au tour 3");
    await composer.press("Enter");

    // A thread of its own, which goes on by itself until the agent says it is reached.
    const bar = page.getByRole("region", { name: "Objectif" });
    await bar.getByText("Objectif atteint en 3 tours").waitFor({ timeout: 20_000 });
    expect(await bar.locator(".cg-t").textContent()).toBe("Les tests passent, atteint au tour 3");
    await expect.poll(async () => (await said()).length).toBe(3);
    const lines = await said();
    expect(lines[0]).toContain("Les tests passent, atteint au tour 3");
    expect(lines[1]).toContain("Objectif · relance automatique");
    expect(lines[2]).toContain("Continue vers l'objectif (tour 3 sur 10).");
    expect(await page.getByText("Tour 3 : tout est vérifié.").count()).toBe(1);
    if (shots) await page.screenshot({ path: path.join(shots, "goal-atteint.png") });
    await bar.getByRole("button", { name: "Fermer l'objectif" }).click();
    await expect.poll(() => bar.count()).toBe(0);

    // In this thread now: a goal it cannot reach alone stops, and says why.
    await composer.fill("/goal Déployer, impossible sans toi");
    await composer.press("Enter");
    await bar.getByText("Bloqué au tour 1 sur 10").waitFor({ timeout: 20_000 });
    await bar.getByText("il me faut la clé d'API").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "goal-bloque.png") });
    // It is the server's: loaded again, the page shows it as it is.
    await page.reload();
    await bar.getByText("Bloqué au tour 1 sur 10").waitFor();
    // Taken up again, it goes one turn further, and stops at the same place.
    await bar.getByRole("button", { name: "Reprendre" }).click();
    await bar.getByText("Bloqué au tour 2 sur 10").waitFor({ timeout: 20_000 });
    await bar.getByRole("button", { name: "Retirer l'objectif" }).click();
    await expect.poll(() => bar.count()).toBe(0);
    await page.close();
  });
});
