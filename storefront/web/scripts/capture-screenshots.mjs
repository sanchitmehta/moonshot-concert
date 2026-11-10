import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Usage: SITE_URL=<storefront-web URL from the Aspire dashboard> [CONFIRMATION_PATH=/confirmation/...#key=...] npm run screenshots
const base = process.env.SITE_URL;
if (!base) throw new Error("Set SITE_URL to the running storefront-web URL, for example http://localhost:5173.");
const confirmation = process.env.CONFIRMATION_PATH;
const out = process.env.OUT_DIR ?? fileURLToPath(new URL("../../../docs/screenshots", import.meta.url));
mkdirSync(out, { recursive: true });

const shots = [
  { name: "desktop-home", viewport: { width: 1440, height: 900 }, path: "/", settle: 3500 },
  { name: "desktop-lineup", viewport: { width: 1440, height: 900 }, path: "/", scrollTo: "#lineup", settle: 1500 },
  { name: "desktop-drops", viewport: { width: 1440, height: 900 }, path: "/", scrollTo: "#drops", settle: 1500 },
  { name: "desktop-passes", viewport: { width: 1440, height: 900 }, path: "/", scrollTo: "#passes", settle: 1500 },
  { name: "desktop-reserve", viewport: { width: 1440, height: 900 }, path: "/reserve/crater-club", settle: 1500 },
  ...(confirmation ? [{ name: "desktop-confirmation", viewport: { width: 1440, height: 900 }, path: confirmation, settle: 2000 }] : []),
  { name: "mobile-home", viewport: { width: 390, height: 844 }, path: "/", settle: 3500 },
  { name: "mobile-passes", viewport: { width: 390, height: 844 }, path: "/", scrollTo: "#passes", settle: 1500 },
  { name: "mobile-reserve", viewport: { width: 390, height: 844 }, path: "/reserve/crater-club", settle: 1500 },
];

const browser = await chromium.launch({ channel: "msedge" });
try {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: shot.viewport, deviceScaleFactor: shot.viewport.width < 600 ? 2 : 1 });
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    if (shot.scrollTo) {
      await page.evaluate(selector => {
        const element = document.querySelector(selector);
        window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 64);
      }, shot.scrollTo);
    }
    await page.waitForTimeout(shot.settle);
    await page.screenshot({ path: join(out, `${shot.name}.png`) });
    console.log(`captured ${shot.name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
