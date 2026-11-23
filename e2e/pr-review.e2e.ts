// « /revue » in the built app: a pull request read by several agents at once, against a real
// server, the demo agents and a stand-in `gh`.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-review-e2e-"));
  repo = path.join(dir, "demo");
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  for (const d of [repo, home, bin]) mkdirSync(d);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/answer.ts"), "export const answer = 41;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://github.com/moon/demo.git");
  // The pull request is a branch of this repository: its commits need no network.
  git("checkout", "-q", "-b", "answer");
  writeFileSync(
    path.join(repo, "src/answer.ts"),
    "export const answer = 42;\nexport const check = (n: number) => n === answer;\n",
  );
  git("commit", "-q", "-am", "La réponse");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  writeFileSync(
    path.join(dir, "pr.json"),
    JSON.stringify({
      number: 42,
      url: "https://github.com/moon/demo/pull/42",
      title: "Donne enfin la bonne réponse",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: head,
      baseRefName: "main",
      statusCheckRollup: [],
    }),
  );
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      `  "pr view") cat "${dir}/pr.json" ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        // Slow enough to see the reviewers at work.
        MOONAGENTIC_DEMO_DELAY_MS: shots ? "120" : "20",
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

describe("/revue", () => {
  // The stand-in « gh » is a POSIX shell script that Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "has three agents read the pull request and shows their findings put together",
    async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors: Error[] = [];
      page.on("pageerror", (err) => errors.push(err));
      const shot = async (name: string) => {
        if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
      };
      await page.goto(url);
      await page.getByRole("button", { name: "Nouveau projet" }).first().click();
      await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
      await page.getByLabel("Dossier", { exact: true }).fill(repo);
      await page.getByRole("button", { name: "Ajouter le projet" }).click();
      const composer = page.getByRole("combobox", { name: "Message" });
      await expect.poll(() => composer.isEnabled()).toBe(true);

      // The command is on offer, then opens its dialog with the number typed after it.
      await composer.fill("/rev");
      await page.getByRole("option", { name: /revue/ }).first().waitFor();
      await composer.fill("/revue 42");
      await composer.press("Enter");
      const dialog = page.getByRole("dialog", { name: /Relire une PR/ });
      await dialog.waitFor();
      expect(await dialog.getByLabel("Numéro ou adresse de la PR").inputValue()).toBe("42");
      // The demo agents stand in for the three makers; their models come once asked.
      const pick = async (label: string, value: string) => {
        const select = dialog.getByLabel(label);
        await expect
          .poll(() =>
            select.evaluate(
              (el, v) => [...(el as HTMLSelectElement).options].some((o) => o.value === v),
              value,
            ),
          )
          .toBe(true);
        await select.selectOption(value);
      };
      await pick("Relecteur OpenAI", "demo\nrapide");
      await pick("Relecteur Anthropic", "demo-2\nprecis");
      await pick("Relecteur Google", "demo-2\nrapide");
      await pick("Arbitre", "demo\nprecis");
      await shot("r1-dialogue");
      await dialog.getByRole("button", { name: "Lancer la revue" }).click();

      const card = page.getByRole("region", { name: "Revue de la PR #42" });
      await card.waitFor();
      await card.getByText("Donne enfin la bonne réponse").waitFor();
      await card.getByText(/Relecture en cours/).waitFor();
      await shot("r2-en-cours");

      // Then they weigh each other's points, and the judge settles the one still disputed.
      // Seen only when slowed down for the captures: otherwise it may be over at once.
      if (shots) {
        await card.getByText(/Confrontation ·/).waitFor({ timeout: 30_000 });
        await shot("r3-confrontation");
      }
      await card.getByText("Relue par les 3").waitFor({ timeout: 30_000 });
      await card.getByText("1 point tranché").waitFor();
      await card.getByText("Confirmés").waitFor();
      const ruled = card.locator(".prr-pt", { has: page.locator(".prr-ruling") });
      expect(await ruled.locator(".prr-ruling").textContent()).toContain("Arbitre : réel");
      expect(await ruled.locator(".prr-sev").textContent()).toBe("Mineur");
      // Lines 1 and 2 of the file changed are one point, seen by all three, worst first.
      const first = card.locator(".prr-pt").first();
      expect(await first.locator(".prr-sev").textContent()).toBe("Critique");
      expect(await first.locator(".prr-at").textContent()).toBe("src/answer.ts:1");
      expect(await first.locator(".prr-by .ag").count()).toBe(3);
      await first.getByText(/Gravité discutée/).waitFor();
      await first.locator(".prr-pt-h").click();
      await first.locator(".prr-notes li").first().waitFor();
      await ruled.locator(".prr-pt-h").click();
      await ruled.locator(".prr-vote.disagree").first().waitFor();
      await shot("r4-synthese");

      // Each reviewer has its own thread, which leads back to the review.
      await card.getByRole("button", { name: "Ouvrir" }).first().click();
      await page.getByRole("button", { name: /Relecteur de la « Revue de la PR #42 »/ }).click();
      await card.waitFor();

      await page.emulateMedia({ colorScheme: "dark" });
      await shot("r5-synthese-sombre");
      await page.emulateMedia({ colorScheme: "light" });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await card.getByText("Relue par les 3").waitFor();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(390);
      await shot("r6-mobile");

      expect(errors).toEqual([]);
      await page.close();
    },
  );
});
