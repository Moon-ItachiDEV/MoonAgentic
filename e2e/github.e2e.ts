// « Se connecter à GitHub » in the built app against a real server and a stand-in github.com:
// the code to type, the list of repositories, where a clone goes, and a clone found on disk.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneButton, createButton } from "./ui.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let fake: Server;
let browser: Browser;
let url: string;
let dir: string;
let home: string;
/** Set once the stand-in should say the user said yes on GitHub. */
let approved = false;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-gh-e2e-"));
  home = path.join(dir, "home");
  // A clone already in the home folder, as GitHub Desktop would leave it.
  const desktop = path.join(home, "Documents", "GitHub", "site");
  mkdirSync(desktop, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: desktop, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/moon/site.git");

  fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/login/device/code") {
      res.end(
        JSON.stringify({
          device_code: "dev",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0.2,
        }),
      );
    } else if (req.url === "/login/oauth/access_token") {
      res.end(
        JSON.stringify(approved ? { access_token: "gho_e2e" } : { error: "authorization_pending" }),
      );
    } else if (req.url === "/user") {
      res.end(JSON.stringify({ login: "moon" }));
    } else if (req.url?.startsWith("/user/repos")) {
      res.end(
        JSON.stringify([
          { full_name: "moon/app", private: true, description: "L'appli", pushed_at: null },
          { full_name: "moon/site", private: false, description: "Le site", pushed_at: null },
          { full_name: "moon-org/outils", private: false, description: null, pushed_at: null },
        ]),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const github = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  // Only git and node: a GitHub CLI installed here must not sign in for the user.
  const gitDir = path.dirname(
    execFileSync(process.platform === "win32" ? "where" : "which", ["git"])
      .toString()
      .split(/\r?\n/)[0]!,
  );
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: [gitDir, path.dirname(process.execPath)].join(path.delimiter),
        MOONAGENTIC_GITHUB_URL: github,
        MOONAGENTIC_GITHUB_API_URL: github,
        DBUS_SESSION_BUS_ADDRESS: "",
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
  fake?.close();
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

describe("GitHub sign-in", () => {
  it("signs in with a code, lists the repositories and reuses a clone on disk", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: Error[] = [];
    page.on("pageerror", (err) => errors.push(err));
    const shot = async (name: string, p = page) => {
      if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`) });
    };
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "GitHub" }).click();
    const signIn = page.getByRole("button", { name: "Se connecter" });
    await signIn.waitFor();
    await shot("g1-se-connecter");

    await signIn.click();
    const code = page.getByLabel("Code à taper sur GitHub");
    await expect.poll(() => code.textContent()).toBe("WDJB-MJHT");
    await shot("g2-code");

    // The user says yes on GitHub: the dialog goes on by itself.
    approved = true;
    const list = page.getByRole("group", { name: "Tes dépôts GitHub" });
    await expect.poll(() => list.getByRole("button").count()).toBe(3);
    await list.getByText("Sur le PC").waitFor();
    await shot("g3-depots");

    // The token stays on the server, sealed there: never in the page.
    const html = await page.content();
    expect(html).not.toContain("gho_e2e");
    if (process.platform === "win32") {
      // Sealed by Windows for this account: the file does not hold it as it is.
      const sealed = readFileSync(path.join(dir, "data", "github-token.dpapi"));
      expect(sealed.length).toBeGreaterThan(0);
      expect(sealed.includes("gho_e2e")).toBe(false);
    } else {
      // No keyring on the test machine: kept in a file of the server's own.
      expect(readFileSync(path.join(dir, "data", "github-token"), "utf8")).toBe("gho_e2e");
    }

    // Picked, a repository says where its clone goes; picked again, it is let go.
    await list.getByRole("button", { name: /^app/ }).click();
    await page.getByRole("button", { name: /^Emplacement/ }).waitFor();
    await cloneButton(page).waitFor();
    await shot("g4-ou-va-le-clone");
    await list.getByRole("button", { name: /^app/ }).click();

    await list.getByRole("button", { name: /^site/ }).click();
    await page.getByRole("status").getByText("Déjà sur le PC").waitFor();
    await shot("g5-deja-clone");
    await createButton(page).click();
    await page.waitForURL(/\/p\//);

    // Opened again, the same repository is now a project: it opens, nothing is cloned.
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "GitHub" }).click();
    await list.getByText("Projet", { exact: true }).waitFor();

    // On a phone, the dialog fits the screen.
    const phone = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await phone.goto(url);
    await phone
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Projets" })
      .click();
    await phone.getByRole("menuitem", { name: "Nouveau projet" }).click();
    await phone.getByRole("radio", { name: "GitHub" }).click();
    await phone
      .getByRole("group", { name: "Tes dépôts GitHub" })
      .getByRole("button", { name: /^app/ })
      .waitFor();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    // Once the menu has slid away and the dialog has settled.
    if (shots) await phone.waitForTimeout(500);
    await shot("g6-mobile", phone);
    await phone.close();
    expect(errors).toEqual([]);
    await page.close();
  });
});
