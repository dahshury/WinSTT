// Hover a docs preview-tooltip trigger and capture the open animated demo.
// Usage (from frontend/): node scripts/docs-shots/shoot-tooltip.mjs "slug::Trigger Text" ...

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.DOCS_URL ?? "http://127.0.0.1:4504";
const OUT = "scripts/docs-shots/_docshots";
mkdirSync(OUT, { recursive: true });

const jobs = process.argv.slice(2).map((a) => {
	const [slug, text] = a.split("::");
	return { slug, text };
});

const browser = await chromium.launch();
for (const { slug, text } of jobs) {
	const ctx = await browser.newContext({
		viewport: { width: 1100, height: 900 },
		deviceScaleFactor: 2,
		colorScheme: "dark",
	});
	const page = await ctx.newPage();
	await page.goto(`${BASE}/docs/${slug}`, { waitUntil: "networkidle" }).catch(() => {});
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	const trigger = page.locator(".cpt-trigger", { hasText: text }).first();
	await trigger.scrollIntoViewIfNeeded().catch(() => {});
	await trigger.hover().catch(() => {});
	const pop = page.locator(".cpt-pop").first();
	await pop.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(1600); // let the loop reach a representative frame
	const name = `tip-${slug.replace(/[/:]/g, "-")}-${text.replace(/[^a-z0-9]+/gi, "").slice(0, 10)}`;
	const target = (await pop.count()) ? pop : page;
	await target.screenshot({ path: `${OUT}/${name}.png` }).catch(async () => {
		await page.screenshot({ path: `${OUT}/${name}.png` });
	});
	console.log(`  ✓ ${name}.png  (${slug} :: ${text})`);
	await ctx.close();
}
await browser.close();
