// The messages written while an agent works, in the built app against a real server: they
// wait above the composer, can be changed or taken out, and go when the turn ends.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-file-e2e-"));
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

/** A new project's composer, set on the demo agent, which asks before it acts. */
async function newThread(name: string) {
  const project = path.join(dir, name);
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await addProject(page, project);
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await pickAgent(page);
  return { page, composer };
}

/** Says yes to what the agent asks, from « À traiter ». */
async function allow(page: Page) {
  const inbox = page.getByRole("button", { name: /À traiter/ }).first();
  await expect.poll(() => inbox.textContent(), { timeout: 15_000 }).toContain("1");
  await inbox.click();
  const requests = page.getByRole("region", { name: "À traiter" });
  const row = requests.locator(".rq").first();
  const answered = await row.elementHandle();
  await row.getByRole("button", { name: "Autoriser cette fois" }).click();
  // That request goes. The list may not stay empty: the message in line starts a turn of
  // its own at once, and the demo agent asks again.
  await answered!.waitForElementState("hidden");
  // « À traiter » is a page: back to the thread.
  await page.goBack();
}

describe("message queue", () => {
  it("keeps what is written during a turn, lets it be changed, and sends it at the end", async () => {
    const { page, composer } = await newThread("file");
    const queue = page.getByRole("region", { name: "Messages en file" });
    const said = () => page.locator(".uw").allTextContents();
    const rows = () => queue.locator(".cqt").allTextContents();

    await composer.fill("Corrige la réponse");
    await page.keyboard.press("Enter");
    // The agent asks before it changes a file: its turn is under way for as long as it waits.
    await page.getByRole("button", { name: "Arrêter" }).waitFor();
    await expect.poll(() => composer.getAttribute("placeholder")).toBe("Ajouter une consigne");

    // Written now, a message waits above the composer instead of being refused.
    await composer.fill("Ensuite, lance les tests");
    await page.getByRole("button", { name: "Mettre en file" }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(rows).toEqual(["Ensuite, lance les tests"]);
    expect(await composer.inputValue()).toBe("");
    expect(await queue.getByRole("status").textContent()).toBe("En file · 1");
    await composer.fill("Puis ouvre la PR");
    await page.keyboard.press("Enter");
    await composer.fill("Message de trop");
    await page.keyboard.press("Enter");
    await expect
      .poll(rows)
      .toEqual(["Ensuite, lance les tests", "Puis ouvre la PR", "Message de trop"]);
    expect(await queue.getByRole("status").textContent()).toBe("En file · 3");

    // One is changed, another taken out; only the first message was said to the agent.
    await queue.getByRole("button", { name: /^Modifier le message 1/ }).click();
    const field = queue.getByRole("textbox", { name: "Message 1 en file" });
    await field.fill("Ensuite, lance tous les tests");
    await field.press("Enter");
    await queue.getByRole("button", { name: "Retirer le message 3 de la file" }).click();
    await expect.poll(rows).toEqual(["Ensuite, lance tous les tests", "Puis ouvre la PR"]);
    expect((await said()).length).toBe(1);
    if (shots) await page.screenshot({ path: path.join(shots, "file-en-file.png") });

    // The turn ends by itself: the first one goes, as a turn of its own.
    await allow(page);
    await expect.poll(rows, { timeout: 15_000 }).toEqual(["Puis ouvre la PR"]);
    await expect.poll(async () => (await said()).length).toBe(2);
    expect((await said())[1]).toContain("Ensuite, lance tous les tests");

    // Stopped by hand, the turn sends nothing after it: the message stays, and says why.
    await page.getByRole("button", { name: "Arrêter" }).click();
    await queue.getByText("En attente · 1").waitFor();
    // It is the server's: another window, or this one loaded again, shows it too.
    await page.reload();
    await expect.poll(rows).toEqual(["Puis ouvre la PR"]);
    if (shots) await page.screenshot({ path: path.join(shots, "file-en-attente.png") });
    await queue.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect.poll(async () => (await said()).length).toBe(3);
    expect((await said())[2]).toContain("Puis ouvre la PR");
    await expect.poll(() => queue.count()).toBe(0);

    // « Envoyer maintenant » does not wait for the turn's end: it stops the agent, which was
    // asking again, and the message goes at once.
    await page.getByRole("button", { name: "Arrêter" }).waitFor();
    await composer.fill("Tout de suite");
    await page.getByRole("button", { name: "Mettre en file" }).click();
    await expect.poll(rows).toEqual(["Tout de suite"]);
    await queue.getByRole("button", { name: "Envoyer maintenant" }).click();
    await expect.poll(async () => (await said()).length, { timeout: 15_000 }).toBe(4);
    expect((await said())[3]).toContain("Tout de suite");
    await expect.poll(() => queue.count()).toBe(0);
    await page.close();
  });
});
