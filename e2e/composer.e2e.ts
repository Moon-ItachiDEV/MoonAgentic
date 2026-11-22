// First end-to-end check: the built app, the real server, the demo agent, a real browser.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;

function write(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), content);
  }
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-e2e-"));
  project = path.join(dir, "projet");
  write(project, {
    "src/app.ts": "export const answer = 41;\n",
    "README.md": "# Démo\n",
    ".claude/skills/revue/SKILL.md": "---\nname: revue\ndescription: Relit le code\n---\nRelis.\n",
    ".moonagentic/commands/deploy.md":
      "---\ndescription: Déploie la branche\n---\nDéploie $ARGUMENTS.\n",
  });
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    // A home of its own, so the user's personal skills stay out of the test.
    { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" },
  );
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+\?token=\S+/.exec(out);
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const options = (page: Page) => page.locator("#composer-suggest [role=option]");

describe("composer", () => {
  it("offers commands, files and skills, sends them, pins the thread and finds it again", async () => {
    // The port is chosen by the system; the address printed is the one to open.
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);

    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByLabel("Dossier").fill(project);
    await page.getByRole("button", { name: "Créer" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // The demo agent, not a real one that may be installed on this machine.
    await page.locator(".agentchip").click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".agentchip").textContent()).toContain("Agent de démo");

    // `/` lists MoonAgentic's ready-made messages and the project's commands.
    await composer(page).fill("/de");
    await expect.poll(() => options(page).first().textContent()).toContain("/deploy");
    await shot(page, "c1-commandes");
    await composer(page).press("Escape");
    expect(await options(page).count()).toBe(0);
    await composer(page).fill("");
    await composer(page).fill("/rev");
    await composer(page).press("Enter");
    await expect.poll(() => composer(page).inputValue()).toContain("Relis les changements");

    // `@` searches the project's files, `$` its skills.
    await composer(page).fill("Lis @app");
    await expect.poll(() => options(page).first().textContent()).toContain("app.ts");
    await shot(page, "c2-fichiers");
    await composer(page).press("Enter");
    await composer(page).pressSequentially("avec $rev");
    await expect.poll(() => options(page).first().textContent()).toContain("revue");
    await shot(page, "c3-skills");
    await composer(page).press("Tab");
    expect(await composer(page).inputValue()).toBe("Lis @src/app.ts avec $revue ");

    await page.getByRole("button", { name: "Supervisé" }).click();
    await composer(page).press("Enter");
    // The agent got the file and the skill with the message.
    await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").waitFor();
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();

    // In the thread, the agent's own commands join in, with who offers them.
    await composer(page).fill("/");
    await expect
      .poll(async () => (await options(page).allTextContents()).join(" | "))
      .toContain("/explique");
    await shot(page, "c4-commandes-agent");
    await composer(page).fill("/epingler");
    await composer(page).press("Enter");
    await page.getByText("Épinglés").waitFor();

    // Ctrl K finds the message, and opens its thread.
    await page.goto(url.replace(/\?.*$/, ""));
    await page.getByText("Épinglés").waitFor();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Rechercher" }).fill("Pièces jointes");
    await page.getByRole("option", { name: /Pièces jointes/ }).waitFor();
    await shot(page, "c5-recherche");
    await page.keyboard.press("ArrowDown");
    await page.getByRole("option", { name: /Pièces jointes/ }).click();
    await expect.poll(() => page.url()).toMatch(/\/t\//);
    await page.close();
  });

  it("fits a phone screen, suggestions included", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    await composer(page).fill("/");
    await options(page).first().waitFor();
    // The commands stay inside the screen, above the composer.
    const box = await page.locator("#composer-suggest").boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await options(page).first().waitFor();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await shot(page, "c6-mobile");
    await page.close();
  });
});
