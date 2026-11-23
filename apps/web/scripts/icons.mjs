// Draws the app's PNG icons from public/icon.svg, which phones need to install the app:
// iOS takes no SVG for its home screen, Android wants 192 and 512 pixel ones, and a
// « maskable » one that it may cut to a circle. Run again after changing the icon:
//   node apps/web/scripts/icons.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const pub = fileURLToPath(new URL("../public/", import.meta.url));
const svg = readFileSync(path.join(pub, "icon.svg"), "utf8");
// The mark alone, without its rounded tile: what goes on a full square.
const mark = svg
  .slice(svg.indexOf("<defs>"), svg.lastIndexOf("</svg>"))
  .replace(/<rect width="48" height="48" rx="11"[^>]*\/>/, "");
/** The mark on a full square of the app's dark colour, at `scale` of the square. */
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#111113"/><g transform="translate(${24 - 24 * scale} ${24 - 24 * scale}) scale(${scale})">${mark}</g></svg>`;

const icons = [
  // The rounded tile, transparent around it.
  { file: "icon-192.png", size: 192, svg },
  { file: "icon-512.png", size: 512, svg },
  // Android may cut it to a circle: the mark stays within the middle 80 %.
  { file: "icon-maskable-512.png", size: 512, svg: square(0.8) },
  // iOS rounds the corners itself, and shows no transparency.
  { file: "apple-touch-icon.png", size: 180, svg: square(0.9) },
];

const browser = await chromium.launch();
for (const icon of icons) {
  const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${icon.size}px;height:${icon.size}px}</style>${icon.svg}`,
  );
  await page.screenshot({ path: path.join(pub, icon.file), omitBackground: true });
  await page.close();
}
await browser.close();
console.log(`Icônes écrites dans ${pub}`);
