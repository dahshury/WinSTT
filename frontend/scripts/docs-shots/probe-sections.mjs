// List the section headings rendered in each settings tab, so we can capture
// focused, element-scoped crops of each control group.
import { chromium } from "@playwright/test";
import { buildMockMap } from "./mock-data.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4319";
const MOCK = buildMockMap();

function installMock(map) {
	const clone = (v) => {
		try {
			return structuredClone(v);
		} catch {
			return JSON.parse(JSON.stringify(v));
		}
	};
	window.electronAPI = {
		getPathForFile: () => "",
		send: () => {},
		invoke: (c) => Promise.resolve(c in map.invoke ? clone(map.invoke[c]) : undefined),
		secureInvoke: (c) => Promise.resolve(c in map.secure ? clone(map.secure[c]) : undefined),
		on: (c, cb) => {
			if (c in map.emit)
				setTimeout(() => {
					try {
						cb(clone(map.emit[c]));
					} catch {}
				}, 40);
			return () => {};
		},
	};
}

const TABS = [
	"general",
	"model",
	"audio",
	"quality",
	"dictionary",
	"snippets",
	"history",
	"integrations",
	"about",
];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 1400 }, colorScheme: "dark" });
await ctx.addInitScript(installMock, MOCK);
const page = await ctx.newPage();
await page.goto(`${BASE}/windows/settings.html`, { waitUntil: "domcontentloaded" });
await page.getByRole("tab").first().waitFor({ timeout: 15000 });
for (let i = 0; i < TABS.length; i++) {
	await page.getByRole("tab").nth(i).click();
	await page.waitForTimeout(350);
	const data = await page.evaluate(() => {
		const panel = document.querySelector('[role="tabpanel"]');
		if (!panel) return { sections: [], headings: [] };
		const sections = [...panel.querySelectorAll("section")].map((s) => {
			const h = s.querySelector("h3,h2,h4");
			const r = s.getBoundingClientRect();
			return {
				h: h?.textContent?.trim() ?? "(none)",
				w: Math.round(r.width),
				ht: Math.round(r.height),
			};
		});
		return { sections };
	});
	console.log(`\n[${TABS[i]}] ${data.sections.length} <section>:`);
	for (const s of data.sections) console.log(`   "${s.h}"  ${s.w}x${s.ht}`);
}
await b.close();
