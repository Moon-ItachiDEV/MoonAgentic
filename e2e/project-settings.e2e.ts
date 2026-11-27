// « Réglages du projet » in the built app against a real server: the icon and tint show in
// the sidebar, AGENTS.md, CLAUDE.md, a command and a skill are written to the project's
// folder, and the composer then offers the command.
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, directThread } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.MOONAGENTIC_E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-setup-e2e-"));
  repo = path.join(dir, "demo");
  const home = path.join(dir, "home");
  for (const d of [repo, home]) mkdirSync(d);
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n\nPremière ligne.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
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

describe("a project's settings", () => {
  it("sets its icon, writes its instructions, a command and a skill", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await addProject(page, repo, false);
    const menu = page.getByRole("complementary", { name: "Menu" });

    await page.getByRole("button", { name: "Réglages du projet" }).click();
    const dialog = page.getByRole("dialog", { name: "Réglages du projet" });
    await dialog.getByRole("button", { name: /^Icône/ }).click();
    const icons = page.getByRole("dialog", { name: "Icône" });
    expect(await icons.getByRole("radiogroup", { name: "Icône" }).getByRole("radio").count()).toBe(
      121,
    );
    await icons.getByLabel("Chercher une icône").fill("fusee");
    await icons.getByRole("radio", { name: "Fusée", exact: true }).click();
    await icons.getByRole("radio", { name: "Menthe" }).click();
    // Every window sees it, the sidebar first.
    const icon = menu.getByRole("button", { name: /^demo/ }).locator(".pj-fold.pc-mint use");
    await expect
      .poll(() => icon.getAttribute("href").catch(() => null), { timeout: 30_000 })
      .toBe("#pi-rocket");
    await expect
      .poll(() =>
        icons.getByRole("radio", { name: "Fusée", exact: true }).getAttribute("aria-checked"),
      )
      .toBe("true");
    if (shots) await page.screenshot({ path: path.join(shots, "projet-apparence.png") });
    await icons.getByRole("button", { name: "Retour", exact: true }).click();

    await dialog.getByLabel("Contenu de AGENTS.md").fill("## Projet\n- Lance les tests.\n");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    // Not committed yet: said, since a thread on its own branch would not see it.
    await dialog.getByText("Pas encore commité").waitFor();
    expect(readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe(
      "## Projet\n- Lance les tests.\n",
    );
    await dialog.getByRole("button", { name: "Relier" }).click();
    await dialog.getByText("Relié").waitFor();
    expect(readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    if (shots) await page.screenshot({ path: path.join(shots, "projet-consignes.png") });

    // The shared memory is saved with the rest; it lives in MoonAgentic, not in the folder.
    const memory = dialog.getByLabel("Mémoire partagée du projet");
    await memory.fill("- Toujours lancer pnpm test avant une PR.");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect
      .poll(() => dialog.getByRole("button", { name: "Enregistrer" }).isDisabled())
      .toBe(true);
    expect(existsSync(path.join(repo, ".moonagentic/memory.md"))).toBe(false);

    await dialog.getByRole("button", { name: /^\/ Commandes/ }).click();
    const commands = page.getByRole("dialog", { name: "Commandes" });
    await commands.getByRole("button", { name: "Nouvelle commande" }).click();
    await commands.getByLabel("Nom").fill("deploy");
    await commands.getByLabel("Description").fill("Déployer en préproduction");
    await commands
      .getByLabel("Message envoyé à l'agent")
      .fill("Déploie $ARGUMENTS en préproduction.");
    await commands.getByRole("button", { name: "Enregistrer" }).click();
    await commands.getByRole("button", { name: "Modifier /deploy" }).waitFor();
    expect(readFileSync(path.join(repo, ".moonagentic/commands/deploy.md"), "utf8")).toBe(
      "---\ndescription: Déployer en préproduction\n---\n\nDéploie $ARGUMENTS en préproduction.\n",
    );
    await commands.getByRole("button", { name: "Retour", exact: true }).click();

    await dialog.getByRole("button", { name: /^\$ Skills/ }).click();
    const skills = page.getByRole("dialog", { name: "Skills" });
    await skills.getByRole("button", { name: "Nouvelle skill" }).click();
    await skills.getByLabel("Nom").fill("tests-vitest");
    await skills.getByLabel("Description").fill("Écrire des tests avec Vitest");
    await skills.getByLabel("Instructions").fill("Lance pnpm test.");
    await skills.getByRole("button", { name: "Enregistrer" }).click();
    // Listed with the project's skills; written to the folders Claude and Codex read.
    const row = skills.getByRole("button", { name: /^tests-vitest/ });
    await row.waitFor();
    expect(existsSync(path.join(repo, ".claude/skills/tests-vitest/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents/skills/tests-vitest/SKILL.md"))).toBe(true);
    if (shots) await page.screenshot({ path: path.join(shots, "projet-skills.png") });
    // Its window, hung from its line, writes it again or removes it.
    await row.click();
    const pop = page.getByRole("dialog", { name: "tests-vitest" });
    await pop.getByRole("button", { name: "Modifier" }).click();
    await skills.getByLabel("Instructions").fill("Lance pnpm test, puis pnpm lint.");
    await skills.getByRole("button", { name: "Enregistrer" }).click();
    await row.waitFor();
    expect(readFileSync(path.join(repo, ".claude/skills/tests-vitest/SKILL.md"), "utf8")).toContain(
      "pnpm lint",
    );
    await row.click();
    await pop.getByRole("button", { name: "Retirer cette skill" }).click();
    await pop.getByRole("button", { name: "Retirer tests-vitest" }).click();
    await expect.poll(() => row.count()).toBe(0);
    expect(existsSync(path.join(repo, ".agents/skills/tests-vitest"))).toBe(false);
    expect(existsSync(path.join(repo, ".claude/skills/tests-vitest"))).toBe(false);
    await skills.getByRole("button", { name: "Fermer", exact: true }).click();

    // The composer of the project's folder offers the command.
    await directThread(page);
    const composer = page.getByRole("combobox", { name: "Message" });
    await composer.fill("/depl");
    await expect
      .poll(() => page.locator("#composer-suggest [role=option]").first().textContent(), {
        timeout: 30_000,
      })
      .toContain("/deploy");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("archives the project, out of the list until it is taken back out", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const menu = page.getByRole("complementary", { name: "Menu" });
    const row = menu.getByRole("button", { name: /^demo/ });
    await row.click();
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    const dialog = page.getByRole("dialog", { name: "Réglages du projet" });
    await dialog.getByRole("button", { name: "Archiver le projet" }).click();
    // Out of the list, folded under « Archivés ».
    const folded = menu.getByRole("button", { name: /^Archivés/ });
    await folded.waitFor();
    expect(await row.count()).toBe(0);
    expect(await folded.getAttribute("aria-expanded")).toBe("false");
    await folded.click();
    await row.waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "projet-archive.png") });
    // Kept by the server: still so in another window.
    const other = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await other.goto(url);
    await other
      .getByRole("complementary", { name: "Menu" })
      .getByRole("button", { name: /^Archivés/ })
      .waitFor();
    await other.close();
    await row.click();
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    await dialog.getByRole("button", { name: "Sortir des archives" }).click();
    await expect.poll(() => folded.count()).toBe(0);
    await row.waitFor();
    await page.close();
  });
});
