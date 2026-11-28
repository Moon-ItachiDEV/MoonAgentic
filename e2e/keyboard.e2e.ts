// The phone's keyboard, followed (apps/web/src/v2/keyboard.ts): the built app, the real server,
// on a touch screen the size of an iPhone. The keyboard itself is played, the two ways a page
// learns of a real one: what is seen of the window shrinks, and the window's own height either
// stays (an iPhone until iOS 18, Android) or shrinks with it (an iPhone since iOS 26).
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

/**
 * What a phone's window says of its own height while its keyboard is up. An iPhone on iOS 26
 * shrinks it with what is seen: a page that measured the keyboard against it found none, and
 * nothing followed (the tabs stayed, the composer was left where the system pushed it).
 */
const WINDOWS = [
  { says: "keeps its height", shrinks: false },
  { says: "shrinks with the keyboard", shrinks: true },
];
/** The one being played. */
let windowShrinks = false;

const PHONE = { width: 393, height: 852 };
/** An iPhone's keyboard with the bar above it, and the room the composer keeps over it. */
const KEYBOARD = 336;
const GAP = 8;
const STORED = "moonagentic.keyboard.p";

/** The composer at a picture drawn at `t` (ms). */
interface Frame {
  t: number;
  /** Where its end is, down the window. */
  bottom: number;
  height: number;
  /** Its text: how far above the composer's end it starts, and how far from its left edge. */
  up: number;
  left: number;
}

/** What the page is given to play a keyboard with, and to film itself. */
interface Played {
  keyboard(height: number, top?: number): void;
  film(): void;
  cut(): Frame[];
}
/** The page, with them. */
type Stage = Window & { played: Played };

/**
 * In the page, before the app: a keyboard to show and hide, and a camera. With `shrinks`, the
 * window says it is no taller than what is seen of it while the keyboard is up.
 */
function play(shrinks: boolean) {
  let shown: { height: number; top: number } | null = null;
  const vv = window.visualViewport!;
  const real = (name: "height" | "offsetTop") =>
    Object.getOwnPropertyDescriptor(VisualViewport.prototype, name)!.get!;
  const height = real("height");
  const offsetTop = real("offsetTop");
  const whole = Object.getOwnPropertyDescriptor(window, "innerHeight")!.get!;
  Object.defineProperty(vv, "height", {
    get: () => (shown ? whole.call(window) - shown.height : height.call(vv)),
  });
  if (shrinks) {
    Object.defineProperty(window, "innerHeight", {
      get: () => whole.call(window) - (shown ? shown.height : 0),
    });
  }
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
    const text = composer?.querySelector("textarea");
    if (!frames || !composer || !text) return;
    const box = composer.getBoundingClientRect();
    const at = text.getBoundingClientRect();
    frames.push({
      t: Number(document.timeline.currentTime),
      bottom: box.bottom,
      height: box.height,
      up: box.bottom - at.top,
      left: at.left - box.left,
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
  await context.addInitScript(play, windowShrinks);
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

/** Nothing of what the keyboard moves is moving any more, and the composer has its shape. */
const atRest = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          !document.querySelector(".cmp[data-morph]") &&
          [
            ...document.querySelectorAll("#top, #gstack, #bottom, #bottom .cmp, .tabbar button"),
          ].every((el) => el.getAnimations().length === 0),
      ),
    )
    .toBe(true);

/** The fastest one of these goes from one picture to the next, in px per ms. */
function fastest(frames: Frame[], ...of: ((f: Frame) => number)[]): number {
  let most = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i]!.t - frames[i - 1]!.t;
    if (dt < 8) continue;
    for (const value of of)
      most = Math.max(most, Math.abs(value(frames[i]!) - value(frames[i - 1]!)) / dt);
  }
  return most;
}

/** A few pictures go by. */
const pictures = (page: Page, count: number) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((done) => requestAnimationFrame(done));
  }, count);

