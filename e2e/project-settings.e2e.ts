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
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    await page.locator(".thr-row.proj", { hasText: "demo" }).locator(".thr").click();
    await page.getByRole("heading", { name: "demo" }).waitFor();

    await page.getByRole("button", { name: "Actions du projet" }).click();
    await page.getByRole("menuitem", { name: "Réglages du projet…" }).click();
    const dialog = page.getByRole("dialog", { name: "Réglages de demo" });
    await dialog.getByRole("button", { name: "Icône 🚀" }).click();
    await dialog.getByRole("radio", { name: "Menthe" }).click();
    // Every window sees it, the sidebar first.
    const icon = page.locator(".thr-row.proj", { hasText: "demo" }).locator(".pj-ico.pc-mint");
    await expect.poll(() => icon.textContent(), { timeout: 30_000 }).toBe("🚀");
    if (shots) await page.screenshot({ path: path.join(shots, "projet-apparence.png") });

    await dialog.getByRole("tab", { name: "Consignes" }).click();
    await dialog.getByLabel("Contenu de AGENTS.md").fill("## Projet\n- Lance les tests.\n");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await dialog.getByText("Enregistré").waitFor();
    expect(readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe(
      "## Projet\n- Lance les tests.\n",
    );
    // Not committed yet: said, since a thread on its own branch would not see it.
    await dialog.getByText("Pas encore commité").waitFor();
    await dialog.getByRole("button", { name: "Relier" }).click();
    await dialog.getByText("Relié").waitFor();
    expect(readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    if (shots) await page.screenshot({ path: path.join(shots, "projet-consignes.png") });

    await dialog.getByRole("tab", { name: "Mémoire" }).click();
    await dialog
      .getByLabel("Mémoire partagée du projet")
      .fill("- Toujours lancer pnpm test avant une PR.");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await dialog.getByText("Enregistré").waitFor();
    // Shared memory lives in MoonAgentic, not git, so no uncommitted warning is shown on this tab.
    expect(await dialog.getByText("Pas encore commité").count()).toBe(0);

    await dialog.getByRole("tab", { name: "Commandes" }).click();
    await dialog.getByRole("button", { name: "Nouvelle commande" }).click();
    await dialog.getByLabel("Nom").fill("deploy");
    await dialog.getByLabel(/Description/).fill("Déployer en préproduction");
    await dialog
      .getByLabel("Message envoyé à l'agent")
      .fill("Déploie $ARGUMENTS en préproduction.");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await dialog.getByText("/deploy", { exact: true }).waitFor();
    expect(readFileSync(path.join(repo, ".moonagentic/commands/deploy.md"), "utf8")).toBe(
      "---\ndescription: Déployer en préproduction\n---\n\nDéploie $ARGUMENTS en préproduction.\n",
    );

    await dialog.getByRole("tab", { name: "Skills" }).click();
    await dialog.getByRole("button", { name: "Nouvelle skill" }).click();
    await dialog.getByLabel("Nom").fill("tests-vitest");
    await dialog.getByLabel("Description").fill("Écrire des tests avec Vitest");
    await dialog.getByLabel("Instructions").fill("Lance pnpm test.");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await dialog.locator(".ps-list").getByText(".agents/skills/tests-vitest/SKILL.md").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "projet-skills.png") });
    await dialog.getByRole("button", { name: "Supprimer tests-vitest" }).click();
    await page.getByRole("button", { name: "Supprimer", exact: true }).click();
    await dialog.getByText("Aucune skill dans ce projet.").waitFor();
    expect(existsSync(path.join(repo, ".agents/skills/tests-vitest"))).toBe(false);
    await dialog.getByRole("button", { name: "Fermer" }).click();

    // The composer of the project's folder offers the command.
    await page.getByRole("button", { name: "Fil", exact: true }).click();
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
});
