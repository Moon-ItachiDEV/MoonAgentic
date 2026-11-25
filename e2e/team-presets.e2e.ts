// What the server keeps for every device, in the built app: the defaults of a new thread and
// the teams of « Réglages → Équipes ». A second window, as another device, sees each change.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-teams-e2e-"));
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

const at = (section: string) => {
  const opened = new URL(url);
  opened.pathname = `/reglages/${section}`;
  return opened.href;
};

describe("settings kept for every device", () => {
  it("shares the defaults of a new thread with another window", async () => {
    const one = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const two = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const errors: Error[] = [];
    for (const page of [one, two]) page.on("pageerror", (err) => errors.push(err));
    await one.goto(at("general"));
    await two.goto(at("general"));
    const full = (page: typeof one) =>
      page
        .getByRole("radiogroup", { name: "Autorisations par défaut" })
        .getByRole("radio", { name: "Accès complet" });
    await full(one).click();
    await expect
      .poll(() => full(two).getAttribute("aria-checked"), { timeout: 30_000 })
      .toBe("true");
    await one.getByRole("switch", { name: "Branche à part" }).click();
    await expect
      .poll(
        () => two.getByRole("switch", { name: "Branche à part" }).getAttribute("aria-checked"),
        {
          timeout: 30_000,
        },
      )
      .toBe("false");
    expect(errors).toEqual([]);
    await one.close();
    await two.close();
  });

  it("starts from the suggested teams, then keeps the user's own", async () => {
    const one = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    one.on("pageerror", (err) => errors.push(err));
    await one.goto(at("teams"));
    await one.getByRole("heading", { name: "Équipes" }).waitFor();
    const teams = (page: typeof one) =>
      page
        .getByRole("region", { name: "Équipes" })
        .locator('.it[aria-haspopup="dialog"] .tx')
        .evaluateAll((rows) => rows.map((r) => r.firstChild?.textContent ?? ""));
    const names = () => teams(one);
    await expect
      .poll(names, { timeout: 30_000 })
      .toEqual(["Équilibrée", "Économique", "Qualité max", "Neon relit et teste"]);
    const row = (name: string) =>
      one
        .getByRole("region", { name: "Équipes" })
        .getByRole("button", { name: new RegExp(`^${name}`) });
    const sheet = one.getByRole("dialog", { name: "Équipe", exact: true });
    const close = () => sheet.getByRole("button", { name: "Fermer", exact: true }).click();

    await row("Équilibrée").click();
    const first = sheet.getByRole("textbox", { name: "Nom de l'équipe Équilibrée" });
    await first.fill("Rapide");
    await first.press("Enter");
    await expect.poll(names, { timeout: 30_000 }).toContain("Rapide");
    await close();
    // The first one is the coordinator's.
    await row("Rapide").getByText("Par défaut").waitFor();

    await row("Économique").click();
    await sheet.getByRole("button", { name: "Supprimer l'équipe Économique" }).click();
    await one
      .getByRole("alertdialog")
      .getByRole("button", { name: "Supprimer", exact: true })
      .click();
    await expect
      .poll(names, { timeout: 30_000 })
      .toEqual(["Rapide", "Qualité max", "Neon relit et teste"]);
    // Renamed, then closed and a click elsewhere at once: the new name is not lost to the click.
    await row("Neon relit et teste").click();
    await sheet
      .getByRole("textbox", { name: "Nom de l'équipe Neon relit et teste" })
      .fill("Neon partout");
    await close();
    await one.getByRole("button", { name: "Nouvelle équipe" }).click();
    await expect
      .poll(names, { timeout: 30_000 })
      .toEqual(["Rapide", "Qualité max", "Neon partout", "Équipe 4"]);
    if (shots) await one.screenshot({ path: path.join(shots, "equipes.png"), fullPage: true });

    // Another window, as another device, finds the same teams.
    const two = await browser.newPage({ viewport: { width: 390, height: 800 } });
    two.on("pageerror", (err) => errors.push(err));
    await two.goto(at("teams"));
    await expect
      .poll(() => teams(two), { timeout: 30_000 })
      .toEqual(["Rapide", "Qualité max", "Neon partout", "Équipe 4"]);
    if (shots) await two.screenshot({ path: path.join(shots, "equipes-telephone.png") });

    await one.getByRole("button", { name: "Revenir aux suggestions" }).click();
    await one
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revenir aux suggestions" })
      .click();
    await expect
      .poll(names, { timeout: 30_000 })
      .toEqual(["Équilibrée", "Économique", "Qualité max", "Neon relit et teste"]);
    expect(errors).toEqual([]);
    await one.close();
    await two.close();
  });
});
