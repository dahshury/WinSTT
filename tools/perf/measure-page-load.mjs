#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const DEFAULT_PAGES = [
	{ name: "main", path: "/" },
	{ name: "settings", path: "/windows/settings.html" },
	{ name: "overlay", path: "/windows/overlay.html" },
	{ name: "tray-menu", path: "/windows/tray-menu.html" },
	{ name: "model-picker", path: "/windows/model-picker.html" },
	{ name: "device-picker", path: "/windows/device-picker.html" },
	{ name: "onboarding", path: "/windows/onboarding.html" },
	{ name: "history", path: "/windows/history.html" },
	{ name: "context-playground", path: "/windows/context-playground.html" },
];

function parseArgs(argv) {
	const args = {
		base: "http://127.0.0.1:4173",
		budget: 50,
		browserExecutable: null,
		runs: 9,
		warmup: 2,
		json: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") {
			args.json = true;
			continue;
		}
		if (arg === "--base") {
			args.base = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--budget") {
			args.budget = Number(requireValue(argv, ++i, arg));
			continue;
		}
		if (arg === "--browser-executable") {
			args.browserExecutable = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--runs") {
			args.runs = Number(requireValue(argv, ++i, arg));
			continue;
		}
		if (arg === "--warmup") {
			args.warmup = Number(requireValue(argv, ++i, arg));
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isFinite(args.budget) || args.budget <= 0) {
		throw new Error("--budget must be a positive number");
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isInteger(args.warmup) || args.warmup < 0) {
		throw new Error("--warmup must be a non-negative integer");
	}
	if (args.warmup >= args.runs) {
		throw new Error("--warmup must be smaller than --runs");
	}
	return args;
}

