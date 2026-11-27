// The windows and the menus of an iPad or a computer, in the built app against a real server:
// a menu keeps the keyboard where it is typed in, « Nouveau projet » keeps a typed name, the
// lock's pad stays centred, a click beside a menu only closes the menu, and pulling the side
// list down opens the search only when let go far enough.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium } from "playwright";
import { addProject, whereChoices } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let repo: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-fenetres-e2e-"));
  repo = path.join(dir, "atelier");
  const home = path.join(dir, "home");
  for (const d of [repo, home]) mkdirSync(d);
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

const desk = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  return page;
};

const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

describe("fenêtres et menus (iPad, ordinateur)", () => {
  it("keeps the keyboard in the icon search while the menu shrinks", async () => {
    const page = await desk();
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("button", { name: "Icône et couleur" }).click();
    const search = page.getByLabel("Chercher une icône");
    await search.click();
    await search.pressSequentially("chat", { delay: 150 });
    await page.waitForTimeout(200);
    expect(await focused(page)).toBe("Chercher une icône");
    expect(await search.inputValue()).toBe("chat");
    await page.close();
  });

  it("keeps a name typed first when the folder or the source changes", async () => {
    const page = await desk();
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    const name = page.getByLabel("Nom du projet");
    await name.fill("Mon atelier");
    await page.getByRole("button", { name: "Autre dossier" }).click();
    expect(await name.inputValue()).toBe("Mon atelier");
    await page.getByLabel("Dossier", { exact: true }).fill(repo);
    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByRole("radio", { name: "Sur le PC" }).click();
    expect(await page.getByLabel("Nom du projet").inputValue()).toBe("Mon atelier");
    await page.close();
  });

  it("keeps the lock's pad centred in its window", async () => {
    const page = await desk();
    await addProject(page, repo, false);
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    await page.getByRole("button", { name: "Verrouiller par code" }).click();
    const sheet = page.getByRole("dialog", { name: "Choisis ton code" });
    await sheet.waitFor();
    await page.waitForTimeout(400);
    const box = (await sheet.boundingBox())!;
    const pad = (await sheet.locator(".kp").boundingBox())!;
    const title = (await sheet.locator("h3").boundingBox())!;
    const mid = box.x + box.width / 2;
    expect(Math.abs(pad.x + pad.width / 2 - mid)).toBeLessThan(3);
    expect(Math.abs(title.x + title.width / 2 - mid)).toBeLessThan(3);
    await page.close();
  });

  /** « /revue » opened in a project: a window holding the reviewers' model menus. */
  const review = async () => {
    const page = await desk();
    await addProject(page, repo);
    const composer = page.getByRole("combobox", { name: "Message" });
    await composer.fill("/revue 42");
    await composer.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Relire une PR" });
    await dialog.waitFor();
    const pill = dialog.getByRole("button", { name: /^Relecteur Anthropic : / });
    const menu = page.locator('.ddm[aria-label="Relecteur Anthropic"]');
    return { page, dialog, pill, menu };
  };

  it("closes only the menu on a click on the window's veil", async () => {
    const { page, dialog, pill, menu } = await review();
    await pill.click();
    await menu.waitFor();
    const veil = (await page.locator(".sscrim.on").boundingBox())!;
    await page.mouse.click(veil.x + 12, veil.y + 12);
    await menu.waitFor({ state: "detached" });
    await page.waitForTimeout(600);
    expect(await dialog.getAttribute("inert")).toBeNull();
    expect(await pill.isVisible()).toBe(true);
    await page.close();
  });

  it("opens again on the next click after a press let go beside its button", async () => {
    const { page, pill, menu } = await review();
    await pill.click();
    await menu.waitFor();
    const b = (await pill.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y - 60);
    await page.mouse.up();
    await menu.waitFor({ state: "detached" });
    await pill.click();
    await menu.waitFor({ timeout: 2000 });
    await page.close();
  });

  it("leaves no « Projet » menu behind once a project is picked from the « + »", async () => {
    const page = await desk();
    await addProject(page, repo);
    await page.getByRole("combobox", { name: "Message" }).click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Projet/ }).click();
    const where = whereChoices(page);
    await where.waitFor();
    await where
      .getByText(/^Hors projet/)
      .first()
      .click();
    expect(await where.count()).toBe(0);
    await page.close();
  });
});

describe("tirer la liste vers le bas (iPad)", () => {
  const touch = async () => {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
      isMobile: true,
    });
    await page.goto(url);
    await page.locator(".dtop .srch").waitFor();
    const cdp = await page.context().newCDPSession(page);
    const at = (await page.locator(".dscroll").boundingBox())!;
    const x = at.x + at.width / 2;
    const y = at.y + 30;
    const send = (type: string, dy = 0, dx = 0) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd" || type === "touchCancel" ? [] : [{ x: x + dx, y: y + dy }],
      });
    const searching = async () => {
      await page.waitForTimeout(600);
      return (await page.locator(".dtop .srch").count()) === 0;
    };
    return { page, send, searching };
  };

  const down = async (
    send: (t: string, dy?: number, dx?: number) => Promise<unknown>,
    to: number,
  ) => {
    await send("touchStart");
    for (let dy = 20; dy <= to; dy += 20) await send("touchMove", dy);
  };

  it("opens the search when let go far enough", async () => {
    const { page, send, searching } = await touch();
    await down(send, 200);
    await send("touchEnd");
    expect(await searching()).toBe(true);
    await page.close();
  });

  it("does not open it when pulled back up before letting go", async () => {
    const { page, send, searching } = await touch();
    await down(send, 200);
    for (let dy = 180; dy >= -20; dy -= 20) await send("touchMove", dy);
    await send("touchEnd");
    expect(await searching()).toBe(false);
    expect(await page.locator(".srch.armed").count()).toBe(0);
    await page.close();
  });

  it("does not open it when pulled back above its start in one move", async () => {
    const { page, send, searching } = await touch();
    await down(send, 200);
    await send("touchMove", -10);
    await send("touchEnd");
    expect(await searching()).toBe(false);
    await page.close();
  });

  it("does not open it when the touch is cancelled", async () => {
    const { page, send, searching } = await touch();
    await down(send, 200);
    await send("touchCancel");
    expect(await searching()).toBe(false);
    await page.close();
  });

  it("does not open it on a sideways swipe", async () => {
    const { page, send, searching } = await touch();
    await send("touchStart");
    for (let i = 1; i <= 10; i++) await send("touchMove", i * 16, i * -40);
    await send("touchEnd");
    expect(await searching()).toBe(false);
    await page.close();
  });
});
