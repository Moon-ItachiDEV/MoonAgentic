// With E2E_FAILURES set (as in CI), a failed check leaves a picture of each page still open,
// named after it: what the page showed says more than a timeout, above all on Windows.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { beforeEach } from "vitest";

const out = process.env.E2E_FAILURES;
const browsers = new Set<Browser>();

if (out) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args: Parameters<typeof chromium.launch>) => {
    const browser = await launch(...args);
    browsers.add(browser);
    browser.on("disconnected", () => browsers.delete(browser));
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
              .screenshot({
                path: path.join(out, `${name}-${n}.png`),
                fullPage: false,
                timeout: 5000,
              })
              .catch(() => undefined);
          }
        }
      }
    });
  });
}
