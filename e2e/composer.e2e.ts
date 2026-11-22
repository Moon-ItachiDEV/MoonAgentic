// First end-to-end check: the built app, the real server, the demo agent, a real browser.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
/** Picks an agent from the model sheet: « Tous », then « Options ». */
async function pickAgent(page: Page, name: RegExp) {
  await page.locator(".agentchip").click();
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

const options = (page: Page) => page.locator("#composer-suggest [role=option]");

describe("composer", () => {
  it("offers commands, files and skills, sends them, pins the thread and finds it again", async () => {
    // The port is chosen by the system; the address printed is the one to open.
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);

    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByLabel("Dossier").fill(project);
    await page.getByRole("button", { name: "Créer" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // The demo agent, not a real one that may be installed on this machine.
    await pickAgent(page, /Agent de démo/);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".agentchip").textContent()).toContain("Agent de démo");

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
    await composer(page).fill("/rev");
    await composer(page).press("Enter");
    await expect.poll(() => composer(page).inputValue()).toContain("Relis les changements");

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

    await page.getByRole("button", { name: "Supervisé" }).click();
    await composer(page).press("Enter");
    // The agent got the file and the skill with the message.
    await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").waitFor();
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();

    // In the thread, the agent's own commands join in, with who offers them.
    await composer(page).fill("/");
    await expect
      .poll(async () => (await options(page).allTextContents()).join(" | "))
      .toContain("/explique");
    await shot(page, "c4-commandes-agent");
    await composer(page).fill("/epingler");
    await composer(page).press("Enter");
    await page.getByText("Épinglés").waitFor();

    // Ctrl K finds the message, and opens its thread.
    await page.goto(url.replace(/\?.*$/, ""));
    await page.getByText("Épinglés").waitFor();
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
    await page.getByRole("button", { name: "Connexions" }).click();
    const dialog = page.getByRole("dialog", { name: "Connexions" });
    const demo = dialog.locator(".cx-row", { hasText: "Agent de démo" }).first();
    await demo.getByRole("button", { name: "Vérifier" }).click();
    await expect.poll(() => demo.locator(".st").textContent()).toBe("Prêt");
    await demo.getByText("Version : moonagentic-demo 0.1.0").waitFor();

    // An agent of the user's own whose command this machine lacks says so.
    await dialog.getByRole("button", { name: "Ajouter un agent" }).click();
    await dialog.getByLabel("Nom").fill("Mon agent");
    await dialog.getByLabel("Commande qui le lance en mode ACP").fill("pas-une-commande-e2e acp");
    await dialog.getByRole("button", { name: "Ajouter", exact: true }).click();
    const mine = dialog.locator(".cx-row", { hasText: "Mon agent" });
    await mine.getByText("Commande introuvable sur cette machine : pas-une-commande-e2e").waitFor();
    await shot(page, "c7-connexions");
    await mine.getByRole("button", { name: "Retirer Mon agent" }).click();
    await mine.getByRole("button", { name: "Confirmer le retrait de Mon agent" }).click();
    await expect.poll(() => mine.count()).toBe(0);
    await dialog.getByRole("button", { name: "Fermer" }).click();

    // A supervised turn waits for the user, who answers from À traiter.
    await pickAgent(page, /Agent de démo/);
    await page.keyboard.press("Escape");
    await composer(page).fill("Corrige la réponse");
    await composer(page).press("Enter");
    const inbox = page.getByRole("button", { name: /À traiter/ });
    // The agent starts its process before it asks: more than the poll's usual second on CI.
    await expect.poll(() => inbox.textContent(), { timeout: 15_000 }).toContain("1");
    await inbox.click();
    const requests = page.getByRole("dialog", { name: "À traiter" });
    await requests.getByText("Modifier src/app.ts").waitFor();
    await shot(page, "c8-a-traiter");
    await requests.getByRole("button", { name: "Autoriser" }).click();
    await requests.getByText("Aucun agent n'attend ta réponse.").waitFor();
    await requests.getByRole("button", { name: "Fermer" }).click();
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
  // The stand-in « gh » is a POSIX shell script that Windows cannot run (the server does not take
  // a .cmd as the GitHub CLI, on purpose). The canClone rule itself is covered by github.test.ts.
  it.skipIf(process.platform === "win32")(
    "lists the user's GitHub repositories to clone, and explains a profile address",
    async () => {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByRole("button", { name: "Nouveau projet" }).first().click();
      await page.getByRole("radio", { name: "Cloner depuis GitHub" }).click();
      // The list arrives: it used to stay on « Chargement de tes dépôts… » forever.
      const list = page.getByRole("list", { name: "Tes dépôts GitHub" });
      await expect.poll(() => list.getByRole("button").count()).toBe(2);
      await page.getByRole("textbox", { name: "Dépôt" }).fill("https://github.com/moon");
      await page.getByText("C'est l'adresse du compte @moon").waitFor();
      await expect.poll(() => page.getByRole("button", { name: "Cloner" }).isDisabled()).toBe(true);
      // A name does not make a profile address clonable.
      await page.getByRole("textbox", { name: "Nom" }).fill("site");
      await expect.poll(() => page.getByRole("button", { name: "Cloner" }).isDisabled()).toBe(true);
      await page.getByRole("textbox", { name: "Nom" }).fill("");
      await list.getByRole("button", { name: /moon\/site/ }).click();
      expect(await page.getByRole("textbox", { name: "Dépôt" }).inputValue()).toBe("moon/site");
      expect(await page.getByRole("textbox", { name: "Nom" }).getAttribute("placeholder")).toBe(
        "site",
      );
      await expect
        .poll(() => page.getByRole("button", { name: "Cloner" }).isDisabled())
        .toBe(false);
      await page.close();
    },
  );
  it("archives a thread, brings it back, deletes it, then removes the project", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Corrige la réponse" }).first().click();
    const menu = page.getByRole("button", { name: "Actions du fil" });

    // On a phone, the menu opens inside the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await menu.click();
    const box = await page.locator(".menu.thread-menu").boundingBox();
    expect(box && box.y >= 0 && box.y + box.height <= 780 && box.x >= 0).toBe(true);
    await menu.click();
    await page.setViewportSize({ width: 1280, height: 820 });

    await menu.click();
    await page.getByRole("menuitem", { name: "Archiver" }).click();
    await page.getByText("Cette discussion est archivée.").waitFor();
    await page.getByRole("button", { name: "Archivés (1)" }).click();
    await shot(page, "c9-archive");
    await page.getByRole("button", { name: "Désarchiver" }).click();
    await expect.poll(() => composer(page).count()).toBe(1);

    // The same actions from the sidebar, behind « … » on the thread's line.
    const more = page.getByRole("button", { name: /^Actions de Corrige la réponse/ }).first();
    const rowMenu = page.getByRole("menu", { name: /^Actions de Corrige la réponse/ });
    await more.click();
    await rowMenu.getByRole("menuitem", { name: /pingler$/ }).waitFor();
    if (shots) await page.waitForTimeout(300);
    await shot(page, "c9b-menu-ligne");
    await page.keyboard.press("Escape");
    await expect.poll(() => rowMenu.count()).toBe(0);
    // A pinned thread is listed twice: the menu belongs to one line, and moves to the other.
    const twice = page.getByRole("button", { name: /^Actions de Lis/ });
    expect(await twice.count()).toBe(2);
    // The lower line first: its menu drops below it, clear of the other line's button.
    await twice.last().click();
    await expect.poll(() => page.locator(".thr-row.menu-open").count()).toBe(1);
    await twice.first().click();
    await expect.poll(() => twice.first().getAttribute("aria-expanded")).toBe("true");
    expect(await twice.last().getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(".thr-row.menu-open").count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("menu", { name: /^Actions de Lis/ }).count()).toBe(0);
    await more.click();
    await rowMenu.getByRole("menuitem", { name: "Archiver" }).click();
    await page.getByText("Cette discussion est archivée.").waitFor();
    await more.click();
    await rowMenu.getByRole("menuitem", { name: "Désarchiver" }).click();
    await expect.poll(() => composer(page).count()).toBe(1);
    // On a phone there is no hover: the button is always there, and the menu is a sheet.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await more.click();
    // The sheet slides up: wait until it sits whole on the screen.
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
    await page.setViewportSize({ width: 1280, height: 820 });

    await more.click();
    await rowMenu.getByRole("menuitem", { name: "Supprimer…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Supprimer cette discussion ?" });
    await confirm.getByRole("button", { name: "Supprimer" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Corrige la réponse" }).count())
      .toBe(0);

    await page.getByRole("button", { name: "Retirer le projet projet" }).click();
    await page
      .getByRole("alertdialog", { name: "Retirer ce projet ?" })
      .getByRole("button", { name: "Retirer" })
      .click();
    await page.getByText("Aucun projet pour l'instant.").waitFor();
    // The folder itself is left alone.
    expect(existsSync(path.join(project, "src/app.ts"))).toBe(true);
    await page.close();
  });

  it("gives a task to a team: the lead splits it, coders do the pieces on their own branches", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByLabel("Dossier").fill(repo);
    await page.getByRole("button", { name: "Créer" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);

    await composer(page).fill("/equipe Corrige answer et documente-la");
    await composer(page).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Confier à une équipe" });
    await expect
      .poll(() => dialog.getByLabel("Tâche").inputValue())
      .toBe("Corrige answer et documente-la");
    // The demo agent for every role, not a real one that may be installed on this machine.
    await dialog.getByLabel("Chef", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Codeurs", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Relecteur", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Testeur", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Fusionneur", { exact: true }).selectOption({ label: "Agent de démo" });
    await shot(page, "c10-equipe-lancer");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    // Every role is on the timeline from the start, the agent and model of each said.
    const strip = page.getByRole("region", { name: "Frise de l'équipe" });
    await strip.getByText(/^Fusionneur · Agent de démo/).waitFor();
    await dialog.waitFor({ state: "hidden" });
    await shot(page, "c10b-equipe-depart");

    const card = page.getByRole("region", { name: "Équipe", exact: true });
    await card.getByText("Terminé : tout est réuni sur une branche").waitFor({ timeout: 30_000 });
    // One calm step per role: the lead's plan, each piece with its coder, then the merge.
    expect(await card.getByRole("listitem").allTextContents()).toEqual([
      "Découper la tâcheChef · Agent de démo2 sous-tâches",
      "Corriger answerCodeur · Agent de démofusionnéeRelectureTests",
      "Documenter answerCodeur · Agent de démofusionnéeRelectureTests",
      "Réunir les sous-tâchesFusionneur · Agent de démofaiteOuvrir la fusion",
    ]);
    // The lead's internal prompt and plan stay folded: only « Voir le détail » shows.
    expect(await page.getByText("Tu es le chef d'une équipe").count()).toBe(0);
    await page.locator(".team-detail-h").first().click();
    await page.getByText("Tu es le chef d'une équipe").waitFor();
    await page.locator(".team-detail-h").first().click();
    // Ctrl K leaves the team's own messages out, and opens the detail that holds a hit.
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "Rechercher" });
    await search.fill("Tu es le chef d'une équipe");
    await page.getByText("Aucun résultat.").waitFor();
    await search.fill("Voici le plan");
    await page.getByRole("option", { name: /Voici le plan/ }).click();
    await page.getByText("Voici le plan.").waitFor();
    expect(await page.locator(".team-detail.open").count()).toBe(1);
    await page.locator(".team-detail-h").first().click();
    // The team is one line of its project in the sidebar; open, its lead shows every member
    // under it: two coders, their reviewers and testers, and the merge.
    expect(await page.locator(".thr-row.lead").count()).toBe(1);
    expect(await page.locator(".thr-row.child").count()).toBe(7);
    // Its chevron still folds it, though its lead's thread is open; so does the project's.
    await page.getByRole("button", { name: /^Replier l'équipe/ }).click();
    expect(await page.locator(".thr-row.child").count()).toBe(0);
    await page.getByRole("button", { name: /^Replier le projet/ }).click();
    expect(await page.locator(".thr-row.lead").count()).toBe(0);
    await page.getByRole("button", { name: /^Déplier le projet/ }).click();
    await page.getByRole("button", { name: /^Déplier l'équipe/ }).click();
    // The timeline, drawn from what the team really did: a lane for the lead, each piece
    // and the merge, ended.
    expect(
      await strip
        .getByRole("button", { name: /^(Chef|Corriger answer|Documenter answer|Fusion) :/ })
        .count(),
    ).toBe(4);
    await strip.getByText(/^Terminée · /).waitFor();
    await shot(page, "c11-equipe");
    await card.getByRole("button", { name: "Ouvrir la fusion" }).click();
    await page.getByRole("button", { name: /Sous-tâche de l'équipe/ }).click();

    await card.getByRole("button", { name: "Documenter answer" }).click();
    await page.getByRole("button", { name: /Sous-tâche de l'équipe/ }).waitFor();
    await shot(page, "c11b-equipe-codeur");

    // A piece the reviewer keeps refusing goes back three times, then to the lead, then to the user.
    await composer(page).fill("/equipe Corrige answer, à toujours refuser");
    await composer(page).press("Enter");
    await dialog.getByLabel("Chef", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Codeurs", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Relecteur", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Testeur", { exact: true }).selectOption({ label: "Personne" });
    await dialog.getByLabel("Fusionneur", { exact: true }).selectOption({ label: "Personne" });
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    await card.getByText("2 sous-tâches t'attendent").waitFor({ timeout: 60_000 });
    await card.getByText("Il manque une vérification").first().waitFor();
    await shot(page, "c12-equipe-bloquee");
    await card.getByRole("button", { name: "Relancer « Corriger answer »" }).click();
    await card.getByText("L'équipe travaille").or(card.getByText("t'attend")).first().waitFor();

    // Live: supervised coders wait on the user, and the timeline says so as it happens.
    await composer(page).fill("/equipe Corrige answer");
    await composer(page).press("Enter");
    await dialog.getByLabel("Chef", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Codeurs", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Relecteur", { exact: true }).selectOption({ label: "Personne" });
    await dialog.getByLabel("Testeur", { exact: true }).selectOption({ label: "Personne" });
    await dialog.getByLabel("Fusionneur", { exact: true }).selectOption({ label: "Personne" });
    await dialog
      .getByLabel("Accès des codeurs")
      .selectOption({ label: "Ils me demandent avant d'agir" });
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    await strip.getByText("2 attendent ton accord").waitFor({ timeout: 30_000 });
    expect(await strip.getByRole("button", { name: /: attend ton accord$/ }).count()).toBe(2);
    await shot(page, "c13-frise-en-direct");
    await card.getByRole("button", { name: "Arrêter l'équipe" }).click();
    await strip.getByText(/^Arrêtée · /).waitFor();
    await page.close();
  });

  it("plans the project's work: the teams' cards follow their pieces, the user's are theirs to move", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.locator(".thr-row.proj", { hasText: "equipe" }).locator(".thr").click();
    await page.getByRole("button", { name: "Planner", exact: true }).click();
    const column = (name: string) => page.getByRole("region", { name, exact: true });
    const cardOf = (title: string) => page.getByRole("button", { name: new RegExp(`: ${title},`) });

    // The first team's plan, laid down by its lead and carried to the end by its pieces.
    await column("Livré").getByText("Documenter answer").waitFor();
    expect(await column("Livré").locator(".pl-card").count()).toBe(2);
    expect(await column("Livré").locator(".pl-src").first().textContent()).toBe("Chef");
    // The team that was stopped left its pieces where they stopped.
    await column("Reporté").getByText("arrêtée").first().waitFor();

    // A card of the user's own, added in place.
    await page.getByRole("button", { name: "Ajouter une tâche" }).click();
    await page.getByLabel("Nouvelle tâche, À faire").fill("Écrire le changelog");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    const mine = cardOf("Écrire le changelog");
    await column("À faire").getByText("Écrire le changelog").waitFor();
    expect(await mine.locator(".pl-src").textContent()).toBe("À la main");

    // Moved from the keyboard, then from its detail, where it gets a due day and a thread.
    await mine.focus();
    await page.keyboard.press("ArrowRight");
    await column("En cours").getByText("Écrire le changelog").waitFor();
    await mine.click();
    const detail = page.getByRole("dialog", { name: /^Tâche \d+$/ });
    await detail.getByRole("button", { name: "En test" }).click();
    await detail.getByLabel("Échéance").fill("2020-01-15");
    await detail
      .getByLabel("Fil qui s'en occupe")
      .selectOption({ label: "Équipe : Corrige answer et documente-la" });
    await detail.getByText("Agent de démo").waitFor();
    // A click outside closes the panel, and keeps what was being typed.
    await detail.getByLabel("Description").fill("Pour la v1");
    await page.mouse.click(300, 600);
    await expect.poll(() => detail.count()).toBe(0);
    await mine.click();
    await expect.poll(() => detail.getByLabel("Description").inputValue()).toBe("Pour la v1");
    // A year half typed in the date field is not sent, so nothing complains.
    await detail.getByLabel("Échéance").fill("0002-01-15");
    await detail.getByLabel("Échéance").fill("2020-01-15");
    expect(await page.locator(".toast").count()).toBe(0);
    await detail.getByRole("button", { name: "Fermer" }).click();
    await column("En test").getByText("en retard · 15 janv").waitFor();
    await shot(page, "c14-planner");

    // A team's card says what moves it, and cannot be moved by hand.
    await column("Livré").getByText("Documenter answer").click();
    await detail.getByText("Cette carte suit le travail de l'équipe").waitFor();
    expect(await detail.getByRole("button", { name: "En cours" }).isDisabled()).toBe(true);
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
    expect(await bar("Écrire le changelog").getAttribute("class")).toContain("s-test");
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
      .getByRole("group", { name: "Échelle" })
      .getByRole("button", { name: "Mois" })
      .click();
    await shot(page, "c17-planner-timeline");
    // A bar opens the same detail as its card, where the planned start is set.
    await bar("Écrire le changelog").click();
    await detail.getByLabel("Début prévu").fill("2020-01-10");
    await detail.getByRole("button", { name: "Fermer" }).click();

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
    await column("En test").getByText("Écrire le changelog").scrollIntoViewIfNeeded();
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
    await page.locator(".thr-row.proj", { hasText: "equipe" }).locator(".thr").click();
    const dialog = page.getByRole("dialog", { name: "Planifier une tâche" });
    const list = page.getByRole("list", { name: "Tâches planifiées" });
    const row = (title: string) => list.getByRole("listitem").filter({ hasText: title });
    const field = (at: Date) => {
      const two = (n: number) => String(n).padStart(2, "0");
      return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
    };

    // The command carries what follows it into the dialog; a time in the past is refused.
    await composer(page).fill("/planifier Résume les changements de la semaine");
    await composer(page).press("Enter");
    await composer(page).press("Enter");
    await dialog.getByLabel("Tâche").waitFor();
    expect(await dialog.getByLabel("Tâche").inputValue()).toBe(
      "Résume les changements de la semaine",
    );
    await dialog.getByLabel("Agent", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Quand").fill("2020-01-15T09:00");
    await dialog.getByRole("button", { name: "Planifier", exact: true }).click();
    await dialog.getByText("Ce moment est déjà passé").waitFor();

    // Planned every day from tomorrow: it waits, and says when it will start.
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(9, 0, 0, 0);
    await dialog.getByLabel("Quand").fill(field(tomorrow));
    await dialog.getByLabel("Répéter").selectOption({ label: "Tous les jours" });
    await dialog.getByLabel("Nom").fill("Résumé du matin");
    await dialog.getByRole("button", { name: "Planifier", exact: true }).click();
    await row("Résumé du matin").getByText("Prochain lancement demain à 09:00").waitFor();
    await row("Résumé du matin").getByText("Tous les jours à 09:00 · Agent de démo").waitFor();

    // One for this very minute: the server starts it by itself, in a thread of its own.
    await page.getByRole("button", { name: "Planifier une tâche" }).click();
    await dialog.getByLabel("Tâche").fill("Dis bonjour");
    await dialog.getByLabel("Agent", { exact: true }).selectOption({ label: "Agent de démo" });
    await dialog.getByLabel("Quand").fill(field(new Date()));
    await dialog.getByRole("button", { name: "Planifier", exact: true }).click();
    await row("Dis bonjour")
      .getByText(/^Lancée aujourd'hui à/)
      .waitFor();
    await shot(page, "c19-planifiees");
    await row("Dis bonjour").getByRole("button", { name: "Ouvrir le fil" }).click();
    await page.locator(".view").getByText("Dis bonjour").first().waitFor();
    await page.goBack();

    // Paused, it no longer has a next time; changed, it keeps what was not touched.
    await row("Résumé du matin").getByRole("switch").click();
    await row("Résumé du matin").getByText("En pause").waitFor();
    // Paused, it still opens on its own time, and stays paused when only its text changes.
    await row("Résumé du matin").getByRole("button", { name: "Modifier" }).click();
    const paused = page.getByRole("dialog", { name: "Modifier la tâche planifiée" });
    expect(await paused.getByLabel("Quand").inputValue()).toBe(field(tomorrow));
    await paused.getByRole("button", { name: "Enregistrer" }).click();
    await row("Résumé du matin").getByText("En pause").waitFor();
    await row("Résumé du matin").getByRole("switch").click();
    await row("Résumé du matin").getByText("Prochain lancement demain à 09:00").waitFor();
    await row("Résumé du matin").getByRole("button", { name: "Modifier" }).click();
    const edit = page.getByRole("dialog", { name: "Modifier la tâche planifiée" });
    await edit.getByLabel("Nom").fill("Résumé quotidien");
    await edit.getByRole("button", { name: "Enregistrer" }).click();
    await row("Résumé quotidien").getByText("Prochain lancement demain à 09:00").waitFor();

    // Started by hand, its time does not move.
    await row("Résumé quotidien").getByRole("button", { name: "Lancer maintenant" }).click();
    await page.locator(".view").getByText("Résume les changements de la semaine").first().waitFor();
    await page.goBack();
    await row("Résumé quotidien")
      .getByText(/Dernier lancement aujourd'hui/)
      .waitFor();
    await row("Résumé quotidien").getByText("Prochain lancement demain à 09:00").waitFor();

    // On a phone the list fits the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    if (shots) await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "c20-planifiees-mobile");
    await row("Résumé quotidien").getByRole("button", { name: "Supprimer" }).click();
    await expect.poll(() => row("Résumé quotidien").count()).toBe(0);
    await page.close();
  });
});
