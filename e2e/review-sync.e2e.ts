// The review in the built app against a real server: it says main moved on, merges it in
// when nothing conflicts, and drops one file's changes after asking.
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-sync-e2e-"));
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

describe("review against main", () => {
  it("merges main in when it moved on, then drops one file's changes", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Mode d'accès/ }).click();
    await page.getByRole("menuitemradio", { name: /Accès complet/ }).click();
    await composer.fill("Corrige la réponse");
    await composer.press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();

    // The thread's own change, and main moving on in another file meanwhile.
    const worktrees = path.join(dir, "data", "worktrees");
    const [branch] = readdirSync(worktrees);
    const folder = path.join(worktrees, branch!);
    writeFileSync(path.join(folder, "notes.md"), "# Notes\n\nLigne du fil, plus longue.\n");
    writeFileSync(path.join(repo, "autre.md"), "Arrivé sur main.\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "main avance"], { cwd: repo });

    await page.getByRole("button", { name: /^Code/ }).click();
    const panel = page.getByRole("complementary", { name: "À revoir" });
    await panel.getByText("main a avancé de 1 commit · fusion sans conflit").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "revue-main-avance.png") });
    await panel.getByRole("button", { name: "Synchroniser", exact: true }).click();
    await panel.getByText("À jour avec main").waitFor();
    expect(readFileSync(path.join(folder, "autre.md"), "utf8")).toBe("Arrivé sur main.\n");
    // What came from main is not the thread's work: the review still lists one file.
    const line = panel.getByRole("row").filter({ hasText: "Ligne du fil, plus longue." });
    await line.waitFor();
    expect(await panel.getByText("autre.md").count()).toBe(0);

    await panel.getByRole("button", { name: "Annuler les changements de notes.md" }).click();
    await panel.getByText("Remettre ce fichier comme au départ de la branche ?").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "revue-annuler.png") });
    await panel.getByRole("button", { name: "Annuler les changements", exact: true }).click();
    await panel.getByText("Rien n'a changé sur cette branche pour l'instant.").waitFor();
    expect(readFileSync(path.join(folder, "notes.md"), "utf8")).toBe(
      "# Notes\n\nPremière ligne.\n",
    );
    expect(errors).toEqual([]);
    await page.close();
  });
});