/** The composer as it is drawn, in a page the system shows from `top` down: a picture of it. */
async function picture(page: Page, top: number): Promise<string> {
  const clip = await page.evaluate((y) => {
    // What the eye gets: the window shows the page from there.
    document.documentElement.style.transform = `translateY(${-y}px)`;
    const r = document.querySelector("#bottom .cmp")!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, top);
  const png = await page.screenshot({ clip });
  await page.evaluate(() => document.documentElement.style.removeProperty("transform"));
  return png.toString("base64");
}

/** Whether the tabs' bar draws anything over the composer. */
async function tabsOverComposer(page: Page, top: number): Promise<boolean> {
  const show = (seen: boolean) =>
    page.evaluate((visible) => {
      const bar = document.querySelector<HTMLElement>(".tabbar")!;
      if (visible) bar.style.removeProperty("visibility");
      else bar.style.visibility = "hidden";
    }, seen);
  // The caret blinks: two pictures of it are not the same.
  const still = await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
  let over = false;
  for (let tries = 0; tries < 5; tries++) {
    const withTabs = await picture(page, top);
    await show(false);
    const alone = await picture(page, top);
    await show(true);
    over = withTabs !== alone;
    // Unless something else changed meanwhile (a button that came late): taken again then.
    if ((await picture(page, top)) === withTabs) break;
  }
  await still.evaluate((el) => (el as Element).remove());
  return over;
}

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
        bar && tab
          ? {
              seen: Number(getComputedStyle(tab).opacity),
              reached: !bar.inert,
              /** Their bar is drawn in front of the composer's dock. */
              front:
                Number(getComputedStyle(bar).zIndex) >
                Number(getComputedStyle(document.getElementById("bottom")!).zIndex),
            }
          : null,
    };
  });

