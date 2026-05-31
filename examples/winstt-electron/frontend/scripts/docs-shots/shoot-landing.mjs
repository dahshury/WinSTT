// Capture the uniform 3:2 feature tiles used by the docs LANDING showcase
// (docs/src/routes/index.tsx). Clips a fixed-aspect window of the full settings
// PANEL positioned on each feature, so surrounding panel context fills the tile
// (no whitespace void, no clipped controls) and every tile is the same shape.
//
// Produces: feat-stt, feat-llm, feat-recording, feat-history.
// The remaining two tiles are DERIVED from existing screenshots by
// `derive-landing-tiles.py` (run it after `capture.mjs`):
//   • feat-tts   ← pad section-tts.png (capture.mjs `interactive`) to 3:2
//   • feat-model ← crop model-dropdown.png (capture.mjs `interactive`) to 3:2
//
// Usage:
//   1. bun run build            (renderer → dist-renderer/)
//   2. bunx vite preview --port 4319 --strictPort --host 127.0.0.1
//   3. node scripts/docs-shots/shoot-landing.mjs
//   4. node scripts/docs-shots/capture.mjs interactive   (refresh section-tts/model-dropdown)
//   5. python scripts/docs-shots/derive-landing-tiles.py
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildMockMap } from "./mock-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../../docs/public/screenshots");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4319";
const SCALE = 2;
const ASPECT = 1.5; // 3:2 uniform tiles
mkdirSync(OUT_DIR, { recursive: true });

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
		invoke: (channel) =>
			Promise.resolve(channel in map.invoke ? clone(map.invoke[channel]) : undefined),
		secureInvoke: (channel) =>
			Promise.resolve(channel in map.secure ? clone(map.secure[channel]) : undefined),
		on: (channel, cb) => {
			if (channel in map.emit) {
				const payload = map.emit[channel];
				setTimeout(() => {
					try {
						cb(clone(payload));
					} catch {
						/* ignore */
					}
				}, 40);
			}
			return () => {};
		},
	};
}

const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;}`;

// Verified ElevenLabs key so the TTS / cloud-source UI lights up (harmless for
// the non-TTS tiles). Mirrors capture.mjs's section-tts mock.
const EL_VERIFIED = {
	settings: {
		integrations: {
			elevenlabs: {
				apiKey: "sk_demo_elevenlabs_key",
				verified: true,
				lastVerifiedAt: 1_748_000_000_000,
			},
		},
	},
};

async function ctxPage(browser, mockOpts) {
	const ctx = await browser.newContext({
		viewport: { width: 1040, height: 2600 },
		deviceScaleFactor: SCALE,
		colorScheme: "dark",
		locale: "en-US",
	});
	await ctx.addInitScript(installMock, buildMockMap(mockOpts ?? {}));
	const page = await ctx.newPage();
	return { ctx, page };
}

async function openSettings(page, idx) {
	await page.goto(`${BASE}/windows/settings.html`, { waitUntil: "domcontentloaded" });
	await page.getByRole("tab").first().waitFor({ timeout: 15000 });
	await page.getByRole("tab").nth(idx).click();
	await page.waitForTimeout(450);
}

async function stabilize(page) {
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await page.addStyleTag({ content: FREEZE_CSS });
	await page.waitForTimeout(250);
}

// Clip a uniform-aspect window of the panel, pinning `headingText`'s section
// `padTop` px below the clip top (clamped so the clip stays inside the panel).
async function shootFeature(page, headingText, outName, { padTop = 22 } = {}) {
	const box = await page.evaluate((ht) => {
		const panel = document.querySelector('[role="tabpanel"]');
		const pr = panel.getBoundingClientRect();
		const heads = [...panel.querySelectorAll("h1,h2,h3,h4,h5")];
		const h = heads.find((e) => e.textContent.trim() === ht);
		const target = h ? (h.closest("section") ?? h) : panel;
		const sr = target.getBoundingClientRect();
		return { pl: pr.left, pw: pr.width, pt: pr.top, pb: pr.bottom, st: sr.top };
	}, headingText);
	const width = Math.round(box.pw);
	const height = Math.round(width / ASPECT);
	let y = Math.round(box.st - padTop);
	y = Math.max(Math.round(box.pt), Math.min(y, Math.round(box.pb - height)));
	if (y < 0) y = 0;
	await page.screenshot({
		path: resolve(OUT_DIR, `${outName}.png`),
		clip: { x: Math.max(0, Math.round(box.pl)), y, width, height },
	});
	console.log(`  ✓ ${outName}.png (${width}x${height})`);
}

const browser = await chromium.launch();
console.log(`Capturing landing tiles → ${OUT_DIR}`);

// STT local & cloud — Main Model section (Source toggle + model/device).
{
	const { ctx, page } = await ctxPage(browser, EL_VERIFIED);
	await openSettings(page, 1);
	await stabilize(page);
	await shootFeature(page, "Main Model", "feat-stt");
	await ctx.close();
}
// LLM post-processing.
{
	const { ctx, page } = await ctxPage(browser, EL_VERIFIED);
	await openSettings(page, 1);
	await stabilize(page);
	await shootFeature(page, "LLM Post-Processing", "feat-llm");
	await ctx.close();
}
// Recording modes — General tab.
{
	const { ctx, page } = await ctxPage(browser);
	await openSettings(page, 0);
	await stabilize(page);
	await shootFeature(page, "Recording", "feat-recording");
	await ctx.close();
}
// History — top of the History tab (stats + heatmap).
{
	const { ctx, page } = await ctxPage(browser);
	await openSettings(page, 6);
	await stabilize(page);
	await shootFeature(page, "Overall Stats", "feat-history", { padTop: 18 });
	await ctx.close();
}

await browser.close();
console.log(
	"Done. Now run capture.mjs interactive + derive-landing-tiles.py for feat-tts / feat-model."
);
