// First end-to-end check: the built app, the real server, the demo agent, a real browser.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { addProject, allModelsButton, pickAgent, setAccess, showAgents } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;
let project: string;
/** A git repository, for the team: each coder works on its own branch. */
let repo: string;

function write(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), content);
  }
}

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-e2e-"));
  project = path.join(dir, "projet");
  write(project, {
    "src/app.ts": "export const answer = 41;\n",
    "README.md": "# Démo\n",
    ".claude/skills/revue/SKILL.md": "---\nname: revue\ndescription: Relit le code\n---\nRelis.\n",
    ".moonagentic/commands/deploy.md":
      "---\ndescription: Déploie la branche\n---\nDéploie $ARGUMENTS.\n",
  });
  repo = path.join(dir, "equipe");
  write(repo, { "src/app.ts": "export const answer = 41;\n", "README.md": "# Équipe\n" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  // The team commits each piece and merges them, as the user would.
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const home = path.join(dir, "home");
  mkdirSync(home);
  // A stand-in for the user's signed-in GitHub CLI: it knows one account and its repositories.
  const bin = path.join(dir, "bin");
  write(bin, {
    gh: [
      "#!/bin/sh",
      'case "$2" in',
      "  user) echo moon ;;",
      `  user/repos*) echo '{"f":"moon/app","p":false,"d":"Une appli","t":null}'; echo '{"f":"moon/site","p":true,"d":null,"t":null}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  });
  chmodSync(path.join(bin, "gh"), 0o755);
  const PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    // A home of its own, so the user's personal skills stay out of the test.
    { cwd: root, env: { ...process.env, PATH, HOME: home, USERPROFILE: home }, stdio: "pipe" },
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
/** The model pill of the composer, which names who answers. It shows with the composer open. */
const pill = (page: Page) => page.getByRole("button", { name: /^Agent : / });
/** The sidebar, and its pages. */
const menu = (page: Page) => page.getByRole("complementary", { name: "Menu" });
const pages = (page: Page) => page.getByRole("navigation", { name: "Pages" });

const options = (page: Page) => page.locator("#composer-suggest [role=option]");
/**
 * Back to « Demande d'abord » for a new thread: the defaults are the server's, so a test
 * before may have left them on full access.
 */
async function supervised(page: Page) {
  await setAccess(page, /Demande d'abord/);
}

describe("composer", () => {
  it("offers commands, files and skills, sends them, pins the thread and finds it again", async () => {
    // The port is chosen by the system; the address printed is the one to open.
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);

    await addProject(page, project);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // The demo agent, not a real one that may be installed on this machine.
    await pickAgent(page);
    await composer(page).click();
    // Its pill names the agent until its models are read, then the model: its label says both.
    await expect.poll(() => pill(page).getAttribute("aria-label")).toContain("Agent de démo");

    // `/` lists MoonAgentic's ready-made messages and the project's commands.
    await composer(page).fill("/dep");
    await expect.poll(() => options(page).first().textContent()).toContain("/deploy");
    await shot(page, "c1-commandes");
    await composer(page).press("Escape");
    expect(await options(page).count()).toBe(0);
    await composer(page).fill("");
    // A command that takes arguments waits for them instead of sending its message bare.
    await composer(page).fill("/dep");
    await options(page).first().waitFor();
    await composer(page).press("Enter");
    expect(await composer(page).inputValue()).toBe("/deploy ");
    await composer(page).fill("");
    await composer(page).fill("/revi");
    await composer(page).press("Enter");
    await expect.poll(() => composer(page).inputValue()).toContain("Relis les changements");
    // `/` opens the commands after a space in the middle of a message too, and the picked one
    // goes in place.
    await composer(page).fill("");
    await composer(page).pressSequentially("donne ton avis sur le projet /");
    await expect.poll(() => options(page).count()).toBeGreaterThan(1);
    await composer(page).pressSequentially("dep");
    await expect.poll(() => options(page).first().textContent()).toContain("/deploy");
    await shot(page, "c7-commande-milieu");
    await composer(page).press("Enter");
    expect(await composer(page).inputValue()).toBe("donne ton avis sur le projet /deploy ");

    // `@` searches the project's files, `$` its skills.
    await composer(page).fill("Lis @app");
    await expect.poll(() => options(page).first().textContent()).toContain("app.ts");
    await shot(page, "c2-fichiers");
    await composer(page).press("Enter");
    await composer(page).pressSequentially("avec $rev");
    await expect.poll(() => options(page).first().textContent()).toContain("revue");
    await shot(page, "c3-skills");
    await composer(page).press("Tab");
    expect(await composer(page).inputValue()).toBe("Lis @src/app.ts avec $revue ");

    await setAccess(page, /Accès complet/);
    await composer(page).press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    // The agent's plan is one card: every step done, with what the agent read on it.
    const plan = page.locator(".plan.ap").last();
    await plan.getByText("Terminé · 2 sur 2").waitFor();
    expect(await plan.locator('.stp[data-state="done"]').count()).toBe(2);
    await plan.locator(".stp").first().getByText("app.ts").waitFor();
    // What it said on the way is folded with its steps, under one line.
    expect(await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").count()).toBe(
      0,
    );
    await page.locator(".det .fold").last().click();
    // The agent got the file and the skill with the message.
    await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").waitFor();
    await page.locator(".det .fold").last().click();

    // In the thread, the agent's own commands join in, with who offers them.
    await composer(page).fill("/");
    await expect
      .poll(async () => (await options(page).allTextContents()).join(" | "))
      .toContain("/explique");
    await shot(page, "c4-commandes-agent");
    await composer(page).fill("/epingler");
    await composer(page).press("Enter");
    await menu(page).getByText("Épinglés").waitFor();

    // Ctrl K finds the message, and opens its thread.
    await page.goto(url.replace(/\?.*$/, ""));
    await menu(page).getByText("Épinglés").waitFor();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Rechercher" }).fill("Pièces jointes");
    await page.getByRole("option", { name: /Pièces jointes/ }).waitFor();
    await shot(page, "c5-recherche");
    await page.keyboard.press("ArrowDown");
    await page.getByRole("option", { name: /Pièces jointes/ }).click();
    await expect.poll(() => page.url()).toMatch(/\/t\//);
    await page.close();
  });

  it("shows each agent's state, adds an agent, and answers a request from À traiter", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await menu(page).getByRole("button", { name: "Réglages" }).click();
    await page
      .getByRole("navigation", { name: "Réglages" })
      .getByRole("button", { name: /^Agents/ })
      .click();
    const agents = page.getByRole("region", { name: "Agents" });
    const demoRow = agents.getByRole("button", { name: /^Agent de démo/ });
    await demoRow.click();
    const demo = page.getByRole("dialog", { name: "Agent de démo", exact: true });
    await demo.getByRole("button", { name: "Vérifier" }).click();
    await demo.getByText("Prêt", { exact: true }).waitFor();
    await demo.getByText("moonagentic-demo 0.1.0").waitFor();
    await demo.getByRole("button", { name: "Fermer", exact: true }).click();
    await demoRow.getByText("Prêt").waitFor();

    // An agent of the user's own whose command this machine lacks says so.
    await agents.getByRole("button", { name: "Ajouter un agent" }).click();
    const adding = page.getByRole("dialog", { name: "Ajouter un agent" });
    await adding.getByLabel("Nom").fill("Mon agent");
    await adding.getByLabel("Commande qui le lance en mode ACP").fill("pas-une-commande-e2e acp");
    await adding.getByRole("button", { name: "Ajouter", exact: true }).click();
    const mineRow = agents.getByRole("button", { name: /^Mon agent/ });
    await mineRow.click();
    const mine = page.getByRole("dialog", { name: "Mon agent" });
    await mine.getByText("Commande introuvable sur cette machine : pas-une-commande-e2e").waitFor();
    await shot(page, "c7-connexions");
    await mine.getByRole("button", { name: "Retirer cet agent" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Retirer", exact: true })
      .click();
    await expect.poll(() => mineRow.count()).toBe(0);
    await page.getByRole("button", { name: "Fermer les réglages" }).click();

    // A supervised turn waits for the user, who answers from À traiter.
    await pickAgent(page);
    await supervised(page);
    await composer(page).fill("Corrige la réponse");
    await composer(page).press("Enter");
    const inbox = pages(page).getByRole("button", { name: /^À traiter/ });
    // The agent starts its process before it asks: long on a machine that runs every file of
    // these checks at once.
    await expect.poll(() => inbox.textContent(), { timeout: 30_000 }).toContain("1");
    await inbox.click();
    const requests = page.getByRole("region", { name: "À traiter" });
    await requests.getByText("Modifier src/app.ts").waitFor();
    await shot(page, "c8-a-traiter");
    await requests.getByRole("button", { name: "Autoriser cette fois" }).click();
    await requests.getByText("Rien ne t'attend").waitFor();
    await menu(page)
      .getByRole("button", { name: /^Corrige la réponse/ })
      .first()
      .click();
    await page.getByText("C'est fait, la réponse vaut 42.").last().waitFor();
    await page.close();
  });

  it("fits a phone screen, suggestions included", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    await composer(page).fill("/");
    await options(page).first().waitFor();
    // The commands stay inside the screen, above the composer.
    const box = await page.locator("#composer-suggest").boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await options(page).first().waitFor();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await shot(page, "c6-mobile");
    await page.close();
  });
  it("opens the model sheet inside a phone screen, with or without favorites", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
    await page.goto(url);
    const wheel = page.getByRole("dialog", { name: "Modèle", exact: true });
    const all = page.getByRole("dialog", { name: "Tous les modèles" });
    // Whole on the screen, and still there once the composer has finished opening: it used to
    // flash by the composer, then sit above the top of the screen behind a grey veil.
    const inside = async (sheet: typeof wheel) => {
      const box = await sheet.boundingBox();
      return (
        !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 780
      );
    };
    const openSheet = async () => {
      // The composer folds back once the sheet closes: it opens again first.
      await composer(page).click();
      await pill(page).click();
      await expect.poll(() => inside(wheel)).toBe(true);
      await page.waitForTimeout(600);
      expect(await inside(wheel)).toBe(true);
    };
    await openSheet();
    await shot(page, "c10-modele-mobile");
    // With a favorite starred from « Plus », the wheel opens in the same place.
    await wheel.getByRole("button", { name: "Plus", exact: true }).click();
    await expect.poll(() => inside(all)).toBe(true);
    // The demo agent's models come once it is picked.
    await all.getByRole("menuitemradio", { name: /^Agent de démo/ }).click();
    const star = all.getByRole("button", { name: "Ajouter aux favoris" }).first();
    await star.waitFor({ timeout: 30_000 });
    await star.click();
    await all.getByRole("button", { name: "Retirer des favoris" }).first().waitFor();
    await all.getByRole("button", { name: "Favoris", exact: true }).click();
    await wheel.getByRole("listbox", { name: "Modèles favoris" }).waitFor();
    await expect.poll(() => inside(wheel)).toBe(true);
    await wheel.getByRole("button", { name: "Fermer", exact: true }).click();
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    await openSheet();
    await shot(page, "c11-modele-mobile-favori");
    // Taken off again, so the other tests keep the wheel they expect.
    await wheel.getByRole("button", { name: "Plus", exact: true }).click();
    await all.getByRole("button", { name: "Retirer des favoris" }).first().click();
    await expect
      .poll(() => all.getByRole("button", { name: "Retirer des favoris" }).count())
      .toBe(0);
    await page.close();
  });
  it("opens the model menu above its button on a computer, a list to click", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await composer(page).click();
    await pill(page).click();
    // A menu above the model's button, not a window in the middle of the screen.
    const menu = page.getByRole("dialog", { name: "Modèle", exact: true });
    const list = menu.getByRole("listbox", { name: "Modèles favoris" });
    await list.waitFor();
    await page.waitForTimeout(500);
    const box = await menu.boundingBox();
    const chip = await pill(page).boundingBox();
    expect(box && chip).toBeTruthy();
    expect(box!.y + box!.height).toBeLessThanOrEqual(chip!.y);
    expect(Math.abs(box!.x + box!.width - (chip!.x + chip!.width))).toBeLessThan(80);
    expect(box!.width).toBeLessThanOrEqual(400);
    expect(await page.locator(".sscrim.on").count()).toBe(0);
    await shot(page, "c12-modele-bureau");

    // Every model: a search, and a star to make one a favorite.
    await menu.getByRole("button", { name: "Tous les modèles", exact: true }).click();
    const all = page.getByRole("dialog", { name: "Tous les modèles" });
    await showAgents(all);
    await all.getByRole("menuitemradio", { name: /^Agent de démo/ }).click();
    const search = all.getByRole("searchbox", { name: "Rechercher un modèle" });
    await search.fill("précis");
    const precise = all.getByRole("menuitemradio", { name: /^Démo précis/ }).first();
    await precise.waitFor({ timeout: 30_000 });
    expect(await all.getByRole("menuitemradio", { name: /^Démo rapide/ }).count()).toBe(0);
    await precise.getByRole("button", { name: "Ajouter aux favoris" }).click();
    await precise.getByRole("button", { name: "Retirer des favoris" }).waitFor();
    await shot(page, "c13-tous-bureau");

    // Back to the favorites: one click picks it and closes the menu.
    await all.getByRole("button", { name: "Favoris", exact: true }).click();
    await list
      .getByRole("option", { name: /^Démo précis/ })
      .first()
      .click();
    await menu.waitFor({ state: "hidden" });
    await composer(page).click();
    await expect.poll(() => pill(page).getAttribute("aria-label")).toContain("Démo précis");

    // With the keyboard: a search, down into the list, Enter.
    await pill(page).click();
    await menu.getByRole("button", { name: "Tous les modèles", exact: true }).click();
    await search.fill("rapide");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await all.waitFor({ state: "hidden" });
    await composer(page).click();
    await expect.poll(() => pill(page).getAttribute("aria-label")).toContain("Démo rapide");

    // The effort's slider takes the keys while it is over the list: the model stays.
    await pill(page).click();
    await menu.getByRole("button", { name: /^Effort : / }).click();
    const slider = menu.getByRole("slider", { name: /^Effort de / });
    await expect.poll(() => slider.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await composer(page).click();
    await expect.poll(() => pill(page).getAttribute("aria-label")).toContain("Démo rapide");

    // Escape and a click elsewhere close it too.
    await pill(page).click();
    await list.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await composer(page).click();
    await pill(page).click();
    await list.waitFor();
    await page.mouse.click(700, 120);
    await menu.waitFor({ state: "hidden" });

    // Taken off again, so the other tests keep the favorites they expect.
    await composer(page).click();
    await pill(page).click();
    await menu.getByRole("button", { name: "Tous les modèles", exact: true }).click();
    await all.getByRole("button", { name: "Retirer des favoris" }).first().click();
    await expect
      .poll(() => all.getByRole("button", { name: "Retirer des favoris" }).count())
      .toBe(0);
    await page.close();
  });
  // The stand-in « gh » is a POSIX shell script that Windows cannot run (the server does not take
  // a .cmd as the GitHub CLI, on purpose). The canClone rule itself is covered by github.test.ts.
  it.skipIf(process.platform === "win32")(
    "lists the user's GitHub repositories to clone, and explains a profile address",
    async () => {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByRole("button", { name: "Nouveau projet" }).first().click();
      const sheet = page.getByRole("dialog", { name: "Nouveau projet" });
      // Signed in here through the user's own `gh`.
      await sheet.getByRole("radio", { name: "GitHub" }).click();
      // The list arrives: it used to stay on « Chargement de tes dépôts… » forever.
      const list = sheet.getByRole("group", { name: "Tes dépôts GitHub" });
      await expect.poll(() => list.getByRole("button").count()).toBe(2);
      // An account's address names no repository: its repositories stay, nothing to clone yet.
      const repoField = sheet.getByRole("textbox", { name: "Dépôt" });
      await repoField.fill("https://github.com/moon");
      await expect.poll(() => list.getByRole("button").count()).toBe(2);
      expect(await sheet.getByRole("button", { name: "Cloner" }).isDisabled()).toBe(true);
      await repoField.fill("https://github.com/personne");
      await list.getByText("Aucun dépôt de @personne").waitFor();
      await repoField.fill("");
      await list.getByRole("button", { name: /^site/ }).click();
      // Picked: where it goes is said, and can be changed.
      expect(
        await sheet.getByRole("textbox", { name: "Nom du dossier" }).getAttribute("placeholder"),
      ).toBe("site");
      await sheet.getByRole("button", { name: /^Emplacement/ }).click();
      await expect.poll(() => sheet.getByLabel("Cloner dans").inputValue()).not.toBe("");
      await expect
        .poll(() => sheet.getByRole("button", { name: "Cloner" }).isDisabled())
        .toBe(false);
      await page.close();
    },
  );
  it("archives a thread, brings it back, deletes it, then removes the project", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const side = menu(page);
    const line = side.getByRole("button", { name: /^Corrige la réponse/ }).first();
    await line.click();
    const actions = page.getByRole("button", { name: "Actions du fil" });
    const threadMenu = page.getByRole("menu", { name: "Actions du fil" });
    const resolvedNote = page.getByText("Ce fil est résolu");

    // On a phone, the menu opens inside the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await actions.click();
    await threadMenu.getByRole("menuitem", { name: "Marquer résolu" }).waitFor();
    const box = await threadMenu.boundingBox();
    expect(
      box && box.y >= 0 && box.y + box.height <= 780 && box.x >= 0 && box.x + box.width <= 390,
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => threadMenu.count()).toBe(0);
    await page.setViewportSize({ width: 1280, height: 820 });

    await actions.click();
    await threadMenu.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await resolvedNote.waitFor();
    await side.getByRole("button", { name: "Résolus (1)" }).click();
    await shot(page, "c9-archive");
    await page.getByRole("button", { name: "Rouvrir", exact: true }).click();
    await expect.poll(() => resolvedNote.count()).toBe(0);

    // The same actions from the sidebar, with a right click on the thread's line.
    const rowMenu = page.getByRole("menu", { name: /^Actions de Corrige la réponse/ });
    await line.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: /pingler$/ }).waitFor();
    if (shots) await page.waitForTimeout(300);
    await shot(page, "c9b-menu-ligne");
    await page.keyboard.press("Escape");
    await expect.poll(() => rowMenu.count()).toBe(0);
    // One menu at a time: asked on another line, it moves there.
    const other = side.getByRole("button", { name: /^Lis @src/ }).first();
    await line.click({ button: "right" });
    await rowMenu.waitFor();
    await other.click({ button: "right" });
    await page.getByRole("menu", { name: /^Actions de Lis/ }).waitFor();
    await expect.poll(() => page.getByRole("menu").count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("menu").count()).toBe(0);
    await line.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await resolvedNote.waitFor();
    await line.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: "Rouvrir" }).click();
    await expect.poll(() => resolvedNote.count()).toBe(0);
    // On a phone there is no right click: a finger held on the line opens the same menu, and
    // does not open the thread. In a conversation, the arrow goes back first.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Retour", exact: true }).click();
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    // The menu slides in: the line is pressed where it comes to rest.
    let at = (await line.boundingBox())!;
    await expect
      .poll(async () => {
        const before = at;
        at = (await line.boundingBox())!;
        return at.x >= 0 && at.x === before.x;
      })
      .toBe(true);
    const finger = {
      pointerType: "touch",
      bubbles: true,
      clientX: at.x + 40,
      clientY: at.y + at.height / 2,
    };
    const here = page.url();
    await expect.poll(() => rowMenu.count()).toBe(0);
    await line.dispatchEvent("pointerdown", finger);
    await rowMenu.waitFor();
    await line.dispatchEvent("pointerup", finger);
    await line.dispatchEvent("click");
    expect(page.url()).toBe(here);
    // Whole on the screen.
    await expect
      .poll(async () => {
        const sheet = await rowMenu.boundingBox();
        return (
          !!sheet && sheet.x >= 0 && sheet.x + sheet.width <= 390 && sheet.y + sheet.height <= 780
        );
      })
      .toBe(true);
    if (shots) await page.waitForTimeout(400);
    await shot(page, "c9c-menu-ligne-mobile");
    await page.keyboard.press("Escape");
    await expect.poll(() => rowMenu.count()).toBe(0);
    await page.setViewportSize({ width: 1280, height: 820 });

    await line.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: "Supprimer…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Supprimer cette discussion ?" });
    await confirm.getByRole("button", { name: "Supprimer" }).click();
    await expect
      .poll(() => side.getByRole("button", { name: /^Corrige la réponse/ }).count())
      .toBe(0);

    // The project leaves from its own settings.
    await side.getByRole("button", { name: /^projet/ }).click();
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    await page
      .getByRole("dialog", { name: "Réglages du projet" })
      .getByRole("button", { name: "Retirer de MoonAgentic" })
      .click();
    await page
      .getByRole("alertdialog", { name: "Retirer ce projet ?" })
      .getByRole("button", { name: "Retirer" })
      .click();
    // With no project left, the section only offers to make one.
    await expect.poll(() => side.getByRole("button", { name: /^projet/ }).count()).toBe(0);
    await side.getByRole("button", { name: "Nouveau projet" }).waitFor();
    await page.waitForURL((u) => u.pathname === "/");
    // The folder itself is left alone.
    expect(existsSync(path.join(project, "src/app.ts"))).toBe(true);
    await page.close();
  });

  it("gives a task to a team: the lead splits it, coders do the pieces on their own branches", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await addProject(page, repo);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);

    await composer(page).fill("/equipe Corrige answer et documente-la");
    await composer(page).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Confier à une équipe" });
    await expect
      .poll(() => dialog.getByLabel("Tâche").inputValue())
      .toBe("Corrige answer et documente-la");
    /** Who takes a role: the demo agent, not a real one that may be installed here, or no one. */
    const give = async (role: string, to: "demo" | "none") => {
      await dialog.getByRole("button", { name: new RegExp(`^${role} : `) }).click();
      const sheet = page.getByRole("dialog", { name: role, exact: true });
      const wanted =
        to === "none"
          ? sheet.getByRole("radio", { name: "Personne", exact: true })
          : sheet
              .getByRole("group", { name: "Agent de démo", exact: true })
              .getByRole("radio")
              .first();
      const all = sheet.getByRole("button", { name: "Tous", exact: true });
      await expect
        .poll(async () => {
          if (await wanted.count()) return true;
          if (await all.count()) await all.click();
          return false;
        })
        .toBe(true);
      await wanted.click();
      await sheet.waitFor({ state: "hidden" });
    };
    for (const role of ["Chef", "Codeurs", "Relecture", "Tests", "Fusion"])
      await give(role, "demo");
    await shot(page, "c10-equipe-lancer");
    // The team opens its pull request at the end unless told not to.
    const autoShip = dialog.getByRole("switch", { name: "Ouvrir la PR à la fin" });
    expect(await autoShip.getAttribute("aria-checked")).toBe("true");
    await autoShip.scrollIntoViewIfNeeded();
    await shot(page, "c10c-equipe-pr");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    // Every role is on the list from the start, the model of each said.
    const card = page.getByRole("region", { name: "Équipe", exact: true });
    await card.getByRole("button", { name: /^Fusion, / }).waitFor();
    await dialog.waitFor({ state: "hidden" });
    await shot(page, "c10b-equipe-depart");

    await card.getByText("Terminée · 6 sur 6").waitFor({ timeout: 30_000 });
    expect(await card.locator(".tmr").count()).toBe(6);
    // Under the list, only what is the user's to do. This repository has no remote: the team
    // says so, and can try again.
    await card.getByText(/remote/).waitFor();
    await card.getByRole("button", { name: "Réessayer" }).waitFor();
    expect(await page.getByText("Découper la tâche").count()).toBe(0);
    // The lead's internal prompt and plan stay folded: only « Voir le détail » shows.
    expect(await page.getByText("Tu es le chef d'une équipe").count()).toBe(0);
    await page.locator(".det .fold").last().click();
    await page.getByText("Tu es le chef d'une équipe").waitFor();
    await page.locator(".det .fold").last().click();
    // Ctrl K leaves the team's own messages out, and opens the detail that holds a hit.
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "Rechercher" });
    await search.fill("Tu es le chef d'une équipe");
    await page.getByText("Aucune discussion ne contient « Tu es le chef d'une équipe ».").waitFor();
    await search.fill("Voici le plan");
    await page.getByRole("option", { name: /Voici le plan/ }).click();
    await page.getByText("Voici le plan.").waitFor();
    expect(await page.locator(".det.open").count()).toBe(1);
    await page.locator(".det .fold").last().click();
    // The team is one line in the sidebar: its members are reached from its own list.
    const side = menu(page);
    expect(
      await side.getByRole("button", { name: /^Équipe : Corrige answer et documente-la/ }).count(),
    ).toBe(1);
    expect(await side.getByRole("button", { name: /^(Corriger|Documenter) answer/ }).count()).toBe(
      0,
    );
    await shot(page, "c11-equipe");
    // Each line opens its member's thread, which leads back to the team.
    await card.getByRole("button", { name: /^Codeur 2, .* : Documenter answer/ }).click();
    await page.waitForURL(/\/t\//);
    const back = page.getByRole("button", { name: /Sous-tâche de l'équipe/ });
    await back.waitFor();
    await shot(page, "c11b-equipe-codeur");
    await back.click();
    await card.getByText("Terminée · 6 sur 6").waitFor();

    // A piece the reviewer keeps refusing goes back three times, then to the lead, then to the user.
    await composer(page).fill("/equipe Corrige answer, à toujours refuser");
    await composer(page).press("Enter");
    await dialog.waitFor();
    for (const role of ["Chef", "Codeurs", "Relecture"]) await give(role, "demo");
    for (const role of ["Tests", "Fusion"]) await give(role, "none");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    await card.getByText(/^T'attend · /).waitFor({ timeout: 60_000 });
    await shot(page, "c12-equipe-bloquee");
    const again = card.getByRole("button", { name: "Relancer « Corriger answer »" });
    await again.click();
    await card
      .getByText(/^Au travail · /)
      .or(card.getByText(/^T'attend · /))
      .first()
      .waitFor();

    // Two reviews at once, and a judge who weighs their remarks: one that does not hold is
    // dropped, and the piece is done without going back to its coder.
    await composer(page).fill("/equipe Corrige answer, à arbitrer");
    await composer(page).press("Enter");
    await dialog.waitFor();
    for (const role of ["Chef", "Codeurs", "Relecture", "Relecture 2", "Arbitre"])
      await give(role, "demo");
    for (const role of ["Tests", "Fusion"]) await give(role, "none");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    await card.getByRole("button", { name: /^Arbitre, / }).waitFor();
    await card.getByRole("button", { name: /^Relecture 2, / }).waitFor();
    await card.getByText(/^Terminée · /).waitFor({ timeout: 60_000 });
    await card.getByRole("button", { name: /^Arbitre, .* : Rien à corriger$/ }).waitFor();
    await shot(page, "c12b-equipe-arbitre");

    // Live: supervised coders wait on the user, and their lines say so as it happens.
    await composer(page).fill("/equipe Corrige answer");
    await composer(page).press("Enter");
    await dialog.waitFor();
    for (const role of ["Chef", "Codeurs"]) await give(role, "demo");
    for (const role of ["Relecture", "Tests", "Fusion"]) await give(role, "none");
    await dialog.getByRole("radio", { name: "Me demander" }).click();
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    await expect
      .poll(
        () => card.getByRole("button", { name: /^Codeur \d, .* : Attend ta réponse$/ }).count(),
        {
          timeout: 30_000,
        },
      )
      .toBe(2);
    await shot(page, "c13-equipe-en-direct");
    // What is written while the team works is a mission: the lead puts it in its plan.
    expect(await composer(page).getAttribute("placeholder")).toBe("Ajouter une mission");
    await composer(page).fill("Ajoute aussi une ligne dans MISSION.md");
    await composer(page).press("Enter");
    const missions = card.getByLabel("Missions ajoutées");
    await missions.getByText("Ajoute aussi une ligne dans MISSION.md").waitFor();
    await missions.getByText("Au plan · 1 partie").waitFor({ timeout: 30_000 });
    expect(await composer(page).inputValue()).toBe("");
    await shot(page, "c13b-equipe-mission");
    // A team at work is stopped from the thread's menu, not by a button under its list.
    expect(await card.getByRole("button", { name: /Arrêter/ }).count()).toBe(0);
    await page.getByRole("button", { name: "Actions du fil" }).click();
    await page.getByRole("menuitem", { name: "Arrêter l'équipe" }).click();
    await card.getByText(/^Arrêtée · /).waitFor();
    await page.close();
  });

  it("shows a project's conversations grouped by state, on a page of its own", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const side = menu(page);
    const inSidebar = side.getByRole("button", { name: /^equipe/ });
    await inSidebar.click();
    await page.getByText("Coordinateur du projet").waitFor();
    expect(new URL(page.url()).pathname).toMatch(/^\/p\//);
    /** The project's threads beside its page, on a wide screen. */
    const beside = page.getByRole("complementary", { name: "Fils du projet" });

    // A conversation opened from the page lands in the project, and comes back on its list.
    await beside.getByRole("button", { name: "Nouveau fil" }).click();
    await pickAgent(page);
    await supervised(page);
    await composer(page).fill("Dis bonjour");
    await composer(page).press("Enter");
    // The new thread opens by itself, then back to the project.
    await page.waitForURL(/\/t\//);
    await inSidebar.click();
    await page.waitForURL(/\/p\//);
    // Sent, then gone to another page before the thread exists: the user stays where they went.
    await beside.getByRole("button", { name: "Nouveau fil" }).click();
    await composer(page).fill("Dis au revoir");
    await composer(page).press("Enter");
    await inSidebar.click();
    await beside.getByRole("button", { name: /Dis au revoir/ }).waitFor();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toMatch(/^\/p\//);

    // « Vue d'ensemble », beside the coordinator on a wide screen, groups them by what is
    // really going on.
    await page.getByRole("tablist", { name: "Vue d'ensemble" }).waitFor();
    const rows = (group: string) => page.locator(`.trow[data-group="${group}"]`);
    // Its agent asks before changing a file: the thread waits on the user, and says so.
    const row = rows("waiting").filter({ hasText: "Dis bonjour" });
    await row.waitFor();
    expect(await row.locator(".s").textContent()).toBe("Attend ta réponse.");
    await page.getByText(/^T'attend · \d+$/).waitFor();
    // A team counts once, as its lead: its coders stay behind it.
    expect(await page.locator(".trow", { hasText: "Dis bonjour" }).count()).toBe(1);
    expect(await page.locator(".trow", { hasText: /^(Corriger|Documenter) answer/ }).count()).toBe(
      0,
    );
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p1-page-projet");

    // Once answered, the thread is at rest, under what its agent really said last.
    await pages(page)
      .getByRole("button", { name: /^À traiter/ })
      .click();
    const requests = page.getByRole("region", { name: "À traiter" });
    // Both threads opened here ask the same thing.
    const allow = requests.getByRole("button", { name: "Autoriser cette fois" });
    await expect.poll(() => allow.count()).toBe(2);
    await allow.first().click();
    await expect.poll(() => allow.count()).toBe(1);
    await allow.first().click();
    await requests.getByText("Rien ne t'attend").waitFor();
    // Back on the project, its page is as it was left: on its overview.
    await inSidebar.click();
    await page.getByRole("tablist", { name: "Vue d'ensemble" }).waitFor();
    const idle = rows("idle").filter({ hasText: "Dis bonjour" });
    await idle.waitFor();
    await expect.poll(() => idle.locator(".s").textContent()).toContain("C'est fait");

    // Resolved from its menu, it moves to « Résolus »; reopened, it comes back.
    const rowMenu = page.getByRole("menu", { name: "Actions de Dis bonjour" });
    await idle.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await page.getByRole("button", { name: /^Résolus · \d+/ }).click();
    const resolved = rows("resolved").filter({ hasText: "Dis bonjour" });
    await resolved.waitFor();
    await shot(page, "p2-resolu");
    await resolved.click({ button: "right" });
    await rowMenu.getByRole("menuitem", { name: "Rouvrir" }).click();
    await idle.waitFor();

    // The project takes another name from its settings, for every window.
    const settings = page.getByRole("dialog", { name: "Réglages du projet" });
    const rename = async (name: string) => {
      await page.getByRole("button", { name: "Réglages du projet" }).click();
      await settings.getByLabel("Nom du projet").fill(name);
      await settings.getByLabel("Nom du projet").press("Enter");
      await side.getByRole("button", { name: new RegExp(`^${name}( |$)`) }).waitFor();
      await settings.getByRole("button", { name: "Fermer", exact: true }).click();
    };
    await rename("equipe bis");
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p3-projet-renomme");
    await rename("equipe");

    // Pinned from its settings: kept by the server, still so once the page is loaded again.
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    const pin = settings.getByRole("switch", { name: "Épingler le projet" });
    await pin.click();
    await expect.poll(() => pin.getAttribute("aria-checked")).toBe("true");
    await page.reload();
    await page.getByRole("button", { name: "Réglages du projet" }).click();
    await expect.poll(() => pin.getAttribute("aria-checked")).toBe("true");
    await settings.getByRole("button", { name: "Fermer", exact: true }).click();

    // The coordinator: one agent to talk to about the whole project. Its agent calls
    // MoonAgentic's own tools, here to open a thread on a branch of its own.
    await page.getByRole("button", { name: /^Modèle du coordinateur : / }).click();
    const models = page.getByRole("dialog", { name: "Modèle", exact: true });
    const demoModel = models
      .getByRole("group", { name: "Agent de démo", exact: true })
      .getByRole("radio")
      .first();
    await expect
      .poll(async () => {
        if (await demoModel.count()) return true;
        const all = models.getByRole("button", { name: "Tous", exact: true });
        if (await all.count()) await all.click();
        return false;
      })
      .toBe(true);
    await demoModel.click();
    await page.getByRole("button", { name: "Activer le coordinateur" }).click();
    // Before anything is asked: ways to start, the threads still beside.
    await page.getByRole("button", { name: "Établir un plan" }).waitFor();
    await beside.getByRole("button", { name: /Dis bonjour/ }).waitFor();
    // What the coordinator works with, as the server has it, in the pane beside it.
    await page.getByRole("tab", { name: "Contexte" }).click();
    await page
      .getByRole("button", { name: /^Coordinateur/ })
      .getByText(/démo/i)
      .waitFor();
    await page.getByText("Accès des fils").waitFor();
    await page.getByText("Fils en même temps").waitFor();
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p13-contexte");
    await page.getByRole("tab", { name: "Fils" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await composer(page).fill("/ouvre Export Safari");
    await composer(page).press("Enter");
    const card = page.getByRole("button", { name: "Ouvrir le fil Export Safari" });
    await card.waitFor();
    await page.getByText("J'ai ouvert le fil « Export Safari ».").waitFor();
    // The threads stay beside the conversation, the new one among them with its real state.
    await beside.getByRole("button", { name: /Export Safari/ }).waitFor();
    await expect.poll(() => card.locator(".st").textContent()).toBe("Attend ta réponse.");
    // What the new thread waits for is asked above the coordinator's composer, to the user.
    const ask = page
      .getByRole("list", { name: "Autorisations demandées par les fils du projet" })
      .getByRole("listitem")
      .filter({ hasText: "Export Safari" });
    await ask.waitFor();
    expect(await ask.getByRole("button").count()).toBeGreaterThan(1);
    // The coordinator is no thread of the lists: not in the sidebar, not among the project's.
    expect(await side.getByRole("button", { name: /Coordinateur/ }).count()).toBe(0);
    expect(await beside.getByRole("button", { name: /Coordinateur/ }).count()).toBe(0);
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p5-coordinateur");
    // The thread opens from its line in the pane beside, then on its own page.
    await card.click();
    await page
      .getByRole("complementary", { name: "Fils du projet" })
      .getByText("Corrige : Export Safari")
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Ouvrir le fil en pleine page" }).click();
    await page.waitForURL(/\/t\//);
    await page.getByText("Corrige : Export Safari").first().waitFor();
    // On a phone it takes the screen, nothing wider than it.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByText("Corrige : Export Safari").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p11-fil-mobile");
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.getByRole("button", { name: "Retour", exact: true }).click();
    await page.waitForURL(/\/p\//);
    await card.waitFor();
    // Once the thread has finished, its own words come back to the coordinator's conversation.
    // The composer has the focus: the press on « Autoriser » above it must land all the same.
    expect(await page.locator(".rsl").count()).toBe(0);
    await composer(page).click();
    await ask.getByRole("button", { name: "Autoriser cette fois" }).click();
    const result = page.locator(".rsl");
    await result.waitFor();
    await page.getByRole("separator").filter({ hasText: "Nouveau" }).waitFor();
    expect(await result.locator("p").textContent()).toContain("C'est fait");
    await expect.poll(() => card.locator(".st").textContent()).toBe("Inactif");
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p12-resultat");

    // On a phone, the coordinator has the page and the threads are one press away; nothing
    // spills past the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await card.waitFor();
    await composer(page).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.getByRole("button", { name: "Vue d'ensemble" }).click();
    await page.locator(".trow", { hasText: "Export Safari" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    if (shots) await page.waitForTimeout(400);
    await shot(page, "p6-mobile-fils");
    await page.getByRole("button", { name: "Retour", exact: true }).click();
    await card.waitFor();
    // The quick search lists threads, never the coordinator as one of them.
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "Recherche" });
    await search.getByRole("combobox", { name: "Rechercher" }).fill("Export");
    await search.getByText("Export Safari").first().waitFor();
    expect(await search.getByText(/^Coordinateur · /).count()).toBe(0);
    await page.keyboard.press("Escape");
    if (shots) await page.waitForTimeout(400);
    await shot(page, "p4-mobile");

    // In the settings, each kind of work is sent to an agent and a model in one pick; the
    // server keeps the choice.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(new URL("/reglages/models", url).href);
    const bug = page.getByRole("button", { name: /^Modèle pour Bug : / });
    await bug.click();
    const kinds = page.getByRole("dialog", { name: "Bug", exact: true });
    const precise = kinds
      .getByRole("group", { name: "Agent de démo", exact: true })
      .getByRole("radio", { name: /^Démo précis/ });
    await expect
      .poll(async () => {
        if (await precise.count()) return true;
        const all = kinds.getByRole("button", { name: "Tous", exact: true });
        if (await all.count()) await all.click();
        return false;
      })
      .toBe(true);
    await precise.click();
    await page.reload();
    await expect
      .poll(() => bug.getAttribute("aria-label"))
      .toMatch(/^Modèle pour Bug : Démo précis/);
    expect(
      await page.getByRole("button", { name: /^Modèle pour Tests : / }).getAttribute("aria-label"),
    ).toBe("Modèle pour Tests : Par défaut");
    await shot(page, "p8-reglages-modeles");
    await page.close();
  });
  it("plans the project's work: the teams' cards follow their pieces, the user's are theirs to move", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await pages(page).getByRole("button", { name: "Planner", exact: true }).click();
    const column = (name: string) => page.getByRole("region", { name, exact: true });
    const cardOf = (title: string) =>
      page.locator(".pc").and(page.getByRole("button", { name: new RegExp(`: ${title},`) }));

    // The first team's plan, laid down by its lead and carried to the end by its pieces.
    const delivered = column("Livré").locator(".pc");
    await delivered.filter({ hasText: "Documenter answer" }).first().waitFor();
    expect(await delivered.count()).toBe(2);
    expect(await delivered.first().locator(".pco").textContent()).toBe("Planifiée par le chef");
    // The team that was stopped left its pieces where they stopped.
    await column("Reporté").locator(".pcw", { hasText: "arrêtée" }).first().waitFor();
    // Every column shows at once on a desktop: the board does not scroll sideways.
    expect(await page.locator("#kb").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // A card of the user's own, written in a sheet.
    await page.getByRole("button", { name: "Ajouter une tâche", exact: true }).click();
    await page.getByLabel("Nouvelle tâche, À faire").fill("Écrire le changelog");
    await page.keyboard.press("Enter");
    const mine = cardOf("Écrire le changelog");
    await column("À faire").getByText("Écrire le changelog").waitFor();
    expect(await mine.locator(".pco").count()).toBe(0);

    // Moved from the keyboard, then from its detail, where it gets a due day and a thread.
    await expect
      .poll(() => page.getByRole("dialog", { name: "Ajouter une tâche" }).count())
      .toBe(0);
    await mine.focus();
    await page.keyboard.press("ArrowRight");
    await column("En cours").getByText("Écrire le changelog").waitFor();
    await mine.click();
    const detail = page.getByRole("dialog", { name: /^Tâche #\d+$/ });
    const states = detail.getByRole("group", { name: "État de la tâche" });
    await states.getByRole("button", { name: "En test" }).click();
    await detail.getByLabel("Échéance").fill("2020-01-15");
    // A click outside closes the panel, and keeps what was being typed.
    await detail.getByLabel("Description").fill("Pour la v1");
    await page
      .locator(".sscrim.on")
      .last()
      .click({ position: { x: 6, y: 6 } });
    await expect.poll(() => detail.count()).toBe(0);
    await mine.click();
    await expect.poll(() => detail.getByLabel("Description").inputValue()).toBe("Pour la v1");
    // A year half typed in the date field is not sent, so nothing complains.
    await detail.getByLabel("Échéance").fill("0002-01-15");
    await detail.getByLabel("Échéance").fill("2020-01-15");
    expect(await page.locator(".toast").count()).toBe(0);
    await detail.getByRole("button", { name: "Fermer", exact: true }).click();
    await column("En test").locator(".pcl").getByText("en retard · 15 janv").waitFor();
    await shot(page, "c14-planner");

    // Given to a thread, it follows it: who works on it is said, and its state is the thread's.
    await mine.click();
    await detail.getByRole("button", { name: /^Fil qui s'en occupe : Aucun/ }).click();
    await page
      .getByRole("dialog", { name: "Fil qui s'en occupe" })
      .getByRole("radio", { name: "Équipe : Corrige answer et documente-la" })
      .click();
    await detail.getByText("Suit son fil").waitFor();
    await detail.getByText("Agent de démo").waitFor();
    expect(await states.getByRole("button", { name: "En cours" }).isDisabled()).toBe(true);
    await detail.getByRole("button", { name: "Fermer", exact: true }).click();

    // A team's card says what moves it, and cannot be moved by hand.
    await column("Livré").getByText("Documenter answer").click();
    await detail.getByText("Suit le travail de l'équipe").waitFor();
    expect(await states.getByRole("button", { name: "En cours" }).isDisabled()).toBe(true);
    if (shots) await page.waitForTimeout(400);
    await shot(page, "c15-planner-carte");
    await detail.getByRole("button", { name: "Ouvrir le fil" }).click();
    await page.getByRole("button", { name: /Sous-tâche de l'équipe/ }).waitFor();
    await page.goBack();

    // The same cards over time: a lane per agent, bars drawn from what really happened.
    await page.getByRole("tab", { name: "Timeline" }).click();
    const lanes = page.getByRole("region", { name: "Timeline" });
    const bar = (title: string) => lanes.getByRole("button", { name: new RegExp(`: ${title},`) });
    await lanes.getByRole("region", { name: "Agent de démo" }).waitFor();
    const done = bar("Documenter answer, Livré");
    await done.waitFor();
    // Delivered work is solid; the user's card is under the agent of the thread it was given.
    expect(await done.getAttribute("class")).not.toContain("planned");
    await bar("Écrire le changelog").waitFor();
    // Today is in view when the timeline opens.
    await expect
      .poll(() =>
        lanes.locator(".pl-tl-grid .today").evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.left > 0 && box.left < window.innerWidth;
        }),
      )
      .toBe(true);
    await page
      .getByRole("group", { name: "Filtrer les tâches" })
      .getByRole("button", { name: "Mois" })
      .click();
    await shot(page, "c17-planner-timeline");
    // A bar opens the same detail as its card, where the planned start is set.
    await bar("Écrire le changelog").click();
    await detail.getByLabel("Début prévu").fill("2020-01-10");
    await detail.getByRole("button", { name: "Fermer", exact: true }).click();

    // On a phone the timeline scrolls inside itself; the page does not.
    await page.setViewportSize({ width: 390, height: 780 });
    await done.waitFor();
    if (shots) await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "c18-planner-timeline-mobile");
    await page.getByRole("tab", { name: "Tableau" }).click();

    // On a phone the columns scroll sideways; the page itself does not.
    await column("À faire").waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await mine.scrollIntoViewIfNeeded();
    await mine.click();
    await detail.getByLabel("Titre").waitFor();
    if (shots) await page.waitForTimeout(400);
    await shot(page, "c16-planner-mobile");
    await detail.getByRole("button", { name: "Supprimer" }).click();
    await expect.poll(() => mine.count()).toBe(0);
    await page.close();
  });

  it("plans a task for later: it starts by itself at its time, in a thread of its own", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await menu(page)
      .getByRole("button", { name: /^equipe/ })
      .click();
    await page
      .getByRole("complementary", { name: "Fils du projet" })
      .getByRole("button", { name: "Nouveau fil" })
      .click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    const dialog = page.getByRole("dialog", { name: "Planifier une tâche" });
    const list = page.getByRole("list", { name: "Tâches planifiées" });
    const row = (title: string) => list.getByRole("listitem").filter({ hasText: title });
    const field = (at: Date) => {
      const two = (n: number) => String(n).padStart(2, "0");
      return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
    };
    /** The demo agent for the task, not a real one that may be installed on this machine. */
    const byDemo = async () => {
      await dialog.getByRole("button", { name: /^Modèle : / }).click();
      const models = page.getByRole("dialog", { name: "Modèle", exact: true });
      const demo = models
        .getByRole("group", { name: "Agent de démo", exact: true })
        .getByRole("radio")
        .first();
      await expect
        .poll(async () => {
          if (await demo.count()) return true;
          const all = models.getByRole("button", { name: "Tous", exact: true });
          if (await all.count()) await all.click();
          return false;
        })
        .toBe(true);
      await demo.click();
      await models.waitFor({ state: "hidden" });
    };
    const save = (sheet = dialog, name = "Planifier") =>
      sheet.getByRole("button", { name, exact: true }).click();

    // The command carries what follows it into the dialog; a time in the past is refused.
    await composer(page).fill("/planifier Résume les changements de la semaine");
    await composer(page).press("Enter");
    await dialog.getByLabel("Tâche").waitFor();
    expect(await dialog.getByLabel("Tâche").inputValue()).toBe(
      "Résume les changements de la semaine",
    );
    await byDemo();
    await dialog.getByLabel("Quand").fill("2020-01-15T09:00");
    await save();
    await dialog.getByRole("alert").getByText("Ce moment est déjà passé").waitFor();

    // Planned every day from tomorrow: it waits, and says when it will start.
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(9, 0, 0, 0);
    await dialog.getByLabel("Quand").fill(field(tomorrow));
    await dialog
      .getByRole("radiogroup", { name: "Répéter" })
      .getByRole("radio", { name: "Tous les jours" })
      .click();
    await dialog.getByLabel("Nom").fill("Résumé du matin");
    await save();
    // The planned tasks have a page of their own, where the new one is.
    await page.waitForURL(/\/planner\/planifiees$/);
    const morning = row("Résumé du matin");
    await morning.getByText("Prochain lancement demain à 09:00").waitFor();
    expect(await morning.locator(".rep").textContent()).toBe("Tous les jours à 09:00");
    expect(await morning.locator(".pcm").textContent()).toBe("equipe" + "Agent de démo");

    // One for this very minute: the server starts it by itself, in a thread of its own.
    await page.getByRole("button", { name: "Planifier une tâche", exact: true }).click();
    await dialog.getByLabel("Tâche").fill("Dis bonjour");
    await byDemo();
    await dialog.getByLabel("Quand").fill(field(new Date()));
    await save();
    await row("Dis bonjour")
      .getByText(/^Lancée aujourd'hui à/)
      .waitFor();
    await shot(page, "c19-planifiees");
    await page.getByRole("button", { name: "Ouvrir le fil de Dis bonjour" }).click();
    await page.waitForURL(/\/t\//);
    await page.locator(".uw .u", { hasText: "Dis bonjour" }).first().waitFor();
    await page.goBack();

    // Paused, it no longer has a next time; changed, it keeps what was not touched.
    const toggle = (title: string) => page.getByRole("switch", { name: `Activer ${title}` });
    await toggle("Résumé du matin").click();
    await morning.getByText("En pause").waitFor();
    // Paused, it still opens on its own time, and stays paused when only its text changes.
    const edit = page.getByRole("dialog", { name: "Modifier la tâche planifiée" });
    await page.getByRole("button", { name: "Modifier Résumé du matin" }).click();
    await expect.poll(() => edit.getByLabel("Quand").inputValue()).toBe(field(tomorrow));
    await save(edit, "Enregistrer");
    await edit.waitFor({ state: "hidden" });
    await morning.getByText("En pause").waitFor();
    await toggle("Résumé du matin").click();
    await morning.getByText("Prochain lancement demain à 09:00").waitFor();
    await page.getByRole("button", { name: "Modifier Résumé du matin" }).click();
    await edit.getByLabel("Nom").fill("Résumé quotidien");
    await save(edit, "Enregistrer");
    const daily = row("Résumé quotidien");
    await daily.getByText("Prochain lancement demain à 09:00").waitFor();

    // Started by hand, its time does not move.
    await page.getByRole("button", { name: "Lancer maintenant Résumé quotidien" }).click();
    await page.waitForURL(/\/t\//);
    await page
      .locator(".uw .u", { hasText: "Résume les changements de la semaine" })
      .first()
      .waitFor();
    await page.goBack();
    await daily.getByText(/^Prochain lancement demain à 09:00 · dernier aujourd'hui/).waitFor();

    // On a phone the list fits the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await daily.waitFor();
    if (shots) await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "c20-planifiees-mobile");
    await page.getByRole("button", { name: "Supprimer Résumé quotidien" }).click();
    await expect.poll(() => daily.count()).toBe(0);
    await page.close();
  });

  it("keeps the composer's menus above it, sets effort per model, and names agents without logos", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await menu(page).getByRole("button", { name: "Nouvelle discussion" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    /** True when the first thing of that menu or sheet is what a press there would reach. */
    const onTop = (name: string, role: "menu" | "dialog") =>
      page.getByRole(role, { name, exact: true }).evaluate((el) => {
        const target = el.querySelector("button");
        if (!target) return false;
        const box = target.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!top && el.contains(top);
      });

    // The « + » menu opens above the composer, not under it.
    await composer(page).click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    const add = page.getByRole("menu", { name: "Ajouter" });
    await add.waitFor();
    await expect.poll(() => onTop("Ajouter", "menu")).toBe(true);
    await shot(page, "c21-menu-ajouter");

    // Where to work is chosen from it: the git repository « equipe ».
    await add.getByRole("menuitem", { name: /^Projet/ }).click();
    const where = page.getByRole("dialog", { name: "Où travailler" });
    await where.getByRole("button", { name: "Hors projet", exact: false }).waitFor();
    await where.getByRole("button", { name: "equipe", exact: true }).click();
    await where.waitFor({ state: "hidden" });
    await composer(page).click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await add.getByRole("menuitem", { name: "Projet equipe" }).waitFor();
    // In a repository, the options say where the agent works: on a branch apart, or in the folder.
    await add.getByRole("menuitem", { name: "Plus" }).click();
    const more = page.getByRole("dialog", { name: "Ajouter", exact: true });
    const branch = more.getByRole("radiogroup", { name: "Branche" });
    await branch.getByRole("radio", { name: "Sur une branche à part" }).waitFor();
    await expect.poll(() => onTop("Ajouter", "dialog")).toBe(true);
    await branch.getByRole("radio", { name: "Dans ton dossier" }).click();
    await expect
      .poll(() =>
        branch.getByRole("radio", { name: "Dans ton dossier" }).getAttribute("aria-checked"),
      )
      .toBe("true");
    await branch.getByRole("radio", { name: "Sur une branche à part" }).click();
    await page.keyboard.press("Escape");
    await more.waitFor({ state: "hidden" });

    // Every agent is listed by its name alone: no logo anywhere in the model sheets.
    await composer(page).click();
    await pill(page).click();
    const sheet = page.getByRole("dialog", { name: "Modèle", exact: true });
    await allModelsButton(sheet).click();
    const all = page.getByRole("dialog", { name: "Tous les modèles" });
    await showAgents(all);
    for (const name of ["Claude Code", "Codex", "Antigravity", "Cursor", "Hermes", "Agent de démo"])
      await all.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).waitFor();
    expect(await all.locator("img, svg image").count()).toBe(0);
    await shot(page, "c22-agents-sans-logo");

    // Each model has its own effort stops: three for « Démo rapide », four for « Démo précis ».
    // The highest one is « UltraMoon », whatever the agent calls it.
    const stops = async (model: string) => {
      await showAgents(all);
      await all.getByRole("menuitemradio", { name: /^Agent de démo/ }).click();
      // The first demo agent's: the second one has models of the same names.
      await all
        .getByRole("menuitemradio", { name: new RegExp(`^${model}`) })
        .first()
        .click();
      await all.waitFor({ state: "hidden" });
      // Folded, the composer hides its model: it is opened before its label is read.
      await composer(page).click();
      await expect.poll(() => pill(page).getAttribute("aria-label")).toContain(model);
      await pill(page).click();
      await sheet.getByRole("button", { name: /^Effort : / }).click();
      const slider = sheet.getByRole("slider", { name: `Effort de ${model}` });
      const max = await slider.getAttribute("aria-valuemax");
      await slider.focus();
      await page.keyboard.press("End");
      await expect.poll(() => slider.getAttribute("aria-valuetext")).toBe("UltraMoon");
      return max;
    };
    expect(await stops("Démo rapide")).toBe("2");
    await shot(page, "c22b-effort");
    await allModelsButton(sheet).click();
    expect(await stops("Démo précis")).toBe("3");
    await page.close();
  });

  it("lists the conversations started outside a project under « Récents », not as a project", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const side = menu(page);
    await side.getByRole("button", { name: "Nouvelle discussion" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // Outside any project: said from the « + » menu.
    await composer(page).click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Projet/ }).click();
    const where = page.getByRole("dialog", { name: "Où travailler" });
    await where.getByRole("button", { name: /^Hors projet/ }).click();
    await where.waitFor({ state: "hidden" });
    await pickAgent(page);
    await supervised(page);
    await composer(page).fill("Une question hors projet");
    await composer(page).press("Enter");
    await page.waitForURL(/\/t\//);

    // « Discussions » holds it, but is no project of the user's: no line of its own…
    const line = side.getByRole("button", { name: /^Une question hors projet/ });
    await line.first().waitFor();
    expect(await side.getByRole("button", { name: /^Discussions/ }).count()).toBe(0);
    // …the conversation is under « Récents ».
    const rows = await side.locator(".dsec, .rc").allTextContents();
    const recent = rows.findIndex((r) => r.trim() === "Récents");
    expect(recent).toBeGreaterThan(-1);
    expect(recent).toBeLessThan(rows.findIndex((r) => r.includes("Une question hors projet")));
    await shot(page, "c23-discussions-recents");

    // Outside a project, the header keeps only « … »: no changes to look at.
    expect(await page.getByRole("button", { name: /^Modifications/ }).count()).toBe(0);
    // Renamed from its « … » menu, for every list of threads.
    await page.getByRole("button", { name: "Actions du fil" }).click();
    await page.getByRole("menuitem", { name: "Renommer" }).hover();
    await shot(page, "c23b-menu-hors-projet");
    await page.getByRole("menuitem", { name: "Renommer" }).click();
    const name = page.getByRole("textbox", { name: "Nom de la discussion" });
    await name.fill("Nouveautés IA");
    await shot(page, "c23c-renommer");
    await name.press("Enter");
    await side
      .getByRole("button", { name: /^Nouveautés IA/ })
      .first()
      .waitFor();
    await page.locator(".ttl b", { hasText: "Nouveautés IA" }).waitFor();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Actions du fil" }).click();
    await page.getByRole("menuitem", { name: "Renommer" }).waitFor();
    await shot(page, "c23d-menu-telephone");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 820 });

    // Resolved, it has no project to sit under: « Résolus » below « Récents » keeps it.
    // The demo agent waits for a yes to change a file: stopped first, so the turn is over.
    await page.getByRole("button", { name: "Arrêter", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Arrêter", exact: true }).count())
      .toBe(0);
    await page.getByRole("button", { name: "Actions du fil" }).click();
    await page.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await page.getByText("Ce fil est résolu").waitFor();
    const renamed = side.getByRole("button", { name: /^Nouveautés IA/ });
    await expect.poll(() => renamed.count()).toBe(0);
    await side.getByRole("button", { name: /^Résolus \(\d+\)$/ }).click();
    await renamed.first().waitFor();
    await page.close();
  });

  it("moves a conversation started outside a project into a project", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const side = menu(page);
    const dest = path.join(dir, "destination");
    write(dest, { "README.md": "# Destination\n" });
    await addProject(page, dest, false);
    await side.getByRole("button", { name: "Nouvelle discussion" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await composer(page).click();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Projet/ }).click();
    const where = page.getByRole("dialog", { name: "Où travailler" });
    await where.getByRole("button", { name: /^Hors projet/ }).click();
    await where.waitFor({ state: "hidden" });
    await pickAgent(page);
    await supervised(page);
    await composer(page).fill("Une question à déplacer");
    await composer(page).press("Enter");
    await page.waitForURL(/\/t\//);
    await page.getByRole("button", { name: "Arrêter", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Arrêter", exact: true }).count())
      .toBe(0);

    await page.getByRole("button", { name: "Actions du fil" }).click();
    await page.getByRole("menuitem", { name: "Déplacer vers un projet" }).click();
    const projects = page.getByRole("menu", { name: "Déplacer vers un projet" });
    await projects.getByRole("menuitem", { name: "destination" }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, "c24-deplacer");
    await projects.getByRole("menuitem", { name: "destination" }).click();
    // The project's now: its menu no longer offers to move it.
    await expect
      .poll(async () => {
        await page.getByRole("button", { name: "Actions du fil" }).click();
        await page.getByRole("menuitem", { name: "Renommer" }).waitFor();
        const offered = await page
          .getByRole("menuitem", { name: "Déplacer vers un projet" })
          .count();
        await page.keyboard.press("Escape");
        await page.getByRole("menu", { name: "Actions du fil" }).waitFor({ state: "hidden" });
        return offered;
      })
      .toBe(0);
    // Listed on the project's page.
    await side.getByRole("button", { name: /^destination/ }).click();
    await page.getByText("Une question à déplacer").first().waitFor();
    await page.goBack();
    // It goes on in the project.
    await composer(page).fill("Et dans le projet ?");
    await composer(page).press("Enter");
    await page.getByText("Et dans le projet ?").first().waitFor();

    // A thread of a project is renamed from its line too: a right click in the sidebar.
    await side
      .getByRole("button", { name: /^Une question à déplacer/ })
      .first()
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Renommer" }).click();
    await page.getByRole("dialog", { name: "Renommer le fil" }).waitFor();
    const name = page.getByRole("textbox", { name: "Nom du fil" });
    await name.fill("Question du projet");
    await shot(page, "c25-renommer-fil");
    await name.press("Enter");
    await side
      .getByRole("button", { name: /^Question du projet/ })
      .first()
      .waitFor();
    await page.locator(".ttl b", { hasText: "Question du projet" }).waitFor();
    await page.close();
  });
});
