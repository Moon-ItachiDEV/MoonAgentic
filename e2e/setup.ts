// With E2E_FAILURES set (as in CI), a failed check leaves a picture of each page still open,
// named after it, and prints what each page says and the errors it logged: what the page
// showed says more than a timeout, above all on Windows.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { beforeEach } from "vitest";

const out = process.env.E2E_FAILURES;
const browsers = new Set<Browser>();
const logs = new WeakMap<Page, string[]>();

function follow(context: BrowserContext): BrowserContext {
  const watch = (page: Page) => {
    const log: string[] = [];
    logs.set(page, log);
    page.on("pageerror", (error) => log.push(`erreur : ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        log.push(`${message.type()} : ${message.text()}`);
    });
  };
  context.pages().forEach(watch);
  context.on("page", watch);
  return context;
}

if (out) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args: Parameters<typeof chromium.launch>) => {
    const browser = await launch(...args);
    browsers.add(browser);
    browser.on("disconnected", () => browsers.delete(browser));
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...a) => follow(await newContext(...a));
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...a) => {
      const page = await newPage(...a);
      if (!logs.has(page)) follow(page.context());
      return page;
    };
    return browser;
  };
  beforeEach(({ task, onTestFailed }) => {
    onTestFailed(async () => {
      mkdirSync(out, { recursive: true });
      const name = `${path.basename(task.file?.name ?? "e2e")}-${task.name}`
        .replace(/[^\p{L}\p{N}.-]+/gu, "-")
        .slice(0, 120);
      let n = 0;
      for (const browser of browsers) {
        for (const context of browser.contexts()) {
          for (const page of context.pages()) {
            n++;
            await page
              .screenshot({ path: path.join(out, `${name}-${n}.png`), timeout: 5000 })
              .catch(() => undefined);
            const text = await page
              .evaluate(() => document.body?.innerText ?? "")
              .catch(() => "(page illisible)");
            console.error(
              [
                `── ${task.name} · page ${n} · ${page.url()}`,
                text.replace(/\n{2,}/g, "\n").slice(0, 2000),
                ...(logs.get(page) ?? []).slice(-20),
              ].join("\n"),
            );
          }
        }
      }
    });
  });
}
