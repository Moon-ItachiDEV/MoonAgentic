// Draws the app's PNG icons from public/icon.svg, which phones need to install the app:
// iOS takes no SVG for its home screen, Android wants 192 and 512 pixel ones, and a
// « maskable » one that it may cut to a circle. An iPhone also asks by itself for
// apple-touch-icon-precomposed.png, and browsers for favicon.ico. Run again after changing the icon:
//   node apps/web/scripts/icons.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
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
/** The icon drawn at `size` pixels, as PNG bytes. */
const draw = async (size, source) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
};
for (const icon of icons) writeFileSync(path.join(pub, icon.file), await draw(icon.size, icon.svg));
copyFileSync(
  path.join(pub, "apple-touch-icon.png"),
  path.join(pub, "apple-touch-icon-precomposed.png"),
);

// favicon.ico: the rounded tile at 16, 32 and 48 pixels, each kept as a PNG inside the file.
const sizes = [16, 32, 48];
const pngs = [];
for (const size of sizes) pngs.push(await draw(size, svg));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  head.writeUInt8(size, at);
  head.writeUInt8(size, at + 1);
  head.writeUInt16LE(1, at + 4);
  head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(pngs[i].length, at + 8);
  head.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
});
writeFileSync(path.join(pub, "favicon.ico"), Buffer.concat([head, ...pngs]));
await browser.close();
console.log(`Icônes écrites dans ${pub}`);
