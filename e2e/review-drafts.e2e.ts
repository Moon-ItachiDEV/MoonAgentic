// The remarks written in a review, in the built app against a real server: they are still
// there after the panel closed and after the page loaded again, and leave once sent.
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent, setAccess } from "./ui.ts";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-revue-e2e-"));
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

describe("review remarks", () => {
  it("keeps a remark through closing the panel and loading the page again, until it is sent", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await addProject(page, repo);
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    await pickAgent(page);
    // Let through, so its turn ends by itself.
    await setAccess(page, /Accès complet/);
    await composer.fill("Corrige la réponse");
    await composer.press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();

    // A change on the thread's own branch, as an agent would leave one. Longer than the line
    // it replaces: written in the second git saw the file, a change of the same size could
    // be taken for no change at all.
    const worktrees = path.join(dir, "data", "worktrees");
    const [branch] = readdirSync(worktrees);
    writeFileSync(
      path.join(worktrees, branch!, "notes.md"),
      "# Notes\n\nLigne à revoir, plus longue.\n",
    );

    const open = page.getByRole("button", { name: /^Modifications/ });
    const panel = page.getByRole("dialog", { name: "Modifications" });
    /** The file's own changes, one level down in the sheet. */
    const file = page.getByRole("dialog", { name: "notes.md" });
    const line = file.getByRole("row").filter({ hasText: "Ligne à revoir, plus longue." });
    const remark = file.getByRole("button", { name: /Dis plutôt pourquoi$/ });
    const toFile = async () => {
      await open.click();
      await panel.getByRole("button", { name: /^notes\.md/ }).click();
    };
    await toFile();
    await line.click();
    await file.getByPlaceholder("Ce que l'agent doit changer ici").fill("Dis plutôt pourquoi");
    await file.getByRole("button", { name: "Ajouter", exact: true }).click();
    await remark.waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "revue-commentaire.png") });

    // Closed and opened again: the remark is on its line.
    await file.getByRole("button", { name: "Fermer", exact: true }).click();
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    await toFile();
    await remark.waitFor();

    // The page loaded again: still there, kept on this device, and counted on the file.
    await page.reload();
    await toFile();
    await remark.waitFor();

    // Sent to the agent, it leaves the list, and does not come back with the panel.
    await file.getByRole("button", { name: /^Envoyer à l'agent/ }).click();
    await page.getByText("Dis plutôt pourquoi").first().waitFor();
    await expect.poll(() => remark.count(), { timeout: 15_000 }).toBe(0);
    await page.keyboard.press("Escape");
    await page.getByText("C'est fait, la réponse vaut 42.").nth(1).waitFor();
    await page.reload();
    await toFile();
    await line.waitFor();
    expect(await remark.count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
});
