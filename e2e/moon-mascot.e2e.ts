// The canvas moon (Réglages › Mascottes, Hermes's threads) looks at the pointer: it has to know
// where it is itself, without asking the page at every frame.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../apps/web/src/moon-mascot.ts", import.meta.url));

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

/** A page with one moon in a box, the pointer resting to its right, and its readings counted. */
async function moonPage() {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(
    `<body style="margin:0"><div id="box" style="width:160px;height:160px"><moon-mascot shape="full" color="ice" expression="idle" style="display:block;width:160px;height:160px"></moon-mascot></div></body>`,
  );
  await page.addScriptTag({
    type: "module",
    content: `${stripTypeScriptTypes(readFileSync(source, "utf8"))}\ndefineMoonMascot();`,
  });
  await page.waitForFunction(() => !!customElements.get("moon-mascot"));
  await page.mouse.move(400, 80);
  await page.mouse.move(420, 80);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const el = document.querySelector("moon-mascot")!;
    const real = el.getBoundingClientRect.bind(el);
    const seen = window as unknown as { lefts: number[] };
    seen.lefts = [];
    el.getBoundingClientRect = () => {
      const box = real();
      seen.lefts.push(box.left);
      return box;
    };
  });
  return page;
}
const lefts = (page: Awaited<ReturnType<typeof moonPage>>) =>
  page.evaluate(() => (window as unknown as { lefts: number[] }).lefts);

describe("la lune qui suit le pointeur", () => {
  it("retrouve sa place quand elle bouge sans défilement ni redimensionnement", async () => {
    const page = await moonPage();
    // A panel opens beside it: the moon is now to the right of the pointer, and nothing scrolled.
    await page.evaluate(() => (document.getElementById("box")!.style.marginLeft = "600px"));
    await expect.poll(async () => (await lefts(page)).at(-1)).toBe(600);
    await page.close();
  });

  it("ne relit pas sa place à chaque image", async () => {
    const page = await moonPage();
    await page.waitForTimeout(2000);
    // About five readings a second, where sixty frames are drawn.
    const count = (await lefts(page)).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(14);
    await page.close();
  });
});
