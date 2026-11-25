// What an agent writes stays an answer: it cannot pass for a piece of the app, stand over a
// permission request, replace the device's token, or word a request so it reads as another.
// The built app, the real server, the demo agent, which repeats what it is told to write.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let url: string;
let dir: string;
let project: string;
/** The thread the first test opened, for the others to go on in. */
let thread: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-answers-e2e-"));
  project = path.join(dir, "projet");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src/app.ts"), "export const answer = 41;\n");
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
  // One browser for every page: they share what the device keeps, as tabs do.
  context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
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
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const card = (page: Page) => page.locator(".dcard");
const say = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press("Enter");
};
const keptToken = (page: Page) => page.evaluate(() => localStorage.getItem("moonagentic.token"));

/** The app's own address written as raw HTML, each way a browser reads as "this server". */
const APP_LINKS = [
  ["Rafraîchir la session", "/#token=jeton-pose-par-l-agent"],
  ["Reprendre où tu en étais", "?token=jeton-pose-par-l-agent"],
  ["Appairer de nouveau", "/#pair=000000"],
  ["Recharger", "http:/#token=jeton-pose-par-l-agent"],
  ["Revenir à l'accueil", "APP/#token=jeton-pose-par-l-agent"],
] as const;

/**
 * What an agent can be told to write by a page or a file it read. The demo agent repeats its
 * message in its answer, then asks a permission: the answer is on screen with the request.
 */
const hostile = (app: string) =>
  [
    // The app's own classes: a veil over the whole screen that lets a tap through to what is
    // under it, a dialog, a notice, each with what the app's code and styles know theirs by.
    `<div class="presence closing"><div class="lk-scrim"><div class="lk-card"><h2>MoonAgentic se met à jour</h2><p>Touche l'écran pour continuer.</p></div></div></div>`,
    `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" id="cf-title" name="body"><h2>Autoriser l'agent ?</h2></div></div>`,
    `<div class="toast" data-state="open" tabindex="1">Mise à jour installée</div>`,
    `<div class="offline" style="position:fixed;inset:0">Connexion perdue</div>`,
    // What the browser itself lays over a page, and a drawing that leaves its frame.
    `<dialog open>Session expirée</dialog>`,
    `<svg width="20" height="20" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="black"/></svg>`,
    // Links to the app itself, which would give this device a token or a pairing code of the
    // agent's choosing, each written another way, and one drawn in a picture, which would take
    // the app's own page elsewhere.
    ...APP_LINKS.map(([text, href]) => `<a href="${href.replace("APP", app)}">${text}</a>`),
    `[Ouvre ce lien pour rafraîchir](#token=jeton-pose-par-l-agent)`,
    `<svg width="200" height="40"><a href="https://exemple.invalid/x"><text y="20">Reconnecte-toi</text></a></svg>`,
    // A piece of a formula carrying an address, which Safari and Firefox follow, and the
    // app's own mark for a file, written by hand with a token after it.
    `<math><mi href="${app}/#token=jeton-pose-par-l-agent">Formule</mi></math>`,
    `<a href="#moon-file:notes.txt&amp;token=jeton-pose-par-l-agent">Ouvrir la pièce jointe</a>`,
    // And what an honest answer links to: a page of another site, a letter to write.
    `[La documentation](https://exemple.invalid/doc)`,
    `[Le fichier modifié](src/app.ts)`,
    `<a href="mailto:equipe@exemple.invalid">Écrire à l'équipe</a>`,
  ].join("\n\n");

