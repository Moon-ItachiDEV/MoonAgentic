// The decision card above the composer: the built app, the real server, the demo agent.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;
/** The thread the first test opened, for the second to go on in. */
let thread: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-decision-e2e-"));
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

const shot = async (page: Page, name: string) => {
  if (!shots) return;
  // The card has finished coming in.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const card = (page: Page) => page.locator(".dc");
const say = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press("Enter");
};

/** A page on a new thread of the project, with the demo agent. */
async function open(viewport: { width: number; height: number }, dark = false) {
  const page = await browser.newPage({
    viewport,
    hasTouch: viewport.width < 640,
    colorScheme: dark ? "dark" : "light",
    deviceScaleFactor: shots ? 2 : 1,
  });
  await page.goto(url);
  return page;
}

describe("decision card", () => {
  it("asks above the composer and takes the answer from the keyboard", async () => {
    const page = await open({ width: 1280, height: 820 });
    await addProject(page, project);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await pickAgent(page);

    // A question the agent holds its turn on, as Claude Code asks: options with what they mean.
    await say(page, "/choix");
    await card(page).getByRole("heading", { name: "Quelle file de messages ?" }).waitFor();
    await card(page).getByText("Recommandé").waitFor();
    await card(page).getByText("Géré, rien à faire tourner, mais pas de rejeu").waitFor();
    expect(await card(page).locator(".opt").count()).toBe(4);
    await shot(page, "a1-question");
    // The card sits just above the composer, on its edges, once it has slid in.
    await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const [box, below] = await Promise.all([
      card(page).boundingBox(),
      page.locator(".cmp").boundingBox(),
    ]);
    expect(box!.x).toBe(below!.x);
    expect(box!.width).toBe(below!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(below!.y - 8);

    // From the empty composer: the arrows move, a digit answers, once the question has
    // been there long enough to be read.
    await page.waitForTimeout(900);
    await composer(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => card(page).locator(".opt.hl").textContent()).toContain("SQS");
    await page.keyboard.press("2");
    await page.getByText("Compris : SQS.").waitFor();
    thread = page.url();
    expect(await card(page).count()).toBe(0);
    // The feed keeps what was asked and answered.
    const asked = page.locator(".ask.done", { hasText: "Quelle file de messages ?" });
    await asked.getByText("SQS", { exact: true }).waitFor();

    // Typing a message is never taken for an answer.
    await say(page, "/apercus");
    await card(page)
      .getByRole("heading", { name: "Quelle forme pour l'appel d'envoi ?" })
      .waitFor();
    expect(await card(page).locator(".tile").count()).toBe(3);
    await card(page).getByText('const q = queue("ingest")').waitFor();
    await composer(page).fill("2 choses");
    expect(await card(page).count()).toBe(1);
    await composer(page).fill("");
    await shot(page, "a2-apercus");

    // « Plus tard » folds it to one line; it opens again.
    await card(page).getByRole("button", { name: "Plus tard" }).click();
    const fold = page.getByRole("button", { name: /Rouvrir la demande/ });
    await fold.getByText("Quelle forme pour l'appel d'envoi ?").waitFor();
    await shot(page, "a3-plus-tard");
    await fold.click();

    // The last row takes the user's own words.
    await card(page)
      .getByRole("button", { name: /Autre chose/ })
      .click();
    await card(page).getByLabel("Ta réponse").fill("Un flux");
    await shot(page, "a4-autre-chose");
    await page.keyboard.press("Enter");
    await page.getByText("Compris : Un flux.").waitFor();

    // A permission request: the same card, allowing first.
    await say(page, "Corrige la réponse");
    await card(page).getByRole("heading", { name: "Modifier src/app.ts" }).waitFor();
    await expect
      .poll(() => card(page).locator(".opt .on").allTextContents())
      .toEqual(["Autoriser pour ce filRecommandé", "Autoriser cette fois", "Refuser"]);
    await card(page)
      .getByRole("button", { name: /Autre chose…/ })
      .waitFor();
    await shot(page, "a5-approbation");
    // A key from the composer may be the first of a message: it never allows.
    await page.waitForTimeout(900);
    await composer(page).focus();
    await page.keyboard.press("1");
    await expect.poll(() => composer(page).inputValue()).toBe("1");
    expect(await card(page).count()).toBe(1);
    await composer(page).fill("");

    // The user's own words refuse, and go to the agent once its turn is over.
    await card(page)
      .getByRole("button", { name: /Autre chose/ })
      .click();
    await card(page).getByLabel("Ta réponse").fill("Pas ce fichier, regarde les tests");
    await page.keyboard.press("Enter");
    await page.getByText("D'accord, je ne touche à rien.").waitFor();
    await page.getByText("Tu m'as demandé : « Pas ce fichier, regarde les tests »").waitFor();

    // Put off, a request stays folded; the one that comes after opens the card again.
    await card(page).getByRole("heading", { name: "Modifier src/app.ts" }).waitFor();
    await card(page).getByRole("button", { name: "Plus tard" }).click();
    await page.getByRole("button", { name: /Rouvrir la demande/ }).waitFor();
    await page.getByRole("button", { name: "Arrêter", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: /Rouvrir la demande/ }).count())
      .toBe(0);
    await say(page, "Corrige la réponse");
    await card(page).getByRole("button", { name: "Autoriser cette fois" }).click();
    await page.getByText("C'est fait, la réponse vaut 42.").last().waitFor();
    expect(await card(page).count()).toBe(0);
    await page.close();
  });

  it("fits a phone: one preview at a time, a tap to see, a tap to choose", async () => {
    const page = await open({ width: 390, height: 800 }, true);
    await page.goto(thread);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // On a touch screen Enter goes to a new line: the button sends.
    await composer(page).fill("/apercus");
    await page.getByRole("button", { name: "Envoyer", exact: true }).tap();
    await card(page)
      .getByRole("heading", { name: "Quelle forme pour l'appel d'envoi ?" })
      .waitFor();
    expect(await card(page).locator(".tile").count()).toBe(0);
    await card(page).locator(".pane").getByText("await send(").waitFor();
    // The composer still has the focus, and folds when it loses it: the tap must land.
    await card(page)
      .getByRole("button", { name: /Client typé/ })
      .tap();
    await card(page).locator(".pane").getByText('const q = queue("ingest")').waitFor();
    await card(page).getByText("Choisir").waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, "a6-mobile-apercus");
    await card(page)
      .getByRole("button", { name: /Client typé/ })
      .tap();
    await page.getByText("Compris : Client typé (Recommandé).").waitFor();
    await page.close();
  });
});
