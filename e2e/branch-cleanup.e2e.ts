// « Nettoyer les branches » in the built app against a real server: the merged moon/* branch
// goes after a second click, the one with work not merged stays.
import { execFileSync } from "node:child_process";
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
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-branches-e2e-"));
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
  // One branch merged into main, one with a commit main does not have.
  for (const [branch, merge] of [
    ["moon/fini-aaaaaa", true],
    ["moon/en-cours-bbbbbb", false],
  ] as const) {
    git("checkout", "-q", "-b", branch, "main");
    writeFileSync(path.join(repo, `${branch.slice(5)}.md`), "Travail.\n");
    git("add", "-A");
    git("commit", "-q", "-m", `travail sur ${branch}`);
    git("checkout", "-q", "main");
    if (merge) git("merge", "-q", "--no-ff", "-m", `fusion de ${branch}`, branch);
  }
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

describe("cleaning a project's branches", () => {
  it("deletes the merged moon/* branch after asking, and keeps the other", async () => {
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
    await page.getByRole("menuitem", { name: "Nettoyer les branches…" }).click();
    const dialog = page.getByRole("dialog", { name: "Nettoyer les branches" });
    await dialog.getByText("1 branche moon/* a tout son travail dans main").waitFor();
    const merged = dialog.getByRole("checkbox", { name: /moon\/fini-aaaaaa/ });
    expect(await merged.isChecked()).toBe(true);
    await dialog.getByText("1 branche gardée").click();
    await dialog.getByText("1 commit pas fusionné").waitFor();
    expect(await dialog.getByRole("checkbox").count()).toBe(1);

    await dialog.getByRole("button", { name: "Supprimer 1 branche…" }).click();
    await dialog.getByText("ne peut pas être annulé").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "branches-confirmer.png") });
    // Still there until the second click.
    expect(branches()).toContain("moon/fini-aaaaaa");
    await dialog.getByRole("button", { name: "Oui, supprimer 1 branche" }).click();
    await dialog.getByText("1 branche supprimée.").waitFor();
    await dialog.getByText("Aucune branche moon/* ne peut partir pour l'instant").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "branches-fait.png") });
    expect(branches()).toEqual(["main", "moon/en-cours-bbbbbb"]);
    expect(errors).toEqual([]);
    await page.close();
  });
});

function branches() {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: repo })
    .toString()
    .split("\n")
    .filter(Boolean)
    .sort();
}