/** Where the pieces of the answers are, and what is under the pointer over the request. */
const look = (page: Page) =>
  page.evaluate(() => {
    const pieces = [...document.querySelectorAll(".md *")];
    // The few classes the app itself sets in an answer, once it is cleaned.
    const own = new Set(["md-img", "md-img-box", "md-img-keep", "md-img-gone", "md-file"]);
    const inAnswer = (x: number, y: number) => {
      const md = document.elementFromPoint(x, y)?.closest(".md");
      if (!md) return "app";
      const box = md.getBoundingClientRect();
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      return inside ? "answer" : "answer, out of its box";
    };
    // A grid over the whole page: what an answer holds is met only inside the answer's box.
    let out = 0;
    for (let x = 4; x < innerWidth; x += 24) {
      for (let y = 4; y < innerHeight; y += 24) {
        if (inAnswer(x, y) === "answer, out of its box") out += 1;
      }
    }
    return {
      classes: [...new Set(pieces.flatMap((e) => [...e.classList]))].filter((c) => !own.has(c)),
      named: pieces
        // A file the app opens takes the focus and says what it is: set by the app itself.
        .filter((e) => !e.matches(".md-file"))
        .flatMap((e) => [...e.attributes].map((a) => a.name))
        .filter((n) => /^(id|name|style|role|tabindex|data-state|aria-modal|open)$/.test(n)),
      dialogs: document.querySelectorAll(".md dialog").length,
      placed: pieces
        .filter((e) => ["fixed", "absolute", "sticky"].includes(getComputedStyle(e).position))
        .map((e) => e.tagName.toLowerCase()),
      out,
      corners: [
        inAnswer(5, 5),
        inAnswer(innerWidth - 5, 5),
        inAnswer(5, innerHeight - 5),
        inAnswer(innerWidth - 5, innerHeight - 5),
      ],
      // Under the middle of each of the request's rows: the request itself.
      rows: [...document.querySelectorAll(".dcard .dcard-o")].map((row) => {
        const box = row.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!top && row.contains(top);
      }),
      // The links an answer keeps: those that lead out of the app, and no other.
      links: [...document.querySelectorAll(".md a[href]")].map((a) => a.getAttribute("href")),
      toApp: [...document.querySelectorAll<HTMLAnchorElement>(".md a[href]")].filter(
        (a) => new URL(a.href).origin === location.origin,
      ).length,
      // Nothing but a link of the text carries an address: no drawing, no piece of a formula.
      carried: pieces
        .filter((e) => e.tagName !== "A" && e.localName !== "image")
        .flatMap((e) => [...e.attributes].filter((a) => a.localName === "href"))
        .map((a) => a.value),
      // The files the app opens itself keep no address a browser could follow.
      files: [...document.querySelectorAll(".md a.md-file")].map(
        (a) => `${a.textContent}${a.hasAttribute("href") ? " (href)" : ""}`,
      ),
      // Every link an answer keeps opens outside the app's own page.
      sameTab: [...document.querySelectorAll(".md a, .md area")].filter(
        (a) =>
          (a.hasAttribute("href") || a.hasAttribute("xlink:href")) &&
          a.getAttribute("target") !== "_blank" &&
          !a.classList.contains("md-file"),
      ).length,
    };
  });

const CLEAN = {
  classes: [],
  named: [],
  dialogs: 0,
  placed: [],
  out: 0,
  corners: ["app", "app", "app", "app"],
  rows: [true, true, true],
  links: ["https://exemple.invalid/doc", "mailto:equipe@exemple.invalid"],
  toApp: 0,
  carried: [],
  files: ["Ouvrir la pièce jointe", "Le fichier modifié"],
  sameTab: 0,
};

