// Skills installed from the app, in the built app against a real server: listed, given to
// other agents, removed, and installed by a command shown before it runs.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../apps/server/src/store.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let home: string;

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
/**
 * A command line that runs these lines of Node: the same in sh and in cmd.exe, where the
 * server runs what the user typed on Windows.
 */
const nodeLine = (lines: string[]) => {
  const script = path.join(mkdtempSync(path.join(dir, "script-")), "steps.mjs");
  writeFileSync(script, `${lines.join("\n")}\n`);
  return `"${process.execPath}" "${script}"`;
};
/** Lines of Node that print `prompt` and wait for a line typed in, kept as `answer`. */
const askLine = (prompt: string) => [
  `process.stdout.write(${JSON.stringify(prompt)});`,
  "let answer = '';",
  "process.stdin.setEncoding('utf8');",
  "for await (const chunk of process.stdin) {",
  "  answer += chunk;",
  "  if (answer.includes('\\n')) break;",
  "}",
  "answer = answer.trim();",
];
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-skills-e2e-"));
  home = path.join(dir, "home");
  put(path.join(home, ".claude/skills/pdf/SKILL.md"), skillMd("pdf", "Lire des PDF"));
  put(path.join(dir, "Alpha/.agents/skills/docx/SKILL.md"), skillMd("docx", "Écrire du Word"));
  mkdirSync(path.join(dir, "data"));
  const store = new Store(path.join(dir, "data", "state.sqlite"));
  store.addProject({ id: "alpha", name: "Alpha", path: path.join(dir, "Alpha"), createdAt: 0 });
  store.close();
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_HOME: path.join(home, ".hermes"),
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

