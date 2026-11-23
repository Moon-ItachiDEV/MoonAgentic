// The planner in the built app against a real server: a card's work is started from the
// board, the card then moves as its thread really does, and each view has its own address.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-planner-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "pipe",
    },
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

/** A new project, with the page on its planner. */
async function onPlanner(name: string, viewport = { width: 1280, height: 820 }): Promise<Page> {
  const project = path.join(dir, name);
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  const page = await browser.newPage({ viewport });
  await page.goto(url);
  await page.getByRole("button", { name: "Nouveau projet" }).first().click();
  await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
  await page.getByLabel("Dossier", { exact: true }).fill(project);
  await page.getByRole("button", { name: "Ajouter le projet" }).click();
  await expect.poll(() => page.getByRole("combobox", { name: "Message" }).isEnabled()).toBe(true);
  await page.locator(".nav").getByRole("button", { name: "Planner", exact: true }).click();
  await page.getByRole("heading", { name: /Planner/ }).waitFor();
  return page;
}

const pathname = (page: Page) => new URL(page.url()).pathname;
/** The titles of the cards in a column of the board. */
const column = (page: Page, label: string) =>
  page.getByRole("region", { name: label, exact: true }).locator(".pl-card h3").allTextContents();

describe("planner", () => {
  it("starts a card's work in a new thread, and moves the card as that thread does", async () => {
    const page = await onPlanner("lancer");
    await page.getByRole("button", { name: "Ajouter une tâche" }).click();
    await page.getByLabel("Nouvelle tâche, À faire").fill("Dire bonjour au projet");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    // The card comes back from the server: on a busy machine, after Escape.
    await expect.poll(() => column(page, "À faire")).toEqual(["Dire bonjour au projet"]);

    // « Lancer » on the card opens it on its launch: which agent, with what access.
    await page.getByRole("button", { name: "Lancer la tâche 1" }).click();
    const detail = page.getByRole("dialog", { name: "Tâche 1" });
    const launch = detail.getByRole("form", { name: "Lancer la tâche 1" });
    await launch.waitFor();
    // The demo agent, not a real one that may be installed on this machine.
    await launch.getByLabel("Modèle", { exact: true }).selectOption("demo\n");
    // It asks before it acts: the card is seen at work for as long as it waits.
    await launch.getByLabel("Accès de l'agent").selectOption("supervised");
    if (shots) {
      // Once the panel has slid in.
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "planner-lancer.png") });
    }
    await launch.getByRole("button", { name: "Lancer la tâche" }).click();

    // The card is at work with its agent, and its state is no longer the user's to set.
    await expect.poll(() => column(page, "En cours")).toEqual(["Dire bonjour au projet"]);
    await launch.waitFor({ state: "detached" });
    await detail.getByText("Cette carte suit son fil").waitFor();
    expect(await detail.getByRole("button", { name: "Livré" }).isDisabled()).toBe(true);
    expect(await detail.getByRole("button", { name: "Lancer", exact: true }).count()).toBe(0);
    if (shots) await page.screenshot({ path: path.join(shots, "planner-en-cours.png") });
    await page.keyboard.press("Escape");
    const card = page.locator(".pl-card", { hasText: "Dire bonjour au projet" });
    expect(await card.getByRole("button", { name: /Lancer/ }).count()).toBe(0);
    // The agent asks before changing a file: the card says so, and stays at work.
    await expect
      .poll(() => card.locator(".pl-who").textContent(), { timeout: 15_000 })
      .toBe("Agent de démo · attend ton accord");
    expect(await column(page, "En cours")).toEqual(["Dire bonjour au projet"]);
    await page.getByRole("button", { name: /À traiter/ }).click();
    const requests = page.getByRole("dialog", { name: "À traiter" });
    await requests.getByRole("button", { name: "Autoriser" }).click();
    await requests.getByText("Aucun agent n'attend ta réponse.").waitFor();
    await requests.getByRole("button", { name: "Fermer" }).click();

    // Its agent done, the work is to check: the card went there by itself.
    await expect
      .poll(() => column(page, "En test"), { timeout: 30_000 })
      .toEqual(["Dire bonjour au projet"]);
    expect(await column(page, "En cours")).toEqual([]);
    if (shots) await page.screenshot({ path: path.join(shots, "planner-en-test.png") });

    // The thread got the card's title as its first message.
    await card.click();
    await detail.getByRole("button", { name: "Ouvrir le fil" }).click();
    await expect.poll(() => pathname(page)).toMatch(/^\/t\//);
    await expect
      .poll(() => page.locator(".u-wrap").first().textContent())
      .toContain("Dire bonjour au projet");
    await page.close();
  });

  it("gives the planned tasks and the timeline their own address", async () => {
    const page = await onPlanner("adresses");
    const tab = (name: string) => page.getByRole("tab", { name, exact: true });
    expect(pathname(page)).toBe("/planner");
    expect(await tab("Tableau").getAttribute("aria-selected")).toBe("true");

    // From the sidebar, the planned tasks open at their address, and are marked there.
    const entry = page.getByRole("button", { name: /^Tâches planifiées/ });
    await entry.click();
    await expect.poll(() => pathname(page)).toBe("/planner/planifiees");
    expect(await tab("Planifiées").getAttribute("aria-selected")).toBe("true");
    await page.getByText("Aucune tâche planifiée.").waitFor();
    expect(await entry.getAttribute("aria-current")).toBe("page");
    expect(
      await page
        .locator(".nav")
        .getByRole("button", { name: "Planner", exact: true })
        .getAttribute("aria-current"),
    ).toBeNull();

    // The address alone brings the view back: after a reload, and in a new window.
    await page.reload();
    await page.getByText("Aucune tâche planifiée.").waitFor();
    expect(await tab("Planifiées").getAttribute("aria-selected")).toBe("true");

    await tab("Timeline").click();
    await expect.poll(() => pathname(page)).toBe("/planner/timeline");
    await page.goBack();
    await expect.poll(() => pathname(page)).toBe("/planner/planifiees");
    await expect.poll(() => tab("Planifiées").getAttribute("aria-selected")).toBe("true");
    await tab("Tableau").click();
    await expect.poll(() => pathname(page)).toBe("/planner");

    // An address that names no view is the board.
    await page.goto(new URL("/planner/nimporte", url).href);
    await expect.poll(() => tab("Tableau").getAttribute("aria-selected")).toBe("true");
    await page.close();
  });
});