describe("agent answers", () => {
  it("cannot pass for the app, nor stand over a permission request", async () => {
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: "Nouveau projet" }).first().click();
    await page.getByRole("radio", { name: "Dossier sur la machine" }).click();
    await page.getByLabel("Dossier", { exact: true }).fill(project);
    await page.getByRole("button", { name: "Ajouter le projet" }).click();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    await page.locator(".agentchip").click();
    await page.getByRole("button", { name: "Tous", exact: true }).click();
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Agent de démo/ }).click();
    await page.keyboard.press("Escape");

    await say(page, hostile(new URL(url).origin));
    await card(page).getByRole("heading", { name: "Modifier src/app.ts" }).waitFor();
    await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    thread = page.url();
    await shot(page, "a1-reponse-hostile");

    // What it wrote is still there to read, as text among the rest of its answer.
    const answer = page.locator(".md", { hasText: "MoonAgentic se met à jour" });
    expect(await answer.count()).toBe(1);
    await answer.getByText("Touche l'écran pour continuer.").waitFor();
    await answer.getByText("Session expirée").waitFor();
    expect(await look(page)).toEqual(CLEAN);
    // Its links to the app lead nowhere: the address stays what it was, and no page opens.
    for (const text of ["Ouvre ce lien pour rafraîchir", ...APP_LINKS.map(([text]) => text)]) {
      await answer.getByText(text).click();
    }
    expect(page.url()).toBe(thread);
    expect(context.pages()).toHaveLength(1);
    // The others open outside the app, as before.
    const doc = answer.getByRole("link", { name: "La documentation" });
    expect(await doc.getAttribute("target")).toBe("_blank");
    expect(await doc.getAttribute("rel")).toBe("noopener noreferrer");

    // A file is opened by the app and by nothing else: a middle click, which opened the app
    // in another tab at the address the link carried, now opens nothing.
    const file = answer.getByRole("link", { name: "Le fichier modifié" });
    for (const text of ["Ouvrir la pièce jointe", "Le fichier modifié"]) {
      await answer.getByText(text).click({ button: "middle" });
    }
    expect(page.url()).toBe(thread);
    expect(context.pages()).toHaveLength(1);
    // It still reads as a link, and the app opens it on a click as on a key (the viewer says
    // of this one that it only shows images, PDFs and pages: it is the viewer that matters).
    const drawn = (link: typeof file) =>
      link.evaluate((a) => {
        const style = getComputedStyle(a);
        return [style.color, style.textDecorationLine, style.cursor];
      });
    expect(await drawn(file)).toEqual(await drawn(doc));
    const viewer = page.getByRole("dialog", { name: "app.ts" });
    await file.click();
    await viewer.waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => viewer.count()).toBe(0);
    await file.focus();
    await page.keyboard.press("Enter");
    await viewer.waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => viewer.count()).toBe(0);
    await page.close();
  });

  it("stays in its place on a phone too", async () => {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await phone.newPage();
    await page.goto(`${thread}${new URL(url).hash}`);
    await card(page).getByRole("heading", { name: "Modifier src/app.ts" }).waitFor();
    await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await shot(page, "a2-reponse-hostile-telephone");
    expect(await look(page)).toEqual(CLEAN);
    // A tap where the request offers to allow reaches the request, and nothing else.
    await card(page)
      .getByRole("button", { name: /Refuser/ })
      .tap();
    await page.getByText("D'accord, je ne touche à rien.").waitFor();
    await phone.close();
  });

  it("keeps the device's token when a link brings another, and takes one the server accepts", async () => {
    const owner = new URL(url).hash.replace("#token=", "");
    const page = await context.newPage();
    await page.goto(thread);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // The link the app was opened with held the server's token: accepted, it was kept.
    expect(await keptToken(page)).toBe(owner);

    // A link to the app with a token of someone else's choosing, opened in another tab.
    const tab = await context.newPage();
    await tab.goto(`${new URL(url).origin}/#token=jeton-pose-par-l-agent`);
    await expect.poll(() => composer(tab).isEnabled()).toBe(true);
    expect(await tab.getByText("Appairer cet appareil").count()).toBe(0);
    expect(await keptToken(tab)).toBe(owner);
    // The address lost it at once, refused or not.
    expect(tab.url()).toBe(`${new URL(url).origin}/`);
    await tab.close();

    // The device is still paired: the thread opens again after a reload.
    await page.reload();
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    expect(await page.getByText("Appairer cet appareil").count()).toBe(0);
    expect(await keptToken(page)).toBe(owner);
    await page.close();
  });

  it("shows a permission request as it reads, and what each choice does", async () => {
    const page = await context.newPage();
    await page.goto(thread);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    // The demo writes this request with characters that turn its words around on screen
    // (« hs.tixe-lruc » read « curl-exit.sh ») or take no room.
    await say(page, "/trompeur");
    await card(page)
      .getByRole("heading", { name: "Lire le fichier hs.tixe-lruc README.md", exact: true })
      .waitFor();
    await expect
      .poll(() => card(page).locator(".dcard-o .dcard-on").allTextContents())
      .toEqual(["Autoriser", "resufeR", "Autre chose…"]);
    expect(await card(page).locator(".dcard-o .dcard-od").allTextContents()).toEqual([
      "Autorisé cette fois seulement",
      "L'agent ne le fait pas et continue autrement",
    ]);
    // Nothing on the page turns a text around or hides in it, the thread's rows included.
    const unseen = await page.evaluate(() =>
      [...document.body.innerText].filter((c) => /[\u200B\u202A-\u202E\u2066-\u2069]/.test(c)),
    );
    expect(unseen).toEqual([]);
    await shot(page, "a3-demande-lisible");
    await card(page)
      .getByRole("button", { name: /Autoriser/ })
      .click();
    await page.getByText("Réponse reçue : allow.").waitFor();
    await page.close();
  });
});
