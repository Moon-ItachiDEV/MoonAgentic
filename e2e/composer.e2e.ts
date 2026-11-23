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
/** Picks an agent from the model sheet: « Tous », then « Options ». */
async function pickAgent(page: Page, name: RegExp) {
  await page.locator(".agentchip").click();
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

/**
 * Waits for the composer to write in this project. The field is usable before any project
 * exists (« Discussions » is made then), so being enabled no longer says the project is there.
 */
const inProject = (page: Page, name: string) =>
  expect.poll(() => page.locator(".tray").first().textContent()).toContain(name);

const options = (page: Page) => page.locator("#composer-suggest [role=option]");

describe("composer", () => {
  it("offers commands, files and skills, sends them, pins the thread and finds it again", async () => {
    // The port is chosen by the system; the address printed is the one to open.
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);

    await page.getByRole("button", { name: "Nouveau projet" }).first().click();

    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();

    await page.getByLabel("Dossier", { exact: true }).fill(project);

    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    await inProject(page, "projet");
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

    await page.getByRole("button", { name: /Mode d'accès/ }).click();
    await page.getByRole("menuitemradio", { name: /Accès complet/ }).click();
    await composer(page).press("Enter");
    await page.getByText("C'est fait, la réponse vaut 42.").waitFor();
    // The agent's plan is one card: every step done, it folds to its title and its footer.
    const plan = page.locator(".agent-plan").last();
    await plan.getByText("Terminé · 2 sur 2").waitFor();
    expect(await plan.locator("li").count()).toBe(0);
    await plan.locator(".agent-plan-h").click();
    expect(await plan.locator("li.done").count()).toBe(2);
    // What the agent read on a step is noted on it.
    await plan.locator("li.done").first().getByText("app.ts").waitFor();
    await plan.locator(".agent-plan-h").click();
    // What it said on the way is folded with its steps, under one line.
    expect(await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").count()).toBe(
      0,
    );
    await page.locator(".team-detail-h").last().click();
    // The agent got the file and the skill with the message.
    await page.getByText("Pièces jointes : app.ts (texte), SKILL.md (texte).").waitFor();
    await page.locator(".team-detail-h").last().click();

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
      // GitHub comes first, signed in here through the user's own `gh`.
      // The list arrives: it used to stay on « Chargement de tes dépôts… » forever.
      const list = page.getByRole("list", { name: "Tes dépôts GitHub" });
      await expect.poll(() => list.getByRole("button").count()).toBe(2);
      await page.getByRole("textbox", { name: "Dépôt" }).fill("https://github.com/moon");
      await page.getByText("C'est l'adresse du compte @moon").waitFor();
      await expect.poll(() => page.getByRole("button", { name: "Cloner" }).isDisabled()).toBe(true);
      await page.getByRole("textbox", { name: "Dépôt" }).fill("");
      await list.getByRole("button", { name: /moon\/site/ }).click();
      // Picked: where it goes is said, and can be changed.
      await page.getByText("Sera cloné dans").waitFor();
      expect(await page.locator(".np-where .mono").textContent()).toMatch(/[\\/]site$/);
      await page.getByRole("button", { name: "Changer", exact: true }).last().click();
      expect(
        await page.getByRole("textbox", { name: "Nom du dossier" }).getAttribute("placeholder"),
      ).toBe("site");
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
    await page.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await page.getByText("Cette discussion est résolue.").waitFor();
    await page.getByRole("button", { name: "Résolus (1)" }).click();
    await shot(page, "c9-archive");
    await page.getByRole("button", { name: "Rouvrir" }).click();
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
    await rowMenu.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await page.getByText("Cette discussion est résolue.").waitFor();
    await more.click();
    await rowMenu.getByRole("menuitem", { name: "Rouvrir" }).click();
    await expect.poll(() => composer(page).count()).toBe(1);
    // On a phone there is no hover: the button is always there, and the menu is a sheet.
    // In a conversation, the arrow goes back home, where the « Projets » tab opens the list.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Retour", exact: true }).click();
    await page.locator(".tabbar").getByRole("button", { name: "Projets" }).click();
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
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    await inProject(page, "equipe");

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
    // The team opens its pull request at the end unless told not to.
    const autoShip = dialog.getByLabel(/Ouvrir la PR à la fin/);
    expect(await autoShip.isChecked()).toBe(true);
    await autoShip.scrollIntoViewIfNeeded();
    await shot(page, "c10c-equipe-pr");
    await dialog.getByRole("button", { name: "Lancer l'équipe" }).click();
    // Every role is on the timeline from the start, the agent and model of each said.
    const strip = page.getByRole("region", { name: "Frise de l'équipe" });
    await strip.getByText(/^Fusionneur · Agent de démo/).waitFor();
    await dialog.waitFor({ state: "hidden" });
    await shot(page, "c10b-equipe-depart");

    const card = page.getByRole("region", { name: "Équipe", exact: true });
    await card.getByText("Terminé : tout est réuni sur une branche").waitFor({ timeout: 30_000 });
    // One view of the team, its timeline: under it, only what is the user's to do. This
    // repository has no remote: the team says so, and can try again.
    await card.getByText(/remote/).waitFor();
    expect(await card.getByRole("button").allTextContents()).toEqual([
      "Ouvrir la fusion",
      "Réessayer",
    ]);
    expect(await page.getByText("Découper la tâche").count()).toBe(0);
    // The same team as a tree of its agents: the lead, each piece with its reviewer and its
    // tester, the merge. A card opens what there is to know about its agent.
    await strip.getByRole("radio", { name: "Arbre" }).click();
    const tree = strip.locator(".tt");
    await expect.poll(() => tree.locator(".tt-card").count()).toBe(8);
    await tree.getByRole("button", { name: /^Chef,/ }).click();
    await tree.getByRole("button", { name: "Ouvrir son fil" }).waitFor();
    await shot(page, "c10d-equipe-arbre");
    await page.keyboard.press("Escape");
    await strip.getByRole("radio", { name: "Étapes" }).click();
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

    await strip.getByRole("button", { name: /^Documenter answer :/ }).click();
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

  it("shows a project's conversations grouped by state, on a page of its own", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    const inSidebar = page.locator(".thr-row.proj", { hasText: "equipe" }).locator(".thr");
    await inSidebar.click();
    await page.getByRole("heading", { name: "equipe" }).waitFor();
    expect(new URL(page.url()).pathname).toMatch(/^\/p\//);

    // A conversation opened from the page lands in the project, and comes back on its list.
    await page.getByRole("button", { name: "Fil", exact: true }).click();
    await pickAgent(page, /Agent de démo/);
    await page.keyboard.press("Escape");
    await composer(page).fill("Dis bonjour");
    await composer(page).press("Enter");
    // The new thread opens by itself, then back to the project.
    await page.waitForURL(/\/t\//);
    await inSidebar.click();
    await page.getByRole("heading", { name: "equipe" }).waitFor();
    // Sent, then gone to another page before the thread exists: the user stays where they went.
    await page.getByRole("button", { name: "Fil", exact: true }).click();
    await composer(page).fill("Dis au revoir");
    await composer(page).press("Enter");
    await inSidebar.click();
    await page.locator(".pp-row", { hasText: "Dis au revoir" }).waitFor();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toMatch(/^\/p\//);
    const group = (name: string) => page.locator(".pp-group", { hasText: name });
    const fold = (name: string) => page.locator(".pp-gh", { hasText: name });
    // Its agent asks before changing a file: the thread waits on the user, and says so.
    const row = group("En attente").locator(".pp-row", { hasText: "Dis bonjour" });
    await row.waitFor();
    expect(await row.locator(".pp-line").textContent()).toBe("Attend ta réponse.");
    // What needs no one is folded until asked.
    expect(await fold("Inactif").getAttribute("aria-expanded")).toBe("false");
    await fold("Inactif").click();
    // A team counts once, as its lead: its coders stay behind it.
    expect(await page.locator(".pp-row", { hasText: "Dis bonjour" }).count()).toBe(1);
    expect(await page.locator(".pp-row .pp-agent", { hasText: "Équipe de" }).count()).toBe(
      await page.locator(".pp-row", { hasText: "Équipe :" }).count(),
    );
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p1-page-projet");

    // Once answered, the thread is at rest, under what its agent really said last.
    await page
      .getByRole("button", { name: /À traiter/ })
      .first()
      .click();
    const requests = page.getByRole("dialog", { name: "À traiter" });
    // Both threads opened here ask the same thing.
    const allow = requests.getByRole("button", { name: "Autoriser" });
    await expect.poll(() => allow.count()).toBe(2);
    await allow.first().click();
    await expect.poll(() => allow.count()).toBe(1);
    await allow.first().click();
    await requests.getByRole("button", { name: "Fermer" }).click();
    const idle = group("Inactif").locator(".pp-row", { hasText: "Dis bonjour" });
    await idle.waitFor();
    await expect.poll(() => idle.locator(".pp-line").textContent()).toContain("C'est fait");

    // Resolved from its menu, it moves to « Résolu »; reopened, it comes back.
    await idle.getByRole("button", { name: "Actions de Dis bonjour" }).click();
    await page.getByRole("menuitem", { name: "Marquer résolu" }).click();
    await fold("Résolu").click();
    const resolved = group("Résolu").locator(".pp-row", { hasText: "Dis bonjour" });
    await resolved.waitFor();
    await shot(page, "p2-resolu");
    await resolved.getByRole("button", { name: "Actions de Dis bonjour" }).click();
    await page.getByRole("menuitem", { name: "Rouvrir" }).click();
    await group("Inactif").locator(".pp-row", { hasText: "Dis bonjour" }).waitFor();

    // The project takes another name in place, for every window.
    await page.getByRole("button", { name: "Actions du projet" }).click();
    await page.getByRole("menuitem", { name: "Renommer" }).waitFor();
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p3-menu-projet");
    await page.getByRole("menuitem", { name: "Renommer" }).click();
    await page.getByLabel("Nom du projet").fill("equipe bis");
    await page.getByLabel("Nom du projet").press("Enter");
    await page.getByRole("heading", { name: "equipe bis" }).waitFor();
    await page.getByRole("button", { name: "Actions du projet" }).click();
    await page.getByRole("menuitem", { name: "Renommer" }).click();
    await page.getByLabel("Nom du projet").fill("equipe");
    await page.getByLabel("Nom du projet").press("Enter");
    await page.getByRole("heading", { name: "equipe", exact: true }).waitFor();

    // Pinned from its menu, the project says so in the list, for every window.
    await page.getByRole("button", { name: "Actions du projet" }).click();
    await page.getByRole("menuitem", { name: "Épingler" }).click();
    await inSidebar.getByLabel("Épinglé").waitFor();
    await page.getByRole("button", { name: "Actions du projet" }).click();
    await page.getByRole("menuitem", { name: "Désépingler" }).waitFor();
    await page.keyboard.press("Escape");

    // The coordinator: one agent to talk to about the whole project. Its agent calls
    // MoonAgentic's own tools, here to open a thread on a branch of its own.
    await page.getByLabel("Agent du coordinateur").selectOption({ label: "Agent de démo" });
    await page.getByRole("button", { name: "Activer le coordinateur" }).click();
    // Its conversation takes the page, the threads beside it.
    await page.locator(".pp-panel").waitFor();
    // Before anything is asked: ways to start, and a panel that says what will come there.
    await page.locator(".pp-hello").getByRole("button", { name: "Établir un plan" }).waitFor();
    // What the coordinator works with, as the server has it.
    await page.getByRole("tab", { name: "Contexte" }).click();
    const context = page.locator(".pp-ctx");
    await context.getByText("Tout va à l'agent du coordinateur.").waitFor();
    expect(await context.getByText("Agent de démo").count()).toBe(1);
    expect(await page.locator(".pp-panel .pp-row").count()).toBe(0);
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p13-contexte");
    await page.getByRole("tab", { name: "Fils de discussion" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await composer(page).fill("/ouvre Export Safari");
    await composer(page).press("Enter");
    const card = page.locator(".opened-line", { hasText: "Export Safari" });
    await card.waitFor();
    await page.getByText("J'ai ouvert le fil « Export Safari ».").waitFor();
    // The threads stay beside the conversation, the new one among them with its real state.
    const beside = page.locator(".pp-panel .pp-row", { hasText: "Export Safari" });
    await beside.waitFor();
    await expect.poll(() => card.locator(".oc-state").textContent()).toBe("Attend ta réponse.");
    // Beside the coordinator a line is a title and what goes on: the rest is in the thread.
    expect(await beside.locator(".pp-agent").isVisible()).toBe(false);
    // What the new thread waits for is asked above the coordinator's composer, to the user.
    const ask = page.locator(".pp-ask", { hasText: "Export Safari" });
    await ask.waitFor();
    expect(await ask.getByRole("button").count()).toBeGreaterThan(1);
    // The coordinator is no thread of the lists: not in the sidebar, not among the project's.
    expect(await page.locator(".side .thr", { hasText: "Coordinateur" }).count()).toBe(0);
    expect(await page.locator(".pp-row", { hasText: "Coordinateur" }).count()).toBe(0);
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p5-coordinateur");
    // The thread opens beside the coordinator: both conversations in sight, each its composer.
    await card.click();
    const pane = page.locator(".pp-thread");
    await pane.getByText("Corrige : Export Safari").first().waitFor();
    await card.waitFor();
    expect(new URL(page.url()).pathname).toMatch(/^\/p\/[^/]+\/f\/[^/]+$/);
    await pane.getByPlaceholder("Oriente ce fil de discussion…").waitFor();
    expect(await composer(page).count()).toBe(2);
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p10-fil-a-cote");
    // On a phone it takes the screen, the way back to the project above it.
    await page.setViewportSize({ width: 390, height: 780 });
    await expect.poll(() => composer(page).count()).toBe(1);
    await pane.getByText("Corrige : Export Safari").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p11-fil-mobile");
    await page.setViewportSize({ width: 1280, height: 820 });
    // The address keeps it: a reload comes back to the same two conversations.
    await page.reload();
    await pane.getByText("Corrige : Export Safari").first().waitFor();
    await card.waitFor();
    await pane.getByRole("button", { name: "Fils de discussion" }).click();
    await beside.waitFor();
    expect(await pane.count()).toBe(0);
    // From the list too, a thread opens beside the coordinator.
    await beside.locator(".pp-open, button").first().click();
    await pane.waitFor();
    // Once the thread has finished, its own words come back to the coordinator's conversation.
    expect(await page.locator(".result").count()).toBe(0);
    await pane.getByRole("button", { name: "Autoriser" }).click();
    const result = page.locator(".pp-main .result");
    await result.waitFor();
    await page.locator(".pp-main .new-sep").waitFor();
    expect(await result.locator(".result-s").textContent()).toContain("C'est fait");
    await expect.poll(() => card.locator(".oc-state").textContent()).toBe("Inactif");
    if (shots) await page.waitForTimeout(300);
    await shot(page, "p12-resultat");
    await pane.getByRole("button", { name: "Fils de discussion" }).click();

    // On a phone, the conversation and the threads take turns; nothing spills past the screen.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("tab", { name: "Fils" }).click();
    await page.locator(".pp-row", { hasText: "Export Safari" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    // The coordinator's composer goes with its conversation: nothing is sent out of sight.
    expect(await composer(page).count()).toBe(0);
    if (shots) await page.waitForTimeout(400);
    await shot(page, "p6-mobile-fils");
    await page.getByRole("tab", { name: "Coordinateur" }).click();
    await card.waitFor();
    await composer(page).waitFor();
    // The quick search lists threads, never the coordinator as one of them.
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByText("Export Safari").first().waitFor();
    expect(
      await page
        .getByRole("dialog")
        .getByText(/^Coordinateur · /)
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    if (shots) await page.waitForTimeout(400);
    await shot(page, "p4-mobile");

    // In the settings, each kind of work is sent to an agent and a model in one pick; the
    // server keeps the choice. Without favorites, every model is offered.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.evaluate(() => {
      history.pushState(null, "", "/reglages/coordinator");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    const bug = page.getByLabel("Modèle pour Bug");
    expect(await page.getByRole("button", { name: "Afficher tous les modèles" }).count()).toBe(0);
    await bug.selectOption("demo\nprecis");
    await page.reload();
    await expect.poll(() => bug.inputValue()).toBe("demo\nprecis");
    expect(await page.getByLabel("Modèle pour Tests").inputValue()).toBe("");
    await shot(page, "p8-reglages-coordinateur");
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

  it("stacks tray popups above the composer, updates effort per model, and renders agent logos", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url);
    await page.locator(".tray .tb").first().waitFor();

    // Open the project menu from the sunken tray and verify its top items paint above `.composer`.
    await page.locator(".tray .tb").first().click();
    const projectMenu = page.getByRole("menu", { name: "Projet" });
    await projectMenu.waitFor();
    const projectHit = await projectMenu.evaluate((menu) => {
      const target = menu.querySelector(".menu-h") ?? menu.querySelector("button");
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!top && menu.contains(top);
    });
    expect(projectHit).toBe(true);
    await shot(page, "c21-tray-projet");

    // Pick the git repo `equipe`, then check the branch popup from the tray stacks above `.composer` too.
    await projectMenu.getByRole("menuitemradio", { name: /equipe/ }).click();
    await page
      .locator(".tray")
      .getByRole("button", { name: /branche à part|dans ton dossier/ })
      .click();
    const branchMenu = page.getByRole("menu", { name: "Branche" });
    await branchMenu.waitFor();
    const branchHit = await branchMenu.evaluate((menu) => {
      const target = menu.querySelector(".menu-h") ?? menu.querySelector("button");
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!top && menu.contains(top);
    });
    expect(branchHit).toBe(true);
    await page.keyboard.press("Escape");

    // Built-in agents render their official logos in Options, and demo models switch effort stops cleanly.
    await pickAgent(page, /Agent de démo/);
    const logos = await page.locator(".mp-agent .ag.logo img").evaluateAll((imgs) =>
      imgs.map((img) => ({
        agent: img.closest(".ag")?.getAttribute("data-agent"),
        src: img.getAttribute("src"),
      })),
    );
    expect(logos).toEqual(
      expect.arrayContaining([
        { agent: "claude", src: "/agents/claude.svg" },
        { agent: "codex", src: "/agents/codex.svg" },
        { agent: "antigravity", src: "/agents/antigravity.svg" },
        { agent: "cursor", src: "/agents/cursor.svg" },
        { agent: "hermes", src: "/agents/hermes.png" },
      ]),
    );
    await shot(page, "c22-agent-logos");

    // Back to « Tous » to pick Démo rapide (3 effort stops: max index 2), then Démo précis (4 stops: max index 3).
    const demoSection = page
      .locator(".al")
      .filter({ has: page.locator(".al-h", { hasText: /Agent de démo/ }) })
      .first();
    await page.getByRole("button", { name: "Retour" }).click();
    await demoSection.getByRole("menuitemradio", { name: /Démo rapide/ }).click();
    await page.locator(".agentchip").click();
    await expect
      .poll(() => page.getByRole("slider", { name: /Effort/ }).getAttribute("aria-valuemax"))
      .toBe("2");

    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await demoSection.getByRole("menuitemradio", { name: /Démo précis/ }).click();
    await page.locator(".agentchip").click();
    await expect
      .poll(() => page.getByRole("slider", { name: /Effort/ }).getAttribute("aria-valuemax"))
      .toBe("3");
    await page.close();
  });
});
