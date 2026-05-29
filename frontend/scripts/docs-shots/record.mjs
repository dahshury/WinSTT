// Record short looping WEBM clips of the REAL WinSTT components (visualizers,
// overlays) from the live renderer, hydrated via the same mock as the
// screenshot harness. True 1:1 — these are the actual components animating,
// including the WebGL wave/aura shaders. Output → docs/public/demos/.
//
// Usage: bunx vite preview ...  then  node scripts/docs-shots/record.mjs [name ...]

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildMockMap } from "./mock-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../docs/public/demos");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4319";
mkdirSync(OUT, { recursive: true });

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
					t += 0.16;
					// a lively, speech-like envelope so the real visualizers dance
					const lvl = 0.5 + 0.42 * Math.abs(Math.sin(t)) * (0.65 + 0.35 * Math.sin(t * 2.7 + 1));
					try {
						cb({ level: lvl });
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

async function record(browser, { name, url, width, height, mockOpts = {}, bg, seconds = 5 }) {
	const ctx = await browser.newContext({
		viewport: { width, height },
		recordVideo: { dir: OUT, size: { width, height } },
		colorScheme: "dark",
		locale: "en-US",
	});
	await ctx.addInitScript(installMock, buildMockMap(mockOpts));
	if (bg) {
		await ctx.addInitScript((color) => {
			window.addEventListener("DOMContentLoaded", () => {
				document.documentElement.style.background = color;
				document.body.style.background = color;
			});
		}, bg);
	}
	const page = await ctx.newPage();
	await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await page.waitForTimeout(seconds * 1000);
	const video = page.video();
	await ctx.close(); // finalizes the .webm
	if (video) {
		const src = await video.path();
		const dest = resolve(OUT, `${name}.webm`);
		if (existsSync(dest)) rmSync(dest);
		renameSync(src, dest);
		console.log(`  ✓ ${name}.webm`);
	} else {
		console.error(`  ✗ ${name}: no video`);
	}
}

const VIZ = ["bar", "grid", "radial", "wave", "aura"];
const DESK_BG =
	"radial-gradient(120% 120% at 50% 0%, #11142100 0%, #0a0a0f 70%), linear-gradient(135deg,#0c1020,#0a0a0f 60%,#0d1322)";

const SHOTS = {};
for (const v of VIZ) {
	SHOTS[`viz-${v}`] = {
		name: `viz-${v}`,
		url: "/index.html",
		width: 460,
		height: 168,
		seconds: 6,
		mockOpts: {
			recording: true,
			settings: { general: { visualizerType: v, visualizerBarCount: 9 } },
		},
	};
}
// Tight viewports so the pill nearly fills the frame (no empty space).
SHOTS["overlay-floating"] = {
	name: "overlay-floating",
	url: "/windows/overlay.html",
	width: 600,
	height: 112,
	seconds: 6,
	bg: DESK_BG,
	mockOpts: {
		recording: true,
		realtimeText: "the quick brown fox jumps over the lazy dog",
		settings: {
			general: {
				overlayMode: "floating-bottom",
				visualizerSize: "md",
				liveTranscriptionDisplay: "both",
			},
		},
	},
};
SHOTS["overlay-island"] = {
	name: "overlay-island",
	url: "/windows/overlay.html",
	width: 600,
	height: 88,
	seconds: 6,
	bg: DESK_BG,
	mockOpts: {
		recording: true,
		realtimeText: "transcribing your voice in real time",
		settings: {
			general: {
				overlayMode: "dynamic-island",
				visualizerSize: "md",
				liveTranscriptionDisplay: "both",
			},
		},
	},
};
// The real main window (recording, visualizer live) — replaces the dated AppMock on the home.
SHOTS["main"] = {
	name: "main",
	url: "/index.html",
	width: 560,
	height: 200,
	seconds: 6,
	mockOpts: {
		recording: true,
		realtimeText: "the quick brown fox jumps over the lazy dog",
		settings: { general: { visualizerType: "bar", liveTranscriptionDisplay: "both" } },
	},
};

const argv = process.argv.slice(2);
const wanted = argv.length ? argv : Object.keys(SHOTS);
const browser = await chromium.launch();
console.log(`Recording → ${OUT}`);
for (const key of wanted) {
	const shot = SHOTS[key];
	if (!shot) {
		console.error(`  ? unknown: ${key}`);
		continue;
	}
	await record(browser, shot).catch((e) => console.error(`  ✗ ${key}: ${e.message}`));
}
await browser.close();
console.log("Done.");
