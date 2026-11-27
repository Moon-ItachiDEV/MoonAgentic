// The phone's keyboard, followed (apps/web/src/v2/keyboard.ts): the built app, the real server,
// on a touch screen the size of an iPhone. The keyboard itself is played: the window keeps its
// height and what is seen of it shrinks, which is all a page ever learns of a real one.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { addProject, pickAgent, setAccess } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Set to a folder to keep screenshots of each step there. */
const shots = process.env.E2E_SHOTS;

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-keyboard-e2e-"));
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

const PHONE = { width: 393, height: 852 };
/** An iPhone's keyboard with the bar above it, and the room the composer keeps over it. */
const KEYBOARD = 336;
const GAP = 8;
const STORED = "moonagentic.keyboard.p";

/** Where the composer's end is, at a picture drawn at `t` (ms). */
interface Frame {
  t: number;
  bottom: number;
}

/** What the page is given to play a keyboard with, and to film itself. */
interface Played {
  keyboard(height: number, top?: number): void;
  film(): void;
  cut(): Frame[];
}
/** The page, with them. */
type Stage = Window & { played: Played };

/** In the page, before the app: a keyboard to show and hide, and a camera. */
function play() {
  let shown: { height: number; top: number } | null = null;
  const vv = window.visualViewport!;
  const real = (name: "height" | "offsetTop") =>
    Object.getOwnPropertyDescriptor(VisualViewport.prototype, name)!.get!;
  const height = real("height");
  const offsetTop = real("offsetTop");
  Object.defineProperty(vv, "height", {
    get: () => (shown ? innerHeight - shown.height : height.call(vv)),
  });
  Object.defineProperty(vv, "offsetTop", {
    get: () => (shown ? shown.top : offsetTop.call(vv)),
  });
  let frames: Frame[] | null = null;
  // Read when the picture is laid out, after everything that prepares it and just before it is
  // drawn: what the eye gets. An observer of sizes is told at that very moment, so a mark
  // changes size at each picture.
  const mark = document.createElement("div");
  mark.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden";
  new ResizeObserver(() => {
    const composer = document.querySelector("#bottom .cmp");
    if (frames && composer)
      frames.push({
        t: Number(document.timeline.currentTime),
        bottom: composer.getBoundingClientRect().bottom,
      });
  }).observe(mark);
  const tick = () => {
    if (frames) {
      if (!mark.isConnected) document.body.append(mark);
      mark.style.width = mark.style.width === "1px" ? "2px" : "1px";
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const tools: Played = {
    keyboard(tall, top = 0) {
      shown = tall ? { height: tall, top } : null;
      vv.dispatchEvent(new Event("resize"));
    },
    film() {
      frames = [];
    },
    cut() {
      const out = frames ?? [];
      frames = null;
      return out;
    },
  };
  (window as unknown as Stage).played = tools;
}

/** An iPhone: touched, its keyboard on the screen. */
async function phone(
  options: { reducedMotion?: "reduce" } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: shots ? 3 : 1,
    ...options,
  });
  await context.addInitScript(play);
  const page = await context.newPage();
  // Once to pair the device, then each page by its address.
  await page.goto(url);
  await page.locator(".scr").waitFor();
  await composer(page).waitFor();
  await atRest(page);
  return { context, page };
}

const composer = (page: Page) => page.getByRole("combobox", { name: "Message" });
const keyboard = (page: Page, height: number, top = 0) =>
  page.evaluate(([h, t]) => (window as unknown as Stage).played.keyboard(h!, t), [height, top]);
const film = (page: Page) => page.evaluate(() => (window as unknown as Stage).played.film());
const cut = (page: Page) => page.evaluate(() => (window as unknown as Stage).played.cut());
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/** Nothing of what the keyboard moves is moving any more. */
const atRest = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll("#top, #gstack, #bottom, #bottom .cmp, .tabbar button"),
        ].every((el) => el.getAnimations().length === 0),
      ),
    )
    .toBe(true);

/** The page as it is drawn. */
const look = (page: Page) =>
  page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : undefined;
    };
    const bar = document.querySelector<HTMLElement>(".tabbar");
    const tab = bar?.querySelector("button");
    return {
      keyboard: document.documentElement.dataset.kb !== undefined,
      shell: box(".scr"),
      top: box("#top"),
      greeting: box("#gstack"),
      composer: box("#bottom .cmp"),
      /** The composer is one line: folded. */
      folded: !document.querySelector("#bottom .cmp.open"),
      tabs:
        bar && tab ? { seen: Number(getComputedStyle(tab).opacity), reached: !bar.inert } : null,
    };
  });

