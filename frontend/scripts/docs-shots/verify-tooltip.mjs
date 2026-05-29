// Assert the tooltip → video wiring: hover a trigger, confirm a <video> with
// the expected src mounts (headless can't paint video, so we check the DOM).
import { chromium } from "@playwright/test";

const BASE = process.env.DOCS_URL ?? "http://127.0.0.1:4505";
const CASES = [
	{ slug: "recording-modes", text: "Push-to-Talk", expect: "ptt" },
	{ slug: "recording-modes", text: "Listen", expect: "listen" },
	{ slug: "settings/general", text: "Radial", expect: "viz-radial" },
	{ slug: "settings/general", text: "Dynamic island", expect: "overlay-island" },
	{ slug: "settings/llm", text: "dictation cleanup", expect: "llm-dictation" },
	{ slug: "dictionary", text: "replacement pair", expect: "dictionary" },
	{ slug: "snippets", text: "trigger", expect: "snippets" },
	{ slug: "dictation", text: "see it in action", expect: "auto-submit" },
];
const b = await chromium.launch();
let pass = 0;
for (const c of CASES) {
	const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
	const p = await ctx.newPage();
	await p.goto(`${BASE}/docs/${c.slug}`, { waitUntil: "networkidle" }).catch(() => {});
	const trigger = p.locator(".cpt-trigger", { hasText: c.text }).first();
	await trigger.scrollIntoViewIfNeeded().catch(() => {});
	await trigger.hover().catch(() => {});
	await p.waitForTimeout(400);
	const src = await p
		.locator(".cpt-pop video")
		.first()
		.getAttribute("src")
		.catch(() => null);
	const ok = !!src && src.includes(c.expect);
	console.log(`${ok ? "✓" : "✗"} ${c.slug} :: "${c.text}" → ${src ?? "(no video)"}`);
	if (ok) pass++;
	await ctx.close();
}
await b.close();
console.log(`\n${pass}/${CASES.length} tooltip→video wirings OK`);
process.exit(pass === CASES.length ? 0 : 1);
