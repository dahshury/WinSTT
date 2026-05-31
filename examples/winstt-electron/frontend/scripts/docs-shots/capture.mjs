// Playwright driver that captures documentation screenshots of the real
// WinSTT renderer, hydrated via a mock `window.electronAPI` (see mock-data.mjs).
//
// Usage:
//   1. bunx vite preview --port 4319 --strictPort --host 127.0.0.1
//   2. node scripts/docs-shots/capture.mjs [group ...]
//        groups: settings | windows | interactive | visualizer | all (default)
//
// Output PNGs land in docs/public/screenshots/.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildMockMap } from "./mock-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../../docs/public/screenshots");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4319";
const SCALE = 2;
mkdirSync(OUT_DIR, { recursive: true });

// Runs before any bundle code. `audioLevel` channel is driven on an interval so
// the canvas visualizer animates to a real waveform instead of one flat frame.
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
			if (channel === "stt:audio-level" && "stt:audio-level" in map.emit) {
				let t = 0;
				const id = setInterval(() => {
					t += 0.18;
					const level = 0.45 + 0.4 * Math.abs(Math.sin(t)) * (0.7 + 0.3 * Math.sin(t * 2.3));
					try {
						cb({ level });
					} catch {
						/* ignore */
					}
				}, 40);
				return () => clearInterval(id);
			}
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

async function newPage(browser, { width, height, mockOpts = {}, bg } = {}) {
	const ctx = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: SCALE,
		colorScheme: "dark",
		locale: "en-US",
	});
	await ctx.addInitScript(installMock, buildMockMap(mockOpts));
	const page = await ctx.newPage();
	if (bg) {
		await page.addInitScript((color) => {
			window.addEventListener("DOMContentLoaded", () => {
				document.documentElement.style.background = color;
				document.body.style.background = color;
			});
		}, bg);
	}
	return { ctx, page };
}

async function stabilize(page, { freeze = true } = {}) {
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	if (freeze) await page.addStyleTag({ content: FREEZE_CSS });
	await page.waitForTimeout(140);
}

const SETTINGS_TABS = [
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

async function openSettings(page, tabIdx) {
	await page.goto(`${BASE}/windows/settings.html`, { waitUntil: "domcontentloaded" });
	await page.getByRole("tab").first().waitFor({ timeout: 15000 });
	await page.getByRole("tab").nth(tabIdx).click();
	await page.waitForTimeout(450);
}

async function clipToPanel(page, name, width, max = 2400) {
	const bottom = await page.evaluate(() => {
		const panel = document.querySelector('[role="tabpanel"]');
		return panel ? Math.ceil(panel.getBoundingClientRect().bottom + 18) : null;
	});
	const height = Math.min(Math.max(bottom ?? 760, 360), max);
	await page.screenshot({
		path: resolve(OUT_DIR, `${name}.png`),
		clip: { x: 0, y: 0, width, height },
	});
	console.log(`  ✓ ${name}.png (${width}x${height})`);
}

async function shootSettingsTab(browser, idx, { name, mockOpts } = {}) {
	const width = 900;
	const { ctx, page } = await newPage(browser, { width, height: 2200, mockOpts });
	await openSettings(page, idx);
	await stabilize(page);
	await clipToPanel(page, name ?? `settings-${SETTINGS_TABS[idx]}`, width);
	await ctx.close();
}

// Element screenshot of a SettingSection located by its heading text.
async function shootSection(browser, { name, tabIdx, heading, mockOpts }) {
	const { ctx, page } = await newPage(browser, { width: 900, height: 2200, mockOpts });
	await openSettings(page, tabIdx);
	await stabilize(page);
	const section = page
		.getByRole("heading", { name, exact: true })
		.first()
		.locator("xpath=ancestor::section[1]");
	// Fallback to a generic section if heading lookup fails.
	const target = (await section.count())
		? section
		: page.locator('[role="tabpanel"] section').first();
	await target.screenshot({ path: resolve(OUT_DIR, `${heading}.png`) });
	console.log(`  ✓ ${heading}.png (section)`);
	await ctx.close();
}

async function shootWindow(
	browser,
	{
		name,
		url,
		width,
		height,
		wait = 700,
		mockOpts,
		bg,
		freeze = true,
		clipBody,
		pillClip,
		clipSelector,
	}
) {
	const { ctx, page } = await newPage(browser, { width, height, mockOpts, bg });
	await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(wait);
	await stabilize(page, { freeze });
	// Tight element capture (no surrounding empty space).
	if (clipSelector) {
		const el = page.locator(clipSelector).first();
		if (await el.count()) {
			await el.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
			console.log(`  ✓ ${name}.png (element)`);
			await ctx.close();
			return;
		}
	}
	let clip;
	if (clipBody) {
		const h = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
		clip = { x: 0, y: 0, width, height: Math.min(h || height, 2200) };
	}
	if (pillClip) {
		// Anchor the crop on the live-transcription text pill; the visualizer
		// capsule sits just below it. Pad generously and center.
		const tb = await page
			.getByText("the quick brown fox", { exact: false })
			.first()
			.boundingBox()
			.catch(() => null);
		if (tb) {
			const x = Math.max(0, tb.x - 30);
			const y = Math.max(0, tb.y - 24);
			clip = {
				x,
				y,
				width: Math.min(width - x, tb.width + 60),
				height: Math.min(height - y, tb.height + 104),
			};
		}
	}
	await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), ...(clip ? { clip } : {}) });
	console.log(`  ✓ ${name}.png`);
	await ctx.close();
}

