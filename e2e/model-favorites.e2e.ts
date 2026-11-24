// Réglages › Modèles in the built app: reading an agent's models, starring them, and the
// order of the favorites wheel, which a second window, as another device, sees at once.
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-favorites-e2e-"));
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

describe("Réglages › Modèles", () => {
  it("picks favorites from the settings and orders the wheel", async () => {
    const one = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const two = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const errors: Error[] = [];
    for (const page of [one, two]) page.on("pageerror", (err) => errors.push(err));
    await one.goto(at("models"));
    await two.goto(at("models"));
    await one.getByText("Aucun favori pour l'instant").waitFor();
    if (shots) await one.screenshot({ path: path.join(shots, "favoris-1-vide.png") });

    // The demo agents never started: their models are read on demand.
    for (const name of ["Agent de démo", "Second agent de démo"]) {
      await one
        .locator(".mf-grp", { has: one.getByText(name, { exact: true }) })
        .getByRole("button", { name: "Lire ses modèles" })
        .click();
    }
    const add = (page: typeof one, name: string) =>
      page.getByRole("button", { name: `Ajouter ${name} aux favoris` });
    await expect.poll(() => add(one, "Démo précis").count(), { timeout: 60_000 }).toBe(2);

    await add(one, "Démo précis").first().click();
    await expect.poll(() => add(one, "Démo rapide").count(), { timeout: 30_000 }).toBe(2);
    await add(one, "Démo rapide").first().click();
    await expect.poll(() => add(one, "Démo rapide").count(), { timeout: 30_000 }).toBe(1);
    await add(one, "Démo rapide").first().click();

    const order = (page: typeof one) =>
      page
        .locator(".mf-fav")
        .evaluateAll((rows) =>
          rows.map(
            (r) =>
              `${r.querySelector("[data-agent]")?.getAttribute("data-agent") ?? ""} ${r.querySelector("b")?.textContent}`,
          ),
        );
    await expect.poll(() => order(one), { timeout: 30_000 }).toHaveLength(3);
    const starred = await order(one);
    if (shots) await one.screenshot({ path: path.join(shots, "favoris-2-liste.png") });

    // The last one goes first with the keyboard; the other window follows.
    const grips = one.getByRole("button", { name: /^Déplacer / });
    await grips.nth(2).focus();
    await one.keyboard.press("ArrowUp");
    await one.keyboard.press("ArrowUp");
    const moved = [starred[2], starred[0], starred[1]];
    await expect.poll(() => order(one), { timeout: 30_000 }).toEqual(moved);
    await expect.poll(() => order(two), { timeout: 30_000 }).toEqual(moved);

    // And back down by dragging its handle under the next line.
    const handle = await grips.nth(0).boundingBox();
    const next = await one.locator(".mf-fav").nth(1).boundingBox();
    if (!handle || !next) throw new Error("Lignes introuvables.");
    await one.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await one.mouse.down();
    await one.mouse.move(handle.x + handle.width / 2, next.y + next.height - 4, { steps: 8 });
    await one.mouse.up();
    await expect
      .poll(() => order(two), { timeout: 30_000 })
      .toEqual([starred[0], starred[2], starred[1]]);
    if (shots) await two.screenshot({ path: path.join(shots, "favoris-3-mobile.png") });

    // A search that finds nothing says so.
    await one.getByRole("searchbox", { name: "Rechercher un modèle" }).fill("zzz");
    await one.getByText("Aucun modèle ne contient « zzz ».").waitFor();
    await one.getByRole("searchbox", { name: "Rechercher un modèle" }).fill("");

    // Taken out from the list, it is a model like any other again.
    await one
      .getByRole("button", { name: /^Retirer .* des favoris$/ })
      .first()
      .click();
    await expect.poll(() => order(two), { timeout: 30_000 }).toHaveLength(2);
    expect(errors).toEqual([]);
    await one.close();
    await two.close();
  });
});
