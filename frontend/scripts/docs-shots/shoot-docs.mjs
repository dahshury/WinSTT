// Render WinSTT docs pages to PNG for visual review (uses frontend's playwright).
// Usage (run from frontend/): node scripts/docs-shots/shoot-docs.mjs <slug> [slug ...]

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.DOCS_URL ?? "http://127.0.0.1:4500";
const OUT = "scripts/docs-shots/_docshots";
mkdirSync(OUT, { recursive: true });

const slugs = process.argv.slice(2);
const browser = await chromium.launch();
for (const slug of slugs) {
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 2,
		colorScheme: "dark",
	});
	const page = await ctx.newPage();
	const url = slug.startsWith("abs:") ? `${BASE}${slug.slice(4)}` : `${BASE}/docs/${slug}`;
	await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await page.waitForTimeout(600);
	const name = slug === "abs:/" ? "landing" : slug === "" ? "home" : slug.replace(/[/:]/g, "-");
	await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
	console.log(`  ✓ ${name}.png  (${url})`);
	await ctx.close();
}
await browser.close();
