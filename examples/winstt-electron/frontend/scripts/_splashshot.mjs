import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { buildSplashHtml } from "../electron/lib/splash-html.ts";

const b64 = (p, m) => `data:${m};base64,${readFileSync(p).toString("base64")}`;
const slide = (f, title, subtitle) => ({ src: b64(`public/splash/${f}`, "image/webp"), title, subtitle });
const html = buildSplashHtml({
  logo: b64("public/icon.png", "image/png"),
  slides: [
    slide("feat-stt.webp", "Talk, and it types", "Local & cloud speech-to-text in any app."),
    slide("feat-llm.webp", "Polished by AI", "Optional LLM clean-up, translation & formatting."),
    slide("feat-history.webp", "Every dictation, saved", "Searchable history with playback & stats."),
  ],
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 452 }, deviceScaleFactor: 2 });
// neutral desktop-ish backdrop so the transparent card + shadow are visible
await page.setContent(`<div style="position:fixed;inset:0;background:#2b2d31"></div>` + html);
await page.waitForTimeout(400);
await page.screenshot({ path: "scripts/_splash-shot-1.png" });
// advance to slide 2 to verify the caption swap + segment fill
await page.waitForTimeout(3100);
await page.screenshot({ path: "scripts/_splash-shot-2.png" });
await browser.close();
console.log("shots written");
