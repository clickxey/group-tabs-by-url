// Renders extension/icons/icon.svg to the PNG sizes listed in the manifest's
// "icons". Firefox's add-ons manager doesn't reliably show SVG icons, so the
// manifest points at these PNGs; the toolbar button keeps using the SVG.
//
//   npm install
//   npm run icons [path-to-chromium]
//
// Run it again whenever icon.svg changes, and commit the PNGs.

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "extension", "icons");
const svg = readFileSync(path.join(dir, "icon.svg"), "utf8");
const SIZES = [16, 32, 48, 96, 128];

const executablePath = process.argv[2] || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log(`Wrote ${SIZES.map((s) => `icon-${s}.png`).join(", ")} to extension/icons/`);
