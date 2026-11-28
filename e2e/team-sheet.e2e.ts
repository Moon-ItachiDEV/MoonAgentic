// « Confier à une équipe » on a phone (2026-11-28): opened with no task, « Lancer l'équipe »
// looked ready but did nothing when tapped. The built app, the real server, the demo agent.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, directThread } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-team-sheet-e2e-"));
  repo = path.join(dir, "depot");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src/app.ts"), "export const answer = 41;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
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

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Confier à une équipe" });

/** Who takes a role: the demo agent, not a real one that may be installed here, or no one. */
const giveRole = async (page: Page, role: string, to: "demo" | "none") => {
  await sheet(page)
    .getByRole("button", { name: new RegExp(`^${role} : `) })
    .click();
  const picker = page.getByRole("dialog", { name: role, exact: true });
  const wanted =
    to === "none"
      ? picker.getByRole("radio", { name: "Personne", exact: true })
      : picker
          .getByRole("group", { name: "Agent de démo", exact: true })
          .getByRole("radio")
          .first();
  const all = picker.getByRole("button", { name: /^(Tous|Plus)$/ });
  await expect
    .poll(async () => {
      if (await wanted.count()) return true;
      if (await all.count()) await all.first().click();
      return false;
    })
    .toBe(true);
  await wanted.click();
  await picker.waitFor({ state: "hidden" });
};

describe("team sheet on a phone", () => {
  it("says what is missing when « Lancer l'équipe » is tapped with no task, then launches", async () => {
    // The project is added from a computer; the phone then finds it on its home.
    const desk = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await desk.goto(url);
    await addProject(desk, repo, false);
    await desk.close();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: shots ? 2 : 1,
    });
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    await page.goto(url);
    await page.locator(".scr").waitFor();
    await directThread(page);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);

    // « /equipe » alone: the sheet opens with no task, only the example in grey.
    // Chosen in the list, it waits for a task; sent with none, it opens the sheet anyway.
    await composer(page).fill("/equipe");
    await composer(page).press("Enter");
    await expect.poll(() => composer(page).inputValue()).toBe("/equipe ");
    await page.getByRole("button", { name: "Envoyer" }).tap();
    const task = sheet(page).getByLabel("Tâche");
    await task.waitFor();
    expect(await task.inputValue()).toBe("");
    for (const role of ["Chef", "Codeurs"]) await giveRole(page, role, "demo");
    for (const role of ["Relecture", "Tests", "Fusion"]) await giveRole(page, role, "none");
    // The phone's keyboard is not up: nothing is focused, as on the iPhone, where a field
    // focused without a touch does not bring it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // The button answers the tap: it says the task is missing and puts the cursor in its field.
    const launch = sheet(page).getByRole("button", { name: "Lancer l'équipe" });
    expect(await launch.isEnabled()).toBe(true);
    await launch.tap();
    await sheet(page).getByRole("alert").filter({ hasText: "Écris d'abord la tâche" }).waitFor();
    await expect.poll(() => task.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await sheet(page).isVisible()).toBe(true);
    if (shots) await page.screenshot({ path: path.join(shots, "equipe-tache-manquante.png") });

    // Once written, the hint goes and the same button launches the team.
    await task.fill("Corrige answer");
    expect(await sheet(page).getByText("Écris d'abord la tâche").count()).toBe(0);
    await launch.tap();
    await sheet(page).waitFor({ state: "hidden" });
    await page.getByRole("region", { name: "Équipe", exact: true }).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("picked from the list with nothing after it, « /equipe » waits for the task in the composer", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator(".scr").waitFor();
    await directThread(page);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);

    // Tapped in the list of commands: the sheet does not open yet, the task is written first,
    // with the keyboard still up.
    await composer(page).fill("/equi");
    await page.getByRole("option", { name: /^\/equipe/ }).tap();
    await expect.poll(() => composer(page).inputValue()).toBe("/equipe ");
    await expect
      .poll(() => composer(page).evaluate((el) => el === document.activeElement))
      .toBe(true);
    expect(await sheet(page).count()).toBe(0);
    await composer(page).pressSequentially("Ajoute l'export CSV");
    await page.getByRole("button", { name: "Envoyer" }).tap();
    await expect
      .poll(() => sheet(page).getByLabel("Tâche").inputValue())
      .toBe("Ajoute l'export CSV");
    await context.close();
  });

  it("chosen with Enter in the list, « /equipe » waits for the task the same way", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await directThread(page);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await composer(page).fill("/equipe");
    await page.getByRole("option", { name: /^\/equipe/ }).waitFor();
    await composer(page).press("Enter");
    await expect.poll(() => composer(page).inputValue()).toBe("/equipe ");
    expect(await sheet(page).count()).toBe(0);
    // Sent again with no task, the sheet opens all the same, its field asking for one.
    await composer(page).press("Enter");
    await expect
      .poll(() => sheet(page).getByLabel("Tâche").getAttribute("placeholder"))
      .toBe("Que doit faire l'équipe ?");
    await page.close();
  });
});