// Open the main STT model selector dropdown and capture the popup list.
async function shootModelDropdown(browser) {
	const { ctx, page } = await newPage(browser, { width: 940, height: 1040 });
	await openSettings(page, 1); // model tab
	await stabilize(page);
	// Combobox.Trigger isn't role=button; click the visible model-name text so
	// the click bubbles to the trigger.
	await page
		.getByText("Large v3 Turbo", { exact: true })
		.first()
		.click({ timeout: 8000 })
		.catch(() => {});
	await page
		.locator(".select-popup")
		.first()
		.waitFor({ state: "visible", timeout: 5000 })
		.catch(() => {});
	await page.waitForTimeout(400);
	await page.screenshot({ path: resolve(OUT_DIR, "model-dropdown.png") });
	console.log("  ✓ model-dropdown.png");
	await ctx.close();
}

async function run() {
	const argv = process.argv.slice(2);
	const want = (g) => argv.length === 0 || argv.includes("all") || argv.includes(g);
	const browser = await chromium.launch();
	console.log(`Capturing → ${OUT_DIR}`);

	if (want("settings")) {
		console.log("Settings tabs:");
		for (let i = 0; i < SETTINGS_TABS.length; i++) {
			await shootSettingsTab(browser, i).catch((e) =>
				console.error(`  ✗ settings-${SETTINGS_TABS[i]}: ${e.message}`)
			);
		}
	}

	if (want("interactive")) {
		console.log("Interactive:");
		// Recording-mode variants of the General tab (reveal conditional options)
		await shootSettingsTab(browser, 0, {
			name: "settings-general-wakeword",
			mockOpts: { settings: { general: { recordingMode: "wakeword", wakeWord: "alexa" } } },
		}).catch((e) => console.error(`  ✗ general-wakeword: ${e.message}`));
		await shootSettingsTab(browser, 0, {
			name: "settings-general-listen",
			mockOpts: { settings: { general: { recordingMode: "listen", loopbackDeviceIndex: 10 } } },
		}).catch((e) => console.error(`  ✗ general-listen: ${e.message}`));
		// Section figures from the Model tab
		await shootSection(browser, {
			name: "Text-to-Speech",
			heading: "section-tts",
			tabIdx: 1,
			// Verified ElevenLabs key + cloud voices (see mock-data) unlock the
			// Local⇄Cloud switch so the shot shows BOTH sources, not local-only.
			mockOpts: {
				settings: {
					integrations: {
						elevenlabs: {
							apiKey: "sk_demo_elevenlabs_key",
							verified: true,
							lastVerifiedAt: 1_748_000_000_000,
						},
					},
				},
			},
		}).catch((e) => console.error(`  ✗ tts: ${e.message}`));
		await shootSection(browser, {
			name: "LLM Post-Processing",
			heading: "section-llm",
			tabIdx: 1,
		}).catch((e) => console.error(`  ✗ llm: ${e.message}`));
		await shootSection(browser, {
			name: "Realtime Model",
			heading: "section-realtime",
			tabIdx: 1,
		}).catch((e) => console.error(`  ✗ realtime: ${e.message}`));
		// Model selector dropdown
		await shootModelDropdown(browser).catch((e) =>
			console.error(`  ✗ model-dropdown: ${e.message}`)
		);
		// Overlay pill — both layouts, recording state simulated
		await shootWindow(browser, {
			name: "overlay-dynamic-island",
			url: "/windows/overlay.html",
			width: 760,
			height: 220,
			wait: 1300,
			freeze: false,
			bg: "linear-gradient(135deg,#0b0d16,#0a0a0f 60%,#0c1020)",
			mockOpts: { recording: true, settings: { general: { overlayMode: "dynamic-island" } } },
			pillClip: true,
		}).catch((e) => console.error(`  ✗ overlay-island: ${e.message}`));
		await shootWindow(browser, {
			name: "overlay-floating",
			url: "/windows/overlay.html",
			width: 760,
			height: 220,
			wait: 1300,
			freeze: false,
			bg: "linear-gradient(135deg,#0b0d16,#0a0a0f 60%,#0c1020)",
			mockOpts: { recording: true, settings: { general: { overlayMode: "floating-bottom" } } },
			pillClip: true,
		}).catch((e) => console.error(`  ✗ overlay-floating: ${e.message}`));
	}

	if (want("visualizer")) {
		console.log("Visualizer variants (main window):");
		for (const type of ["bar", "grid", "radial", "wave", "aura"]) {
			await shootWindow(browser, {
				name: `visualizer-${type}`,
				url: "/index.html",
				width: 420,
				height: 150,
				wait: 900,
				freeze: false,
				mockOpts: {
					recording: true,
					audioLevel: 0.8,
					settings: { general: { visualizerType: type } },
				},
			}).catch((e) => console.error(`  ✗ visualizer-${type}: ${e.message}`));
		}
	}

	if (want("windows")) {
		console.log("Windows:");
		await shootWindow(browser, {
			name: "main",
			url: "/index.html",
			width: 420,
			height: 150,
			wait: 900,
		});
		await shootWindow(browser, {
			name: "tray-menu",
			url: "/windows/tray-menu.html",
			width: 420,
			height: 520,
			wait: 600,
			clipSelector: "#root > div",
		});
		await shootWindow(browser, {
			name: "onboarding",
			url: "/windows/onboarding.html",
			width: 720,
			height: 560,
			wait: 800,
		});
		await shootWindow(browser, {
			name: "device-picker",
			url: "/windows/device-picker.html",
			width: 420,
			height: 520,
			wait: 700,
			clipSelector: ".overflow-y-auto.rounded-md",
		});
	}

	if (want("sections")) {
		console.log("Focused section crops:");
		// [tabIdx, heading text, output name]
		const SECTIONS = [
			[0, "Recording", "sec-general-recording"],
			[0, "Display", "sec-general-display"],
			[0, "Startup", "sec-general-startup"],
			[1, "Main Model", "sec-model-main"],
			[2, "Input Device", "sec-audio-input"],
			[2, "Output Device", "sec-audio-output"],
			[2, "Hotkey Configuration", "sec-audio-hotkeys"],
			[2, "Advanced", "sec-audio-advanced"],
			[3, "Context awareness", "sec-quality-context"],
			[3, "Formatting", "sec-quality-formatting"],
			[3, "File Transcription", "sec-quality-filetx"],
			[3, "Paste Behavior", "sec-quality-paste"],
			[6, "Overall Stats", "sec-history-stats"],
			[6, "Daily Activity", "sec-history-heatmap"],
			[6, "Transcriptions", "sec-history-table"],
			[6, "Limits & Retention", "sec-history-retention"],
			[7, "External Integrations", "sec-integrations"],
			[8, "Application", "sec-about-app"],
			[8, "License", "sec-about-license"],
		];
		for (const [tabIdx, name, out] of SECTIONS) {
			await shootSection(browser, { name, heading: out, tabIdx }).catch((e) =>
				console.error(`  ✗ ${out}: ${e.message}`)
			);
		}
	}

	await browser.close();
	console.log("Done.");
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
