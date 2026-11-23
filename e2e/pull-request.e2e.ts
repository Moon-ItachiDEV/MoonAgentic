// The pull request of a thread's branch in the review panel, and links to pull requests in
// the conversation, in the built app against a real server and a stand-in `gh`.
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

const HEAD = "a".repeat(40);
const run = (name: string, status: string, conclusion: string) => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status,
  conclusion,
  detailsUrl: "https://github.com/moon/demo/actions/runs/1",
});
/** What the stand-in GitHub says of pull request 42 from now on. */
function github(over: Record<string, unknown>) {
  writeFileSync(
    path.join(dir, "pr.json"),
    JSON.stringify({
      number: 42,
      url: "https://github.com/moon/demo/pull/42",
      title: "Ajoute le suivi des PR",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: HEAD,
      baseRefName: "main",
      statusCheckRollup: [],
      ...over,
    }),
  );
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-pr-e2e-"));
  repo = path.join(dir, "demo");
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  for (const d of [repo, home, bin]) mkdirSync(d);
  writeFileSync(path.join(repo, "README.md"), "# Démo\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://github.com/moon/demo.git");
  // A stand-in for the user's GitHub CLI: it answers from pr.json, and a merge rewrites it.
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      `f="${dir}/pr.json"`,
      'case "$1 $2" in',
      '  "pr view") if [ -f "$f" ]; then cat "$f"; else echo "no pull requests found for branch" >&2; exit 1; fi ;;',
      `  "pr merge") sed 's/"OPEN"/"MERGED"/' "$f" > "$f.new" && mv "$f.new" "$f"; echo "$@" >> "${dir}/merged.log" ;;`,
      `  "repo view") echo '{"mergeCommitAllowed":true}' ;;`,
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
      },
      stdio: "pipe",
    },
  );
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /http:\/\/\S+\?token=\S+/.exec(out);
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

describe("pull requests", () => {
  // The stand-in « gh » is a POSIX shell script that Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "follows the thread's pull request: CI, conflicts, merge, and colors its links",
    async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
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
      await page.locator(".agentchip").click();
      await page.getByRole("button", { name: "Tous", exact: true }).click();
      await page.getByRole("button", { name: "Options", exact: true }).click();
      await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
      await page.keyboard.press("Escape");

      // No pull request yet: its link in the conversation has no state, so no color.
      await composer.fill("Regarde https://github.com/moon/demo/pull/42 et dis-moi");
      await composer.press("Enter");
      const chip = page.locator(".md a.prchip").first();
      await chip.waitFor();
      expect(await chip.textContent()).toBe("#42");
      expect(await chip.getAttribute("href")).toBe("https://github.com/moon/demo/pull/42");
      expect(await chip.getAttribute("data-state")).toBeNull();

      // Nothing about a pull request in the panel while GitHub knows none.
      await page.getByRole("button", { name: /^Code/ }).click();
      const panel = page.getByRole("complementary", { name: "À revoir" });
      await panel.waitFor();
      expect(await panel.getByLabel("Pull request").count()).toBe(0);
      await page.getByRole("button", { name: "Fermer la revue" }).click();

      // The pull request exists, its CI runs: the panel says so when opened.
      github({
        statusCheckRollup: [run("Lint", "COMPLETED", "SUCCESS"), run("Tests", "IN_PROGRESS", "")],
      });
      await page.getByRole("button", { name: /^Code/ }).click();
      const pr = panel.getByLabel("Pull request");
      await pr.getByText("CI en cours · 1 sur 2 terminés").waitFor();
      expect(await pr.locator(".prchip").getAttribute("data-state")).toBe("open");
      // What the panel learned colors the link in the conversation too.
      await expect.poll(() => chip.getAttribute("data-state")).toBe("open");

      // Red CI names the failed check; a conflict holds the merge back.
      github({
        mergeable: "CONFLICTING",
        statusCheckRollup: [
          run("Lint", "COMPLETED", "SUCCESS"),
          run("Tests", "COMPLETED", "FAILURE"),
        ],
      });
      await pr.getByRole("button", { name: "Actualiser" }).click();
      await pr.getByText("CI rouge · 1 check en échec").waitFor();
      await pr.getByRole("link", { name: "Tests" }).waitFor();
      await pr.getByText("Conflits avec main").waitFor();
      const merge = pr.getByRole("button", { name: "Merger la pull request" });
      expect(await merge.isDisabled()).toBe(true);
      await shot("pr2-rouge-conflit");

      // All green: merging asks first, then the pull request turns violet everywhere.
      github({
        statusCheckRollup: [
          run("Lint", "COMPLETED", "SUCCESS"),
          run("Tests", "COMPLETED", "SUCCESS"),
        ],
      });
      await pr.getByRole("button", { name: "Actualiser" }).click();
      await pr.getByText("CI verte · 2 checks passés").waitFor();
      await pr.getByText("Pas de conflit avec main").waitFor();
      await shot("pr1-verte");
      await merge.click();
      const confirm = page.getByRole("alertdialog", { name: "Merger la pull request #42 ?" });
      await confirm.getByText("sera mergée dans main").waitFor();
      await confirm.getByRole("button", { name: "Merger" }).click();
      await pr.getByText("Mergée dans main.", { exact: true }).waitFor();
      expect(await pr.locator(".prchip").getAttribute("data-state")).toBe("merged");
      await expect.poll(() => chip.getAttribute("data-state")).toBe("merged");
      expect(await merge.count()).toBe(0);
      await shot("pr3-mergee");

      // On a phone, nothing is wider than the screen.
      await page.setViewportSize({ width: 390, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await shot("pr4-mobile");
      expect(errors).toEqual([]);
      await page.close();
    },
  );
});
