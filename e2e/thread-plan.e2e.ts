// A thread's plan on the phone: a pill at the top in place of its name, then its steps over
// the page. The built app, the real server, the demo agent keeping its plan with MoonAgentic's
// `update_plan`.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, directThread, pickAgent, setAccess } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-plan-e2e-"));
  project = path.join(dir, "projet");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src/app.ts"), "export const answer = 41;\n");
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
async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}
/** On the phone, Enter goes to the line: the message leaves with its button. */
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Envoyer", exact: true }).tap();
}
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const STEPS = [
  "Trouver qui répond vraiment dans le fil",
  "Expliquer la cause",
  "Corriger : un fil ne prend plus le modèle orchestrateur",
  "Afficher le nom de l'agent quand le coordinateur confie une mission",
  "Ouvrir la PR",
];

/** From a computer, once: a thread of the project on the demo agent, its plan not started. */
let seeding: Promise<string> | undefined;
const seeded = () => (seeding ??= seed());
async function seed() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await addProject(page, project, false);
  await directThread(page);
  await pickAgent(page);
  await setAccess(page, /Accès complet/);
  await say(page, "Faire répondre l'agent du coordinateur");
  await page.waitForURL((u) => u.pathname.startsWith("/t/"));
  const thread = new URL(page.url()).pathname;
  await page.close();
  return thread;
}

describe("a thread's plan on the phone", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`shows as a pill that opens on its steps (${scheme})`, async () => {
      const thread = await seeded();
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: scheme,
        deviceScaleFactor: shots ? 3 : 1,
      });
      const page = await context.newPage();
      await page.goto(url);
      await page.locator(".scr").waitFor();
      await page.goto(new URL(thread, url).href);
      await expect.poll(() => composer(page).isEnabled()).toBe(true);
      // No plan yet: the thread's name, as before.
      // The agent's own plan of its first answer, until it keeps one with the tool.
      if (scheme === "light") {
        await expect
          .poll(() => page.locator(".mtop .plp").getAttribute("aria-label"))
          .toMatch(/2 étapes faites sur 2$/);
      }
      await send(page, `/etapes 0 ${STEPS.join("; ")}`);

      // In place of the thread's name, its plan in one line; no line for the tool below.
      const pill = page.locator(".mtop .plp");
      await expect.poll(() => pill.getAttribute("aria-label")).toMatch(/0 étapes faites sur 5$/);
      await expect.poll(() => pill.textContent()).toContain("0/5");
      await expect.poll(() => page.locator(".view").getByText("update_plan").count()).toBe(0);
      // Its agent at work on the first step: it turns.
      await send(page, "Corrige answer en 5 étapes");
      await shot(page, `plan-${scheme}-1-pastille`);

      await pill.click();
      const panel = page.getByRole("dialog", { name: /^Plan : / });
      await panel.waitFor();
      const steps = panel.getByRole("listitem");
      await expect.poll(() => steps.allTextContents()).toEqual(STEPS);
      await expect.poll(() => panel.locator(".plspin").count()).toBe(1);
      await shot(page, `plan-${scheme}-2-etapes`);
      await panel.getByRole("button", { name: "Fermer le plan" }).click();
      await panel.waitFor({ state: "detached" });

      // The agent's own plan of that turn does not take the place of the one it keeps.
      await expect.poll(() => page.locator(".stp").count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await send(page, `/etapes 2 ${STEPS.join("; ")}`);
      await expect
        .poll(() => pill.getAttribute("aria-label"), { timeout: 20_000 })
        .toMatch(/2 étapes faites sur 5$/);
      await pill.click();
      await panel.waitFor();
      await expect.poll(() => panel.locator(".plm.d").count()).toBe(2);
      // Its turn over: nothing turns, the step it was on is ringed.
      await expect.poll(() => panel.locator(".plspin").count()).toBe(0);
      await shot(page, `plan-${scheme}-3-avance`);
      // Escape closes it too.
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      await context.close();
    }, 90_000);
  }
});
