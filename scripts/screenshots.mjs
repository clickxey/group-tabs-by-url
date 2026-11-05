// Renders the popup and settings page with a mock `browser` object and saves
// screenshots for the addons.mozilla.org listing into docs/screenshots/.
//
//   npm install            (installs playwright-core)
//   node scripts/screenshots.mjs [path-to-chromium]
//
// Pages are rendered in Chromium for convenience; colours and layout match
// what Firefox shows closely enough for store images.

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const out = path.join(root, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const messages = JSON.parse(readFileSync(path.join(ext, "_locales/en/messages.json"), "utf8"));
const mockSource = readFileSync(path.join(root, "scripts/mock-browser.js"), "utf8");
const { version } = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));

const TABS = [
  "https://x.com/home", "https://www.youtube.com/watch?v=a1", "https://developer.mozilla.org/en-US/docs/Web",
  "https://x.com/mozilla/status/1", "https://www.google.com/search?q=tab+groups", "https://github.com/mozilla/gecko-dev",
  "https://www.youtube.com/watch?v=b2", "https://x.com/firefox", "about:newtab",
  "https://news.ycombinator.com/", "https://www.google.com/search?q=firefox+addons", "https://x.com/i/bookmarks",
  "https://www.youtube.com/@mozilla", "https://en.wikipedia.org/wiki/Tab_(interface)", "https://x.com/explore",
  "https://www.google.com/search?q=css+grid", "about:newtab", "https://x.com/notifications",
  "https://youtu.be/c3", "https://x.com/messages", "https://www.youtube.com/feed/subscriptions",
];

const settings = (extra = {}) => ({
  schema: 2,
  mode: "collect",
  rules: [
    { id: "default-x", name: "X", color: "blue", type: "site", patterns: ["x.com", "twitter.com"], enabled: true },
    { id: "default-youtube", name: "YouTube", color: "red", type: "site", patterns: ["youtube.com", "youtu.be"], enabled: true },
    { id: "default-search", name: "Google Search", color: "yellow", type: "site", patterns: ["google.com/search"], enabled: true },
    { id: "default-newtab", name: "New tabs", color: "grey", type: "prefix", patterns: ["about:newtab", "about:home", "about:blank"], enabled: true },
    { id: "r-docs", name: "Docs", color: "green", type: "regex", patterns: ["^https://developer\\.mozilla\\.org/", "("], enabled: false },
  ],
  ...extra,
});

const executablePath = process.argv[2] || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });

async function open(page, file, mock) {
  await page.addInitScript(`window.__MOCK__ = ${JSON.stringify({ ...mock, version })};\n${mockSource}`);
  const [page_, query = ""] = file.split("?");
  await page.goto(pathToFileURL(path.join(ext, page_)).href + (query ? "?" + query : ""));
  await page.waitForTimeout(500);
}

async function shoot({ name, file, scheme, viewport, mock, clipBody, before }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: scheme });
  await open(page, file, mock);
  if (before) await before(page);
  const target = path.join(out, name);
  if (clipBody) await page.locator("body").screenshot({ path: target });
  else await page.screenshot({ path: target });
  await page.close();
  return target;
}

const popupSettings = settings();
popupSettings.rules[4].patterns = ["developer.mozilla.org"];
popupSettings.rules[4].type = "site";
const popupMock = { messages, tabs: TABS, settings: popupSettings, undo: true };

const popupLight = await shoot({ name: "raw-popup-light.png", file: "popup/popup.html", scheme: "light", viewport: { width: 340, height: 600 }, mock: popupMock, clipBody: true });
const popupDark = await shoot({ name: "raw-popup-dark.png", file: "popup/popup.html", scheme: "dark", viewport: { width: 340, height: 600 }, mock: popupMock, clipBody: true });

await shoot({
  name: "02-settings.png",
  file: "options/options.html",
  scheme: "light",
  viewport: { width: 1280, height: 800 },
  mock: { messages, tabs: TABS, settings: settings() },
});
await shoot({
  name: "03-settings-dark.png",
  file: "options/options.html",
  scheme: "dark",
  viewport: { width: 1280, height: 800 },
  mock: { messages, tabs: TABS, settings: settings() },
  before: (p) => p.evaluate(() => window.scrollTo(0, document.querySelector("#behavior-heading").getBoundingClientRect().top + window.scrollY - 260)),
});
await shoot({
  name: "raw-welcome.png",
  file: "options/options.html?welcome=1",
  scheme: "light",
  viewport: { width: 1280, height: 800 },
  mock: { messages, tabs: TABS },
});

// Store image: the real popup on a calm backdrop with a one-line caption.
const showcase = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
// (images are captured at 2x, so they stay sharp when shown at 420px)
const img = (p) => "data:image/png;base64," + readFileSync(p).toString("base64");
await showcase.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;gap:72px;padding:0 96px;box-sizing:border-box;background:linear-gradient(135deg,#f0f0f4,#deeafc);font-family:system-ui,sans-serif;color:#15141a">
  <div style="flex:1">
    <div style="font-size:44px;font-weight:700;line-height:1.15;letter-spacing:-0.01em">Every matching tab,<br>from every window,<br>in one group.</div>
    <p style="font-size:21px;line-height:1.5;color:#5b5b66;margin:22px 0 0;max-width:470px">Write a rule like <b style="color:#15141a">x.com</b> or <b style="color:#15141a">google.com/search</b>, click once, and the tabs line up in a tab group — without reloading a single page.</p>
  </div>
  <div style="display:flex;gap:28px;align-items:flex-start">
    <img src="${img(popupLight)}" style="width:420px;border-radius:14px;box-shadow:0 12px 40px rgba(21,20,26,.18),0 0 0 1px rgba(21,20,26,.08)">
  </div>
</body></html>`);
await showcase.screenshot({ path: path.join(out, "01-popup.png") });

await showcase.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:56px;background:linear-gradient(135deg,#1c1b22,#2b2a33);font-family:system-ui,sans-serif;color:#fbfbfe">
  <img src="${img(popupDark)}" style="width:420px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)">
  <div style="max-width:520px">
    <div style="font-size:40px;font-weight:700;line-height:1.15">Matches websites, not just text.</div>
    <p style="font-size:20px;line-height:1.55;color:#bfbfc9;margin:20px 0 0"><b style="color:#fbfbfe">x.com</b> groups x.com and mobile.x.com — but never netflix.com. Need more control? Use “address contains”, “starts with”, or a regular expression.</p>
    <p style="font-size:20px;line-height:1.55;color:#bfbfc9;margin:16px 0 0">Changed your mind? <b style="color:#fbfbfe">Undo</b> puts every tab back.</p>
  </div>
</body></html>`);
await showcase.screenshot({ path: path.join(out, "04-popup-dark.png") });

await browser.close();
console.log("Screenshots written to", out);
