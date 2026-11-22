// First end-to-end check: the built app, the real server, the demo agent, a real browser.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
/** A git repository, for the team: each coder works on its own branch. */
let repo: string;

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
  repo = path.join(dir, "equipe");
  write(repo, { "src/app.ts": "export const answer = 41;\n", "README.md": "# Équipe\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=e2e@example.com", "-c", "user.name=E2E", "add", "-A");
  git(
    "-c",
    "user.email=e2e@example.com",
    "-c",
    "user.name=E2E",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  );
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
/** Picks an agent from the model sheet: « Tous », then « Options ». */
async function pickAgent(page: Page, name: RegExp) {
  await page.locator(".agentchip").click();
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

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
    await pickAgent(page, /Agent de démo/);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".agentchip").textContent()).toContain("Agent de démo");

    // `/` lists MoonAgentic's ready-made messages and the project's commands.
    await composer(page).fill("/dep");
    await expect.poll(() => options(page).first().textContent()).toContain("/deploy");
    await shot(page, "c1-commandes");
    await composer(page).press("Escape");
    expect(await options(page).count()).toBe(0);
    await composer(page).fill("");
    // A command that takes arguments waits for them instead of sending its message bare.
    await composer(page).fill("/dep");
    await options(page).first().waitFor();
    await composer(page).press("Enter");
    expect(await composer(page).inputValue()).toBe("/deploy ");
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

  it("shows each agent's state, adds an agent, and answers a request from À traiter", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Connexions" }).click();
    const dialog = page.getByRole("dialog", { name: "Connexions" });
    const demo = dialog.locator(".cx-row", { hasText: "Agent de démo" }).first();
    await demo.getByRole("button", { name: "Vérifier" }).click();
    await expect.poll(() => demo.locator(".st").textContent()).toBe("Prêt");
    await demo.getByText("Version : moonagentic-demo 0.1.0").waitFor();

    // An agent of the user's own whose command this machine lacks says so.
    await dialog.getByRole("button", { name: "Ajouter un agent" }).click();
    await dialog.getByLabel("Nom").fill("Mon agent");
    await dialog.getByLabel("Commande qui le lance en mode ACP").fill("pas-une-commande-e2e acp");
    await dialog.getByRole("button", { name: "Ajouter", exact: true }).click();
    const mine = dialog.locator(".cx-row", { hasText: "Mon agent" });
    await mine.getByText("Commande introuvable sur cette machine : pas-une-commande-e2e").waitFor();
    await shot(page, "c7-connexions");
    await mine.getByRole("button", { name: "Retirer Mon agent" }).click();
    await mine.getByRole("button", { name: "Confirmer le retrait de Mon agent" }).click();
    await expect.poll(() => mine.count()).toBe(0);
    await dialog.getByRole("button", { name: "Fermer" }).click();

    // A supervised turn waits for the user, who answers from À traiter.
    await pickAgent(page, /Agent de démo/);
    await page.keyboard.press("Escape");
    await composer(page).fill("Corrige la réponse");
    await composer(page).press("Enter");
    const inbox = page.getByRole("button", { name: /À traiter/ });
    // The agent starts its process before it asks: more than the poll's usual second on CI.
    await expect.poll(() => inbox.textContent(), { timeout: 15_000 }).toContain("1");
    await inbox.click();
    const requests = page.getByRole("dialog", { name: "À traiter" });
    await requests.getByText("Modifier src/app.ts").waitFor();
    await shot(page, "c8-a-traiter");
    await requests.getByRole("button", { name: "Autoriser" }).click();
    await requests.getByText("Aucun agent n'attend ta réponse.").waitFor();
    await requests.getByRole("button", { name: "Fermer" }).click();
    await page.getByText("C'est fait, la réponse vaut 42.").last().waitFor();
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
  it("archives a thread, brings it back, deletes it, then removes the project", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Corrige la réponse" }).first().click();
    const menu = page.getByRole("button", { name: "Actions du fil" });

    // On a phone, the menu opens inside the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await menu.click();
    const box = await page.locator(".menu.thread-menu").boundingBox();
    expect(box && box.y >= 0 && box.y + box.height <= 780 && box.x >= 0).toBe(true);
    await menu.click();
    await page.setViewportSize({ width: 1280, height: 820 });

    await menu.click();
    await page.getByRole("menuitem", { name: "Archiver" }).click();
    await page.getByText("Cette discussion est archivée.").waitFor();
    await page.getByRole("button", { name: "Archivés (1)" }).click();
    await shot(page, "c9-archive");
    await page.getByRole("button", { name: "Désarchiver" }).click();
    await expect.poll(() => composer(page).count()).toBe(1);

    await menu.click();
    await page.getByRole("menuitem", { name: "Supprimer…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Supprimer cette discussion ?" });
    await confirm.getByRole("button", { name: "Supprimer" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Corrige la réponse" }).count())
      .toBe(0);

    await page.getByRole("button", { name: "Retirer le projet projet" }).click();
    await page
      .getByRole("alertdialog", { name: "Retirer ce projet ?" })
      .getByRole("button", { name: "Retirer" })
      .click();
    await page.getByText("Aucun projet pour l'instant.").waitFor();
    // The folder itself is left alone.
    expect(existsSync(path.join(project, "src/app.ts"))).toBe(true);
    await page.close();
  });

  it("gives a task to a team: the lead splits it, coders do the pieces on their own branches", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByLabel("Dossier").fill(repo);
    await page.getByRole("button", { name: "Créer" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);

    await composer(page).fill("/equipe Corrige answer et documente-la");
    await composer(page).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Confier à une équipe" });
    await expect
      .poll(() => dialog.getByLabel("Tâche").inputValue())
      .toBe("Corrige answer et documente-la");
    // The demo agent for every role, not a real one that may be installed on this machine.
    await dialog.getByLabel("Chef", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Codeurs", { exact: true }).selectOption({ label: "Agent de démo" });
    await shot(page, "c10-equipe-lancer");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();

    const card = page.getByRole("region", { name: "Équipe" });
    await card.getByText("Terminé : chaque sous-tâche").waitFor({ timeout: 30_000 });
    expect(await card.getByRole("listitem").allTextContents()).toEqual([
      "Corriger answerterminée",
      "Documenter answerterminée",
    ]);
    // The coders' threads sit under the lead's in the sidebar.
    expect(await page.locator(".thr-row.child").count()).toBe(2);
    await shot(page, "c11-equipe");

    await card.getByRole("button", { name: "Documenter answer" }).click();
    await page.getByRole("button", { name: /Sous-tâche de l'équipe/ }).waitFor();
    await page.close();
  });
});