describe.each(WINDOWS)("the phone's keyboard, in a window that $says", ({ shrinks }) => {
  beforeAll(() => {
    windowShrinks = shrinks;
  });

  it("rests the composer on the keyboard and puts the tabs away, then gives the page back", async () => {
    const { context, page } = await phone();
    const before = await look(page);
    expect(before.tabs).toEqual({ seen: 1, reached: true, front: true });
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
    expect(up.tabs).toEqual({ seen: 0, reached: false, front: false });
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
    expect(fastest(frames, (f) => f.bottom)).toBeLessThan(3);
    // Nor does its shape: the card's height and its text's place change by a spring too (0.25
    // px/ms at most), from where they are when the mind changes.
    expect(
      fastest(
        frames,
        (f) => f.height,
        (f) => f.up,
        (f) => f.left,
      ),
    ).toBeLessThan(1);
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

  it("moves nothing when the app gives the focus with no touch", async () => {
    const { context, page } = await phone();
    await page.evaluate(
      ([key, tall]) => localStorage.setItem(key!, tall!),
      [STORED, String(KEYBOARD)],
    );
    const before = await look(page);
    // No finger asked for it (a draft put back in the composer): a phone shows no keyboard
    // for such a focus, and says so.
    const touched = (active: boolean) =>
      page.evaluate((isActive) => {
        Object.defineProperty(navigator, "userActivation", {
          configurable: true,
          get: () => ({ isActive }),
        });
      }, active);
    await touched(false);
    await composer(page).focus();
    await atRest(page);
    const focused = await look(page);
    expect(focused.keyboard).toBe(false);
    expect(focused.tabs).toEqual(before.tabs);
    await page.waitForTimeout(300);
    expect((await look(page)).keyboard).toBe(false);
    // The keyboard's height is still known: a touch on the field, already in it, brings the
    // keyboard back and the page with it.
    expect(await page.evaluate((key) => localStorage.getItem(key), STORED)).toBe(String(KEYBOARD));
    await composer(page).tap();
    expect((await look(page)).keyboard).toBe(true);
    await keyboard(page, KEYBOARD);
    await atRest(page);
    expect((await look(page)).composer!.bottom).toBe(PHONE.height - KEYBOARD - GAP);
    await composer(page).blur();
    await keyboard(page, 0);
    await atRest(page);
    // In answer to a touch elsewhere (a model picked in its menu), the app gives the focus:
    // the keyboard comes, and the page is there before it.
    await touched(true);
    await composer(page).focus();
    expect((await look(page)).keyboard).toBe(true);
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
    // The composer then rests where the tabs' bar is: nothing of the bar is drawn over it.
    expect(await tabsOverComposer(page, 430)).toBe(false);
    expect(up.tabs).toEqual({ seen: 0, reached: false, front: false });
    // The keyboard goes: the page's top stays where the system holds it until it lets go.
    await composer(page).blur();
    const leaving = await look(page);
    expect(leaving.shell!.top).toBe(430);
    // On its way back the composer crosses the bar: it stays in front until all is in place.
    expect(leaving.keyboard).toBe(false);
    expect(leaving.tabs!.front).toBe(false);
    await keyboard(page, 0);
    await atRest(page);
    const after = await look(page);
    expect(after).toEqual({ ...before, greeting: after.greeting });
    await context.close();
  });

  it("finds the page where it is seen when the window does not say how far it was pushed", async () => {
    const { context, page } = await phone();
    const before = await look(page);
    await composer(page).tap();
    // On iOS 26 the window has been reported not to say how far the page was pushed, while
    // the page is found where it was pushed to: it is drawn 430 px up, and the window is silent.
    await page.evaluate(() => {
      document.documentElement.style.transform = "translateY(-430px)";
    });
    await keyboard(page, 386);
    await atRest(page);
    const up = await look(page);
    expect(up.keyboard).toBe(true);
    // As it is seen: the page fills the window from its top down to the keyboard.
    expect(up.shell).toEqual({ top: 0, bottom: PHONE.height - 386 });
    expect(up.top!.top).toBe(0);
    expect(up.composer!.bottom).toBe(PHONE.height - 386 - GAP);
    expect(up.tabs).toEqual({ seen: 0, reached: false, front: false });
    // The keyboard goes, the system lets the page down: all is back in place.
    await composer(page).blur();
    await page.evaluate(() => document.documentElement.style.removeProperty("transform"));
    await keyboard(page, 0);
    await atRest(page);
    const after = await look(page);
    expect(after).toEqual({ ...before, greeting: after.greeting });
    await context.close();
  });

  it("lets what is written grow while the composer changes shape", async () => {
    const { context, page } = await phone();
    await film(page);
    // Three lines are pasted while the line is still growing into the card.
    const changing = await page.evaluate(async (lines) => {
      const text = document.querySelector<HTMLTextAreaElement>("#bottom .cmp textarea")!;
      text.focus();
      for (let i = 0; i < 3; i++) await new Promise((done) => requestAnimationFrame(done));
      const shape = document.querySelector<HTMLElement>("#bottom .cmp")!.dataset.morph;
      // What a paste does: the field's value changes, and it says so.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        text,
        lines,
      );
      text.dispatchEvent(new Event("input", { bubbles: true }));
      return shape;
    }, "Une ligne\nDeux lignes\nTrois lignes");
    expect(changing).toBe("open");
    await atRest(page);
    const frames = await cut(page);
    expect(frames.length).toBeGreaterThan(10);
    // At no picture is the text cut by the composer's top edge: the card has room for all of it
    // as soon as it is there.
    expect(Math.max(...frames.map((f) => f.up - f.height))).toBeLessThanOrEqual(0.5);
    // And the card ends with its three lines, the text in its place.
    const end = frames.at(-1)!;
    const now = await page.evaluate(() => {
      const box = document.querySelector("#bottom .cmp")!.getBoundingClientRect();
      const at = document.querySelector("#bottom .cmp textarea")!.getBoundingClientRect();
      return { height: box.height, up: box.bottom - at.top, lines: at.height };
    });
    expect(now.lines).toBeGreaterThan(60);
    expect(end.height).toBeCloseTo(now.height, 0);
    expect(end.up).toBeCloseTo(now.up, 0);
    await context.close();
  });

  it("turns back from where it is when the mind changes while the composer changes shape", async () => {
    const { context, page } = await phone();
    await film(page);
    const turns = await page.evaluate(async () => {
      const text = document.querySelector<HTMLTextAreaElement>("#bottom .cmp textarea")!;
      const card = document.querySelector("#bottom .cmp")!;
      const height = () => card.getBoundingClientRect().height;
      /** Pictures go by until the card is as said; then, as a finger acts: between two of them. */
      const until = async (reached: () => boolean) => {
        for (let i = 0; i < 300 && !reached(); i++)
          await new Promise((done) => requestAnimationFrame(done));
        await new Promise((done) => setTimeout(done, 0));
        return height();
      };
      const line = height();
      text.focus();
      // The card has started to grow: the focus goes.
      const first = await until(() => height() > line + 10);
      text.blur();
      // It grows a little more on its speed, then comes back down: the focus returns.
      let most = first;
      const second = await until(() => {
        most = Math.max(most, height());
        return height() < most - 4;
      });
      text.focus();
      return { line, first, second };
    });
    await atRest(page);
    const frames = await cut(page);
    const whole = frames.at(-1)!.height;
    expect(whole).toBeGreaterThan(turns.line + 20);
    // Both changes of mind came on the way: the card was no longer a line, and not yet whole.
    for (const at of [turns.first, turns.second]) {
      expect(at).toBeGreaterThan(turns.line + 1);
      expect(at).toBeLessThan(whole - 1);
    }
    // Each time the card and its text go on from where they are, at the speed they have: no
    // picture shows them further than a spring takes them (0.25 px/ms at most).
    expect(
      fastest(
        frames,
        (f) => f.height,
        (f) => f.up,
        (f) => f.left,
      ),
    ).toBeLessThan(0.5);
    await context.close();
  });

  it("moves its text from where it was seen, whatever came above the composer", async () => {
    const { context, page } = await phone();
    // What the app shows there at times (a warning, a goal, messages waiting) came since the
    // composer was last drawn.
    await page.evaluate(() => {
      const band = document.createElement("div");
      band.style.height = "64px";
      document.querySelector("#bottom .cw")!.prepend(band);
    });
    await film(page);
    await pictures(page, 3);
    await composer(page).tap();
    await atRest(page);
    const frames = await cut(page);
    expect(frames.length).toBeGreaterThan(10);
    // The text travels to its place in the card: it starts from where it was, and never jumps.
    expect(
      fastest(
        frames,
        (f) => f.up,
        (f) => f.left,
        (f) => f.height,
      ),
    ).toBeLessThan(1);
    expect(frames.at(-1)!.height).toBeGreaterThan(frames[0]!.height + 20);
    await context.close();
  });

  it("leaves a draft of several lines where it is until the keyboard shows", async () => {
    const { context, page } = await phone();
    await page.evaluate(
      ([key, tall]) => localStorage.setItem(key!, tall!),
      [STORED, String(KEYBOARD)],
    );
    // A draft of three lines written earlier, the keyboard away.
    await composer(page).fill("Une ligne\nDeux lignes\nTrois lignes");
    await composer(page).blur();
    await atRest(page);
    const before = await look(page);
    expect(before.keyboard).toBe(false);
    // A touch on one of its lines: the system puts the caret where the finger is, so the lines
    // stay under the finger. The page moves once the keyboard is there.
    await composer(page).tap();
    await pictures(page, 2);
    const touched = await look(page);
    expect(touched.keyboard).toBe(false);
    expect(touched.composer).toEqual(before.composer);
    await keyboard(page, KEYBOARD, 120);
    await atRest(page);
    const up = await look(page);
    expect(up.keyboard).toBe(true);
    expect(up.shell!.top).toBe(120);
    expect(up.composer!.bottom).toBe(120 + PHONE.height - KEYBOARD - GAP);
    await composer(page).blur();
    await keyboard(page, 0);
    await atRest(page);

    // With one line there is only one for the caret: the page moves at the touch.
    await composer(page).fill("Une ligne");
    await composer(page).blur();
    await atRest(page);
    expect((await look(page)).keyboard).toBe(false);
    await composer(page).tap();
    expect((await look(page)).keyboard).toBe(true);
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
    expect(up.tabs).toEqual({ seen: 0, reached: false, front: false });
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
