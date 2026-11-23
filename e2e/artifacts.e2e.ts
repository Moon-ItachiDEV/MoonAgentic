// « Artefacts » in the built app against a real server: the page, image and PDF an agent left
// in its thread's branch are listed, and the page is shown with its styles and images but
// without running its script.
import { execFileSync } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-artifacts-e2e-"));
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

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Maquette</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Maquette de l'accueil</h1>
    <img id="local" src="../capture.png" alt="capture" />
    <img id="dehors" src="https://example.com/espion.png" alt="" />
    <script>
      document.body.insertAdjacentHTML("beforeend", '<p id="lance">script lancé</p>');
    </script>
  </body>
</html>
`;

describe("artifacts", () => {
  it("lists what the agent made in its branch and shows it in a sandbox", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    const outside: string[] = [];
    // Asked for and blocked by the page's rules: nothing comes back from another site.
    page.on("response", (res) => {
      if (!res.url().startsWith(new URL(url).origin)) outside.push(res.url());
    });
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

    // What the agent left in its thread's folder: a page with its style, an image, a PDF.
    const worktrees = path.join(dir, "data", "worktrees");
    const [branch] = readdirSync(worktrees);
    const folder = path.join(worktrees, branch!);
    mkdirSync(path.join(folder, "maquettes"));
    writeFileSync(path.join(folder, "maquettes/accueil.html"), PAGE);
    writeFileSync(
      path.join(folder, "maquettes/style.css"),
      "body { background: rgb(250, 240, 200); font-family: sans-serif } img { width: 120px }",
    );
    const drawing = await browser.newPage({ viewport: { width: 240, height: 160 } });
    await drawing.setContent(
      '<div style="width:240px;height:160px;background:linear-gradient(135deg,#3a55d6,#0d9488)"></div>',
    );
    writeFileSync(path.join(folder, "capture.png"), await drawing.screenshot());
    await drawing.close();
    writeFileSync(path.join(folder, "rapport.pdf"), "%PDF-1.4\n%%EOF\n");

    await page.getByRole("button", { name: "Artefacts", exact: true }).click();
    await page.waitForURL(/\/artefacts$/);
    const rows = page.locator(".art-row");
    await expect.poll(() => rows.count()).toBe(3);
    await page.getByRole("button", { name: /^accueil\.html/ }).waitFor();
    await page.getByRole("button", { name: /^capture\.png/ }).waitFor();
    await page.getByRole("button", { name: /^rapport\.pdf/ }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "artefacts-liste.png") });
    await page.getByRole("button", { name: /^Images/ }).click();
    await expect.poll(() => rows.count()).toBe(1);
    await page.getByRole("button", { name: /^Tout/ }).click();

    await page.getByRole("button", { name: /^accueil\.html/ }).click();
    const frame = page.frameLocator(".art-stage iframe");
    await frame.getByRole("heading", { name: "Maquette de l'accueil" }).waitFor();
    // Its style and its image come from beside it, in the thread's folder.
    const shown = page.frames().find((f) => f.url().includes("/api/artifacts/"))!;
    await expect
      .poll(() => shown.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(250, 240, 200)");
    await expect
      .poll(() =>
        shown.evaluate(() => (document.getElementById("local") as HTMLImageElement).naturalWidth),
      )
      .toBe(240);
    // Its script did not run, and nothing was asked of another site.
    expect(await frame.locator("#lance").count()).toBe(0);
    expect(outside).toEqual([]);
    if (shots) await page.screenshot({ path: path.join(shots, "artefacts-page.png") });

    // The address works only for this thread's listed files, without the token.
    const link = await page.locator(".art-tab").getAttribute("href");
    expect(link).toMatch(/^\/api\/artifacts\/[\w-]+\/maquettes\/accueil\.html$/);
    const status = (to: string) =>
      page.evaluate(async (to) => (await fetch(to, { credentials: "omit" })).status, to);
    expect(await status(link!)).toBe(200);
    expect(await status(link!.replace("maquettes/accueil.html", "notes.md"))).toBe(404);
    expect(await status(link!.replace(/artifacts\/[\w-]+\//, "artifacts/faux/"))).toBe(404);

    await page.getByRole("button", { name: "Retour aux artefacts" }).click();
    await page.getByRole("button", { name: /^capture\.png/ }).click();
    const image = page.locator(".art-stage img");
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
    await page.getByRole("button", { name: "Retour aux artefacts" }).click();
    const pdf = page.waitForResponse((res) => res.url().endsWith("/rapport.pdf"));
    await page.getByRole("button", { name: /^rapport\.pdf/ }).click();
    const answer = await pdf;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["content-type"]).toBe("application/pdf");
    await page.getByRole("button", { name: "Ouvrir le fil" }).click();
    await page.waitForURL(/\/t\//);

    // A new file shows once the list is asked for again.
    writeFileSync(
      path.join(folder, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    await page.getByRole("button", { name: "Artefacts", exact: true }).click();
    await page.getByRole("button", { name: /^logo\.svg/ }).waitFor();
    expect(errors).toEqual([]);
    await page.close();
  });

  it("is the phone's fourth tab", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(url);
    const tabs = page.locator(".tabbar");
    await tabs.getByRole("button", { name: "Artefacts" }).click();
    await page.waitForURL(/\/artefacts$/);
    await expect
      .poll(() => tabs.getByRole("button", { name: "Artefacts" }).getAttribute("aria-current"))
      .toBe("page");
    await page.getByRole("button", { name: /^accueil\.html/ }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "artefacts-telephone.png") });
    await tabs.getByRole("button", { name: "Nouveau" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await page.close();
  });
});
