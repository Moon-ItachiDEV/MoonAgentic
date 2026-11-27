// A long answer written fast, in the built app against a real server: the page keeps up.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { addProject, pickAgent } from "./ui.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: ChildProcess;
let browser: Browser;
let url: string;
let dir: string;

beforeAll(async () => {
  if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
    throw new Error("Lance d'abord « pnpm build » : ce test utilise l'app construite.");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-flux-e2e-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  server = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "--demo", "--port", "0", "--data-dir", path.join(dir, "data")],
    {
      cwd: root,
      // A short wait between two words, as a model writes: the answer takes a few seconds.
      env: { ...process.env, HOME: home, USERPROFILE: home, MOONAGENTIC_DEMO_DELAY_MS: "2" },
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

/** Words to write, so that an answer lasts. */
const WORDS = "Une phrase de plus pour que la réponse dure, avec du **gras** et du `code`. "
  .repeat(16)
  .trim();

/**
 * An answer with HTML of its own, among its Markdown: the title of a page, which the start of
 * a page does not read as the rest of it does, a fold opened in a block and closed in
 * another, and a tag never closed, which reaches all that follows it.
 */
const OWN_HTML = [
  `Avant. ${WORDS}`,
  "- un point\n- un autre",
  "<title>Un titre de page</title>",
  `Entre les deux. ${WORDS}`,
  "<details>\n<summary>Voir le détail</summary>",
  "Dedans, avec du **gras**.",
  "</details>",
  `Un <b>gras jamais fermé. ${WORDS}`,
  "| a | b |\n| - | - |\n| 1 | 2 |",
  `Fin de la réponse. ${WORDS}`,
].join("\n\n");

/** A new project's composer, set on the demo agent, on a device `slowdown` times slower. */
async function newThread(name: string, slowdown = 1) {
  const project = path.join(dir, name.replaceAll(" ", "-"));
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "# Démo\n");
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
  await page.goto(url);
  await addProject(page, project);
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  // The demo agent, not a real one that may be installed on this machine.
  await pickAgent(page);
  return { page, composer };
}

describe("streaming", () => {
  // On a slow device a lot is written between two looks at the page: it still follows.
  it.each([
    ["on a fast device", 1],
    ["on a slow device", 8],
  ])(
    "draws a fast answer a few times a second, follows it down, and ends on all of it, %s",
    async (name, slowdown) => {
      const { page, composer } = await newThread(name, slowdown);

      // Counts each time the answer's Markdown is put on the page again, and when.
      await page.evaluate(() => {
        const seen = { draws: 0, grown: 0, first: 0, last: 0, awayFromEnd: 0 };
        (window as unknown as { seen: typeof seen }).seen = seen;
        new MutationObserver((changes) => {
          const drawn = changes.some(
            (c) => c.type === "childList" && (c.target as Element).classList?.contains("md"),
          );
          if (!drawn) return;
          seen.draws += 1;
          seen.first ||= performance.now();
          seen.last = performance.now();
        }).observe(document.body, { subtree: true, childList: true });
        // Whenever the answer grows, the page follows before it is painted. Looked at right
        // after the app's own watch of that growth, which is set first and so runs first:
        // looked at any later, a piece drawn meanwhile would be read before it is followed.
        const watchGrowth = () => {
          const view = document.querySelector(".view");
          const feed = document.querySelector(".feed");
          if (!view || !feed) return requestAnimationFrame(watchGrowth);
          // The app sets its watch once the thread is on the page: ours a moment after.
          setTimeout(() => {
            new ResizeObserver(() => {
              seen.grown += 1;
              if (view.scrollHeight - view.scrollTop - view.clientHeight > 4) seen.awayFromEnd += 1;
            }).observe(feed);
          }, 50);
        };
        watchGrowth();
      });

      await composer.fill("/flux");
      await page.keyboard.press("Enter");
      // The turn is over: the composer offers to send again, not to stop.
      await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(12);
      await expect.poll(() => page.locator(".md pre").count()).toBe(12);
      await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);

      const seen = await page.evaluate(
        () =>
          (
            window as unknown as {
              seen: {
                draws: number;
                grown: number;
                first: number;
                last: number;
                awayFromEnd: number;
              };
            }
          ).seen,
      );
      const seconds = (seen.last - seen.first) / 1000;
      // Nearly nine hundred words came, one at a time: the Markdown was worked out about ten
      // times a second, not once per word, and still while the answer was being written.
      expect(seen.draws).toBeGreaterThan(3);
      expect(seen.draws).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 4);
      // The reader stayed at the end of the answer all along, and is there now.
      expect(seen.grown).toBeGreaterThan(3);
      expect(seen.awayFromEnd).toBe(0);
      const view = page.locator(".view");
      expect(
        await view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      ).toBeLessThanOrEqual(4);
      // All of it is there, to its last line.
      expect(await page.locator(".md").last().textContent()).toMatch(/return 42;\s*}\s*$/);
      await page.close();
    },
  );

  it("puts only the end of the answer on the page again: what was read stays as it is", async () => {
    const { page, composer } = await newThread("what was read stays");

    // Counts what each look at the answer puts on the page. Once a few parts are written,
    // the first is read: its title is remembered, and the text under it selected.
    await page.evaluate(() => {
      const seen = { draws: 0, added: 0, title: null as Element | null, selected: "" };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver((changes) => {
        const drawn = changes.filter(
          (c) => c.type === "childList" && (c.target as Element).classList?.contains("md"),
        );
        if (!drawn.length) return;
        seen.draws += 1;
        for (const change of drawn) seen.added += change.addedNodes.length;
        const titles = document.querySelectorAll(".md h2");
        if (seen.title || titles.length < 3) return;
        seen.title = titles[0]!;
        getSelection()!.selectAllChildren(document.querySelector(".md p")!);
        seen.selected = getSelection()!.toString();
      }).observe(document.body, { subtree: true, childList: true });
    });

    await composer.fill("/flux");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(12);
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);

    const seen = await page.evaluate(() => {
      const { draws, added, title, selected } = (
        window as unknown as {
          seen: { draws: number; added: number; title: Element | null; selected: string };
        }
      ).seen;
      return {
        draws,
        added,
        selected,
        nodes: document.querySelector(".md")!.childNodes.length,
        sameTitle: title !== null && title === document.querySelector(".md h2"),
        stillSelected: getSelection()!.toString(),
      };
    });
    expect(seen.draws).toBeGreaterThan(3);
    // The title read is the one on the page, not another like it put in its place, and the
    // text selected under it is selected still: nothing took it off the page.
    expect(seen.sameTitle).toBe(true);
    expect(seen.selected).toContain("Voici une explication");
    expect(seen.stillSelected).toBe(seen.selected);
    // Each look put on the page what came since the last one, and the block it ended on
    // again. Had each put the whole answer, half of its nodes would have come every time.
    expect(seen.nodes).toBeGreaterThan(100);
    expect(seen.added).toBeLessThanOrEqual(seen.nodes + 4 * seen.draws + 10);

    // Written piece by piece, it is the page an answer read whole gives.
    const written = await page.locator(".md").innerHTML();
    await page.reload();
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(12);
    expect(await page.locator(".md").innerHTML()).toBe(written);
    await page.close();
  });

  it("leaves the reader where they went up to, while the answer goes on", async () => {
    const { page, composer } = await newThread("reader goes up");
    await composer.fill("/flux");
    await page.keyboard.press("Enter");
    const view = page.locator(".view");
    const fromEnd = () => view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    // Enough is written to go up in.
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBeGreaterThan(4);
    await view.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(fromEnd).toBeGreaterThan(300);
    const at = await view.evaluate((el) => el.scrollTop);
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);
    expect(await view.evaluate((el) => el.scrollTop)).toBe(at);
    // Back at the end, the next answer is followed again.
    await view.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await composer.fill("/flux");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".md h2").count(), { timeout: 30_000 }).toBe(24);
    await expect.poll(() => page.locator(".working").count(), { timeout: 30_000 }).toBe(0);
    expect(await fromEnd()).toBeLessThanOrEqual(4);
    await page.close();
  });

  // Kept last: until it is refused, the request the demo agent ends on is shown above the
  // composer of every thread, those of the other tests too.
  it("draws HTML of the answer's own, written piece by piece, as it reads whole", async () => {
    const { page, composer } = await newThread("html of its own");
    const answer = page.locator(".md", { hasText: "Tu m'as demandé" });
    const refuse = page.locator(".dc").getByRole("button", { name: /Refuser/ });

    // Counts the looks at the answer once its HTML is there. At the second, the paragraph
    // before the HTML is remembered: what is before it stays as it is, as in any answer.
    await page.evaluate(() => {
      const seen = { withHtml: 0, before: null as Element | null };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver((changes) => {
        const drawn = changes.some(
          (c) => c.type === "childList" && (c.target as Element).classList?.contains("md"),
        );
        if (!drawn || !document.querySelector(".md details")) return;
        seen.withHtml += 1;
        if (seen.withHtml === 2) seen.before = document.querySelector(".md:has(details) p");
      }).observe(document.body, { subtree: true, childList: true });
    });

    // The demo agent repeats what it is told, then asks before it changes a file: its answer
    // is all there, with the request.
    await composer.fill(OWN_HTML);
    await page.keyboard.press("Enter");
    await refuse.waitFor();
    const whole = () => expect.poll(() => answer.textContent(), { timeout: 30_000 });
    await whole().toMatch(/» \(modèle [^)]+\)\.\s*$/);

    const written = await answer.innerHTML();
    const seen = await page.evaluate(() => {
      const { withHtml, before } = (
        window as unknown as { seen: { withHtml: number; before: Element | null } }
      ).seen;
      return {
        withHtml,
        sameBefore: before !== null && before === document.querySelector(".md:has(details) p"),
      };
    });
    // Its HTML came while it was written, and was put on the page again with what followed
    // it. What was before it is what was first put there: the page was not drawn anew since.
    expect(seen.withHtml).toBeGreaterThan(2);
    expect(seen.sameBefore).toBe(true);
    // The fold holds what was written in it, three blocks apart.
    expect(await answer.locator("details").count()).toBe(1);
    expect(await answer.locator("details strong").textContent()).toBe("gras");
    // The tag never closed reaches the end of the answer, as on a page read from its start.
    expect(await answer.locator("b", { hasText: "Fin de la réponse." }).count()).toBeGreaterThan(0);

    // Written piece by piece, it is the page an answer read whole gives, to the last node.
    await page.reload();
    await refuse.waitFor();
    await whole().toMatch(/» \(modèle [^)]+\)\.\s*$/);
    expect(await answer.innerHTML()).toBe(written);

    await refuse.click();
    await page.getByText("D'accord, je ne touche à rien.").waitFor();
    await page.close();
  });
});