const shot = async (page: Page, name: string) => {
  if (!shots) return;
  // Once the windows have settled.
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/** Réglages › Skills, opened by its address once the page knows its token. */
async function openSkills(page: Page) {
  await page.goto(url);
  await page.locator("#scr").waitFor();
  await page.goto(new URL("/reglages/skills", url).toString());
  const region = page.getByRole("region", { name: "Skills" });
  await region.getByRole("button", { name: "Installer une skill" }).waitFor();
  return region;
}

const SIZES = {
  desk: { width: 1280, height: 820 },
  ipad: { width: 1024, height: 768 },
  phone: { width: 390, height: 844 },
} as const;

describe("skills", () => {
  it("lists the skills of every project and of a project, and gives one to another agent", async () => {
    const page = await browser.newPage({ viewport: SIZES.desk });
    const region = await openSkills(page);
    const pdf = region.getByRole("button", { name: /^pdf/ });
    await pdf.waitFor();
    expect(await pdf.locator("small").textContent()).toBe("Trouvée sur le PC · Claude Code");
    expect(await region.getByRole("button", { name: /^docx/ }).locator("small").textContent()).toBe(
      "Trouvée sur le PC · Codex",
    );
    await shot(page, "skills-desk");

    // Its window hangs from its line.
    await pdf.click();
    const pop = page.getByRole("dialog", { name: "pdf" });
    await pop.waitFor();
    const lineBox = (await pdf.boundingBox())!;
    const popBox = (await pop.boundingBox())!;
    expect(popBox.y).toBeGreaterThan(lineBox.y);
    await shot(page, "skill-detail-desk");
    await pop.getByRole("switch", { name: "Codex" }).click();
    await expect.poll(() => existsSync(path.join(home, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    await expect
      .poll(() => pdf.locator("small").textContent())
      .toBe("Trouvée sur le PC · Claude Code, Codex");
    // The last agent cannot be taken off.
    await pop.getByRole("switch", { name: "Claude Code" }).click();
    await expect.poll(() => pop.getByRole("switch", { name: "Codex" }).isDisabled()).toBe(true);
    expect(existsSync(path.join(home, ".claude/skills/pdf"))).toBe(false);

    // Moved to the project, then removed.
    await pop.getByRole("button", { name: /^Projets/ }).click();
    await page.getByRole("menuitemradio", { name: "Alpha" }).click();
    await expect
      .poll(() => existsSync(path.join(dir, "Alpha/.agents/skills/pdf/SKILL.md")))
      .toBe(true);
    await expect.poll(() => pop.isVisible()).toBe(false);
    const moved = region.getByRole("button", { name: /^pdf/ });
    await moved.click();
    const again = page.getByRole("dialog", { name: "pdf" });
    await again.getByRole("button", { name: "Retirer cette skill" }).click();
    await again.getByRole("button", { name: "Retirer pdf" }).click();
    await expect.poll(() => moved.count()).toBe(0);
    expect(existsSync(path.join(dir, "Alpha/.agents/skills/pdf"))).toBe(false);
    await page.close();
  });

  for (const [device, size] of Object.entries(SIZES)) {
    it(`installs by a command shown before it runs, and answers it (${device})`, async () => {
      const page = await browser.newPage({ viewport: size });
      const region = await openSkills(page);
      const name = `demo-${device}`;
      await region.getByRole("button", { name: "Installer une skill" }).click();
      await shot(page, `skill-menu-${device}`);
      await page.getByRole("menuitem", { name: "Par commande" }).click();
      const pop = page.getByRole("dialog", { name: "Par commande" });
      const command = nodeLine([
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        ...askLine("Ok to proceed? (y) "),
        `mkdirSync('.claude/skills/${name}', { recursive: true });`,
        `writeFileSync('.claude/skills/${name}/SKILL.md', '---\\ndescription: Démo\\n---\\n');`,
        "console.log('got ' + answer);",
      ]);
      await pop.getByLabel("Commande").fill(command);
      await shot(page, `skill-commande-${device}`);
      await pop.getByRole("button", { name: "Voir ce qui va tourner" }).click();

      // Nothing runs before « Lancer ».
      const ask = page.getByRole("dialog", { name: "Lancer la commande ?" });
      await ask.getByText(home, { exact: true }).waitFor();
      await ask.getByText("Script tiers").waitFor();
      await shot(page, `skill-lancer-${device}`);
      expect(existsSync(path.join(home, ".claude/skills", name))).toBe(false);
      await ask.getByRole("button", { name: "Lancer" }).click();

      const running = page.getByRole("dialog", { name: "Installation" });
      const answer = running.getByLabel("Réponse au script");
      await answer.waitFor();
      await shot(page, `skill-cours-${device}`);
      await answer.fill("y");
      await running.getByRole("button", { name: "Envoyer" }).click();

      const done = page.getByRole("dialog", { name: "Terminée" });
      await done.getByText("Skills ajoutées").waitFor();
      await done.locator(".it", { hasText: name }).getByText("Nouvelle").waitFor();
      await done.getByText("got y").waitFor();
      await shot(page, `skill-fin-${device}`);
      await done.getByRole("button", { name: "Terminé" }).click();
      const row = region.getByRole("button", { name: new RegExp(`^${name}`) });
      expect(await row.locator("small").textContent()).toBe("Commande · Claude Code");
      expect(readFileSync(path.join(home, ".claude/skills", name, "SKILL.md"), "utf8")).toContain(
        "Démo",
      );
      await page.close();
    });
  }

  it("starts a command once when « Lancer » is pressed twice, and keeps its window while it runs", async () => {
    const page = await browser.newPage({ viewport: SIZES.desk });
    const region = await openSkills(page);
    const install = region.getByRole("button", { name: "Installer une skill" });
    await install.click();
    await page.getByRole("menuitem", { name: "Par commande" }).click();
    const pop = page.getByRole("dialog", { name: "Par commande" });
    await pop
      .getByLabel("Commande")
      .fill(
        nodeLine([
          "import { appendFileSync } from 'node:fs';",
          "appendFileSync('compte.txt', 'x\\n');",
          ...askLine("Encore ? "),
          "console.log('fin');",
        ]),
      );
    await pop.getByRole("button", { name: "Voir ce qui va tourner" }).click();
    await page
      .getByRole("dialog", { name: "Lancer la commande ?" })
      .getByRole("button", { name: "Lancer" })
      .dblclick();
    const running = page.getByRole("dialog", { name: "Installation" });
    await running.getByLabel("Réponse au script").waitFor();
    // Its button pressed again while it runs: the window stays.
    await install.click();
    await page.waitForTimeout(400);
    expect(await running.isVisible()).toBe(true);
    await running.getByLabel("Réponse au script").fill("n");
    await running.getByRole("button", { name: "Envoyer" }).click();
    await page.getByRole("dialog", { name: "Terminée" }).getByText("fin").waitFor();
    await page.waitForTimeout(300);
    expect(readFileSync(path.join(home, "compte.txt"), "utf8")).toBe("x\n");
    await page.close();
  });

  it("writes from the project's settings a skill just installed there", async () => {
    const page = await browser.newPage({ viewport: SIZES.desk });
    await page.goto(url);
    await page.locator("#scr").waitFor();
    await page.goto(new URL("/p/alpha", url).toString());
    await page.getByRole("button", { name: "Paramètres du projet" }).click();
    const dialog = page.getByRole("dialog", { name: "Paramètres du projet" });
    await dialog
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Mémoire" })
      .click();
    const skills = dialog;
    await skills.getByRole("button", { name: /^docx/ }).waitFor();
    await skills.getByRole("button", { name: "Installer une skill" }).click();
    await page.getByRole("menuitem", { name: "Par commande" }).click();
    const pop = page.getByRole("dialog", { name: "Par commande" });
    await pop
      .getByRole("button", { name: /^Projets/ })
      .getByText("Alpha")
      .waitFor();
    await pop
      .getByLabel("Commande")
      .fill(
        nodeLine([
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "mkdirSync('.claude/skills/neuve', { recursive: true });",
          "writeFileSync('.claude/skills/neuve/SKILL.md', '---\\nname: neuve\\ndescription: Neuve\\n---\\nFais ceci.\\n');",
        ]),
      );
    await pop.getByRole("button", { name: "Voir ce qui va tourner" }).click();
    await page
      .getByRole("dialog", { name: "Lancer la commande ?" })
      .getByRole("button", { name: "Lancer" })
      .click();
    await page
      .getByRole("dialog", { name: "Terminée" })
      .getByRole("button", { name: "Terminé" })
      .click();
    const row = skills.getByRole("button", { name: /^neuve/ });
    await row.click();
    const detail = page.getByRole("dialog", { name: "neuve" });
    await detail.getByRole("button", { name: "Modifier" }).click();
    await expect.poll(() => skills.getByLabel("Instructions").inputValue()).toContain("Fais ceci.");
    await page.close();
  });
});
