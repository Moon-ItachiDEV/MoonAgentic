// Réglages › Hermes · Discord in the built app, opened directly as after a reload.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

function routeUrl(routePath: string) {
  const parsed = new URL(url);
  parsed.pathname = routePath;
  return parsed.href;
}

/** The PATH without the folders holding a `hermes` command. */
function withoutHermes(): string {
  const names = ["hermes", "hermes.exe", "hermes.cmd", "hermes.bat"];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => !names.some((name) => existsSync(path.join(dir, name))))
    .join(path.delimiter);
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-hermes-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      // Never the Hermes of the machine running the test: Connecter would set it up.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_HOME: home,
        PATH: withoutHermes(),
      },
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

describe("Réglages › Hermes · Discord", () => {
  it("se charge ouvert directement, et garde une adresse refusée dans son champ", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    // Straight to the page, as a link or a reload: the connection is not open yet.
    await page.goto(routeUrl("/reglages/hermes"));
    const connect = page.getByRole("button", { name: "Connecter", exact: true });
    await connect.waitFor({ timeout: 15_000 });
    expect(await page.getByText("Connexion coupée").count()).toBe(0);

    await connect.click();
    await page.getByRole("button", { name: "Copier le réglage pour config.yaml", exact: true }).waitFor();

    const field = page.getByLabel("Adresse du webhook Discord");
    await field.fill("https://exemple.fr/pas-discord");
    await page.getByRole("button", { name: "Enregistrer le webhook", exact: true }).click();
    await page.getByText("Ce n'est pas l'adresse d'un webhook Discord").waitFor();
    expect(await field.inputValue()).toBe("https://exemple.fr/pas-discord");

    await field.fill("https://discord.com/api/webhooks/123456/abc-DEF_9");
    await page.getByRole("button", { name: "Enregistrer le webhook", exact: true }).click();
    await page.getByRole("button", { name: "Envoyer un message de test", exact: true }).waitFor();
    await page.getByRole("button", { name: "Retirer le webhook", exact: true }).click();
    await page.getByLabel("Adresse du webhook Discord").waitFor();
    expect(await page.getByLabel("Adresse du webhook Discord").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await page.close();
  });
});