function requireValue(argv, index, flag) {
	const value = argv[index];
	if (value == null || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function percentile(values, p) {
	const sorted = values.toSorted((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index];
}

function rounded(value) {
	return Math.round(value * 10) / 10;
}

function browserCandidates() {
	const localAppData = process.env.LOCALAPPDATA;
	const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
	const programFilesX86 =
		process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
	return [
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		process.env.CHROME_PATH,
		localAppData
			? join(
					localAppData,
					"ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe",
				)
			: null,
		localAppData
			? join(
					localAppData,
					"ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe",
				)
			: null,
		localAppData
			? join(
					localAppData,
					"ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe",
				)
			: null,
		join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
		join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
		join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
		join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
	].filter(Boolean);
}

function findBrowserExecutable() {
	return browserCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

async function launchBrowser(preferredExecutable) {
	if (preferredExecutable) {
		return {
			browser: await chromium.launch({
				executablePath: preferredExecutable,
				headless: true,
			}),
			executablePath: preferredExecutable,
		};
	}
	try {
		return {
			browser: await chromium.launch({ headless: true }),
			executablePath: "playwright-bundled-chromium",
		};
	} catch (error) {
		const fallback = findBrowserExecutable();
		if (!fallback) {
			throw error;
		}
		console.error(
			`Playwright bundled Chromium is unavailable; using ${fallback}`,
		);
		return {
			browser: await chromium.launch({
				executablePath: fallback,
				headless: true,
			}),
			executablePath: fallback,
		};
	}
}

function summarize(samples, warmup) {
	const measured = samples.slice(warmup);
	const appReady = measured.map((sample) => sample.appReadyMs);
	const fcp = measured
		.map((sample) => sample.fcpMs)
		.filter((value) => Number.isFinite(value));
	return {
		appReadyMedianMs: rounded(percentile(appReady, 50)),
		appReadyP75Ms: rounded(percentile(appReady, 75)),
		appReadyMaxMs: rounded(Math.max(...appReady)),
		fcpMedianMs: fcp.length > 0 ? rounded(percentile(fcp, 50)) : null,
		samples: measured.map((sample) => ({
			appReadyMs: rounded(sample.appReadyMs),
			domContentLoadedMs: rounded(sample.domContentLoadedMs),
			loadMs: rounded(sample.loadMs),
			fcpMs: Number.isFinite(sample.fcpMs) ? rounded(sample.fcpMs) : null,
		})),
	};
}

function installRootReadyProbe() {
	window.__winsttPageLoad = {
		rootReadyMs: null,
	};

	const markReady = () => {
		const state = window.__winsttPageLoad;
		if (!state || state.rootReadyMs !== null) {
			return;
		}
		state.rootReadyMs = performance.now();
	};

	const isRootReady = () => {
		const root = document.getElementById("root");
		return root != null && root.childNodes.length > 0;
	};

	const observe = () => {
		if (isRootReady()) {
			markReady();
			return;
		}
		const root = document.getElementById("root");
		const target = root ?? document.documentElement;
		const observer = new MutationObserver(() => {
			if (isRootReady()) {
				markReady();
				observer.disconnect();
			}
		});
		observer.observe(target, { childList: true, subtree: true });
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", observe, { once: true });
	} else {
		observe();
	}
}

async function measurePage(browser, base, pageDef) {
	const context = await browser.newContext({
		colorScheme: "light",
		deviceScaleFactor: 1,
		locale: "en-US",
		reducedMotion: "reduce",
		timezoneId: "UTC",
		viewport: { width: 1280, height: 800 },
	});
	const page = await context.newPage();
	const client = await context.newCDPSession(page);
	await client.send("Network.enable");
	await client.send("Network.setCacheDisabled", { cacheDisabled: true });
	await page.addInitScript(installRootReadyProbe);

	const url = new URL(pageDef.path, base).toString();
	try {
		await page.goto(url, { waitUntil: "load", timeout: 15_000 });
		await page.waitForFunction(
			() => window.__winsttPageLoad?.rootReadyMs !== null,
			{ timeout: 10_000 },
		);
		await page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => resolve())),
		);
		const metrics = await page.evaluate(() => {
			const nav = performance.getEntriesByType("navigation")[0];
			const paint = performance.getEntriesByName("first-contentful-paint")[0];
			const rootReadyMs = window.__winsttPageLoad?.rootReadyMs;
			return {
				appReadyMs:
					typeof rootReadyMs === "number"
						? rootReadyMs
						: nav?.loadEventEnd ?? performance.now(),
				domContentLoadedMs: nav?.domContentLoadedEventEnd ?? 0,
				loadMs: nav?.loadEventEnd ?? 0,
				fcpMs: paint?.startTime ?? Number.NaN,
			};
		});
		return metrics;
	} finally {
		await context.close();
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { browser, executablePath } = await launchBrowser(args.browserExecutable);
	const startedAt = new Date().toISOString();
	const results = [];
	try {
		for (const pageDef of DEFAULT_PAGES) {
			const samples = [];
			for (let run = 0; run < args.runs; run += 1) {
				samples.push(await measurePage(browser, args.base, pageDef));
			}
			const summary = summarize(samples, args.warmup);
			results.push({ ...pageDef, ...summary });
		}
	} finally {
		await browser.close();
	}

	const failed = results.filter(
		(result) => result.appReadyMedianMs > args.budget,
	);
	const payload = {
		startedAt,
		base: args.base,
		budgetMs: args.budget,
		browserExecutable: executablePath,
		runs: args.runs,
		warmup: args.warmup,
		metric: "navigationStart to first #root DOM commit; cache disabled; 1280x800; reduced motion; UTC; en-US",
		results,
		passed: failed.length === 0,
	};

	if (args.json) {
		console.log(JSON.stringify(payload, null, 2));
	} else {
		console.log(
			`Page-load metric: ${payload.metric}\nRuns: ${args.runs} (${args.warmup} warmup), budget: ${args.budget} ms\n`,
		);
		console.table(
			results.map((result) => ({
				page: result.name,
				median: result.appReadyMedianMs,
				p75: result.appReadyP75Ms,
				max: result.appReadyMaxMs,
				fcp: result.fcpMedianMs,
				pass: result.appReadyMedianMs <= args.budget,
			})),
		);
	}

	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