describe("the phone's keyboard", () => {
  it("rests the composer on the keyboard and puts the tabs away, then gives the page back", async () => {
    const { context, page } = await phone();
    const before = await look(page);
    expect(before.tabs).toEqual({ seen: 1, reached: true });
    expect(before.folded).toBe(true);
    await shot(page, "clavier-1-repos");

    // Nothing is known of this phone's keyboard yet: the page waits to see it.
    await composer(page).tap();
    expect((await look(page)).keyboard).toBe(false);
    await keyboard(page, KEYBOARD);
    await atRest(page);
    const up = await look(page);
    expect(up.keyboard).toBe(true);
    expect(up.composer!.bottom).toBe(PHONE.height - KEYBOARD - GAP);
    // The top bar has not moved, and the greeting is whole between it and the composer.
    expect(up.top).toEqual(before.top);
    expect(up.greeting!.top).toBeGreaterThan(up.top!.bottom);
    expect(up.greeting!.bottom).toBeLessThan(up.composer!.top);
    // The tabs stepped aside: not seen, not reached.
    expect(up.tabs).toEqual({ seen: 0, reached: false });
    await shot(page, "clavier-2-ouvert");

    // Put away: the focus goes first, the window follows. The composer folds with the keyboard.
    await composer(page).blur();
    expect((await look(page)).folded).toBe(true);
    await keyboard(page, 0);
    await atRest(page);
    const after = await look(page);
    expect(after).toEqual({ ...before, greeting: after.greeting });
    expect(await page.evaluate((key) => localStorage.getItem(key), STORED)).toBe(String(KEYBOARD));
    await shot(page, "clavier-3-referme");
    await context.close();
  });

  it("moves the page at the touch once the keyboard's height is known", async () => {
    const { context, page } = await phone();
    await composer(page).tap();
    await keyboard(page, KEYBOARD);
    await atRest(page);
    await composer(page).blur();
    await keyboard(page, 0);
    await atRest(page);

    // What the system sees when the field takes the focus: it pushes the page up only if the
    // field is then under where the keyboard will be.
    await page.evaluate(() => {
      document.addEventListener(
        "focus",
        (e) => {
          (window as unknown as { atFocus: object }).atFocus = {
            keyboard: document.documentElement.dataset.kb !== undefined,
            field: (e.target as HTMLElement).getBoundingClientRect().bottom,
          };
        },
        { capture: true, once: true },
      );
    });
    await composer(page).tap();
    const atFocus = await page.evaluate(
      () => (window as unknown as { atFocus: { keyboard: boolean; field: number } }).atFocus,
    );
    expect(atFocus.keyboard).toBe(true);
    expect(atFocus.field).toBeLessThanOrEqual(PHONE.height - KEYBOARD - GAP);
    expect((await look(page)).tabs!.reached).toBe(false);

    // The keyboard then shows where it was expected: the page is there already.
    await atRest(page);
    const waiting = await look(page);
    await keyboard(page, KEYBOARD);
    await atRest(page);
    expect(await look(page)).toEqual(waiting);
    expect(waiting.composer!.bottom).toBe(PHONE.height - KEYBOARD - GAP);
    await context.close();
  });

  it("goes back from where it is when the keyboard is put away half way", async () => {
    const { context, page } = await phone();
    await composer(page).tap();
    await keyboard(page, KEYBOARD);
    await atRest(page);
    await composer(page).blur();
    await keyboard(page, 0);
    await atRest(page);
    const before = await look(page);

    await film(page);
    await composer(page).tap();
    await page.waitForTimeout(150);
    await composer(page).blur();
    await atRest(page);
    const frames = await cut(page);
    expect(frames.length).toBeGreaterThan(10);
    // Nothing jumps: from one picture to the next, the composer goes no faster than a spring
    // does (1.4 px/ms at most here). A jump is the whole way in one picture: 15 px/ms.
    let fastest = 0;
    for (let i = 1; i < frames.length; i++) {
      const dt = frames[i]!.t - frames[i - 1]!.t;
      if (dt >= 8)
        fastest = Math.max(fastest, Math.abs(frames[i]!.bottom - frames[i - 1]!.bottom) / dt);
    }
    expect(fastest).toBeLessThan(3);
    // It stays between its two places: no spring of the page passes its target.
    const bottoms = frames.map((f) => f.bottom);
    expect(Math.min(...bottoms)).toBeGreaterThan(PHONE.height - KEYBOARD - GAP - 1);
    expect(Math.max(...bottoms)).toBeLessThan(before.composer!.bottom + 1);
    const after = await look(page);
    expect(after).toEqual({ ...before, greeting: after.greeting });
    await context.close();
  });

  it("forgets a keyboard that never shows", async () => {
    const { context, page } = await phone();
    await page.evaluate(
      ([key, tall]) => localStorage.setItem(key!, tall!),
      [STORED, String(KEYBOARD)],
    );
    const before = await look(page);
    // A keyboard is plugged in: the page moved at the touch, and nothing came.
    await composer(page).tap();
    expect((await look(page)).keyboard).toBe(true);
    await expect.poll(async () => (await look(page)).keyboard).toBe(false);
    await atRest(page);
    const after = await look(page);
    expect(after.tabs).toEqual(before.tabs);
    expect(after.composer!.bottom).toBe(before.composer!.bottom);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message",
    );
    // The next touch moves nothing ahead.
    expect(await page.evaluate((key) => localStorage.getItem(key), STORED)).toBeNull();
    await composer(page).blur();
    await atRest(page);
    await composer(page).tap();
    expect((await look(page)).keyboard).toBe(false);
    await context.close();
  });

  it("stays in sight when the system pushed the page up, and comes back down with it", async () => {
    const { context, page } = await phone();
    const before = await look(page);
    // As recorded on an iPhone: a keyboard of 386 px, the page pushed 430 px up.
    await composer(page).tap();
    await keyboard(page, 386, 430);
    await atRest(page);
    const up = await look(page);
    // The page fills what is seen: from the top of it down to the keyboard.
    expect(up.shell).toEqual({ top: 430, bottom: 430 + PHONE.height - 386 });
    expect(up.top!.top).toBe(430);
    expect(up.composer!.bottom).toBe(up.shell!.bottom - GAP);
    expect(up.tabs).toEqual({ seen: 0, reached: false });
    // The keyboard goes: the page's top stays where the system holds it until it lets go.
    await composer(page).blur();
    expect((await look(page)).shell!.top).toBe(430);
    await keyboard(page, 0);
    await atRest(page);
    const after = await look(page);
    expect(after).toEqual({ ...before, greeting: after.greeting });
    await context.close();
  });

  it("keeps a thread's last lines above the composer", async () => {
    // From a computer: a thread long enough to be scrolled.
    const project = path.join(dir, "projet");
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "src/app.ts"), "export const answer = 41;\n");
    const desk = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await desk.goto(url);
    await addProject(desk, project);
    await pickAgent(desk);
    await setAccess(desk, /Accès complet/);
    await composer(desk).fill(Array.from({ length: 40 }, (_, i) => `Ligne ${i + 1}`).join("\n"));
    await composer(desk).press("Enter");
    await desk.waitForURL((u) => u.pathname.startsWith("/t/"));
    const thread = new URL(desk.url()).pathname;
    await desk.locator(".feed .item").nth(1).waitFor();
    await desk.close();

    const { context, page } = await phone();
    await page.goto(new URL(thread, url).href);
    await expect.poll(() => composer(page).isEnabled()).toBe(true);
    const last = page.locator(".feed .item").last();
    await last.waitFor();
    await atRest(page);
    /** The end of the thread's last line, and the top of the composer. */
    const ends = async () => ({
      line: Math.round((await last.boundingBox())!.y + (await last.boundingBox())!.height),
      composer: (await look(page)).composer!.top,
    });
    const before = await ends();
    expect(before.line).toBeLessThanOrEqual(before.composer);

    await composer(page).tap();
    await keyboard(page, KEYBOARD);
    await atRest(page);
    const up = await look(page);
    expect(up.composer!.bottom).toBe(PHONE.height - KEYBOARD - GAP);
    expect(up.top!.top).toBe(0);
    const raised = await ends();
    expect(raised.line).toBeLessThanOrEqual(raised.composer);
    // The reader was at the end of the thread: they still are, as close to the composer.
    expect(Math.abs(raised.composer - raised.line - (before.composer - before.line))).toBeLessThan(
      3,
    );
    await shot(page, "clavier-4-fil");

    await composer(page).blur();
    await keyboard(page, 0);
    await atRest(page);
    const after = await ends();
    expect(after.line).toBeLessThanOrEqual(after.composer);
    await context.close();
  });

  it("changes at once for who asked for less motion", async () => {
    const { context, page } = await phone({ reducedMotion: "reduce" });
    await composer(page).tap();
    await keyboard(page, KEYBOARD);
    // The next picture is the last: nothing travels.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    const up = await look(page);
    expect(up.composer!.bottom).toBe(PHONE.height - KEYBOARD - GAP);
    expect(up.tabs).toEqual({ seen: 0, reached: false });
    expect(
      await page.evaluate(() =>
        [
          ...document.querySelectorAll("#top, #gstack, #bottom, #bottom .cmp, .tabbar button"),
        ].every((el) => el.getAnimations().length === 0),
      ),
    ).toBe(true);
    await context.close();
  });
});
