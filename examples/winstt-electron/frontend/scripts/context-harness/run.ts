#!/usr/bin/env bun
/**
 * Context-awareness harness — entry point.
 *
 * Drives REAL web apps in YOUR already-logged-in Chrome (via the Chrome
 * DevTools Protocol), seats the caret in each app's reply/compose field, then
 * runs the same native UIA capture dictation uses — producing, per app, a
 * screenshot + the exact snapshot JSON + the exact LLM/ASR prompt strings. This
 * replaces copy-pasting the playground JSON by hand.
 *
 * WHY CDP-to-real-Chrome: uses your real sessions (no re-login), dodges Google/
 * Discord bot-detection, and captures the EXACT accessibility tree dictation
 * sees. See memory/reference_stt_context_awareness_field_survey.md.
 *
 * ── Setup (one time per run) ──────────────────────────────────────────────
 *   1. Fully quit Chrome.
 *   2. Launch it with remote debugging. The `--remote-allow-origins=*` flag is
 *      MANDATORY on Chrome 111+: without it Chrome rejects Playwright's CDP
 *      websocket on the Origin header and connectOverCDP hangs until timeout
 *      (plain HTTP /json works, which makes it look like a Playwright bug — it
 *      isn't). PowerShell:
 *        & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
 *          --remote-debugging-port=9222 --remote-allow-origins=* `
 *          --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
 *      (Using your normal User Data dir keeps you logged into everything; a
 *      dedicated dir like C:\Users\<you>\chrome-debug-profile also works but
 *      starts logged-out the first time.)
 *   3. Make sure you're logged into the apps + have a Discord channel open.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   bun run scripts/context-harness/run.ts             # all registered apps
 *   bun run scripts/context-harness/run.ts gmail       # one app
 *   bun run scripts/context-harness/run.ts gmail discord
 *   CDP_PORT=9333 bun run scripts/context-harness/run.ts
 *
 * Artifacts land in scripts/context-harness/out/<app>/ (gitignored):
 *   screenshot.png · rawSnapshot.json · promptFragment.txt
 *   asrPromptTail.txt · prunedTree.txt   + a top-level summary.json
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { APPS_BY_ID, HARNESS_APPS, type HarnessApp } from "./apps";
import { type CaptureResult, captureApp } from "./capture";

const CDP_PORT = process.env.CDP_PORT ?? "9222";
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const OUT_DIR = path.resolve(import.meta.dirname, "out");
/** Settle time after navigation before we try to focus the compose field. */
const NAV_SETTLE_MS = 2500;

function selectApps(argv: readonly string[]): HarnessApp[] {
	const ids = argv.filter((a) => !a.startsWith("-"));
	if (ids.length === 0) {
		return [...HARNESS_APPS];
	}
	const picked: HarnessApp[] = [];
	for (const id of ids) {
		const app = APPS_BY_ID.get(id);
		if (app) {
			picked.push(app);
		} else {
			process.stderr.write(`  ! unknown app id "${id}" — skipping\n`);
		}
	}
	return picked;
}

function summarize(result: CaptureResult): Record<string, unknown> {
	return {
		id: result.app.id,
		foregroundOk: result.foregroundOk,
		focusMiss: result.focusMiss,
		focusError: result.focusError,
		windowTitle: result.snapshot.windowTitle,
		elementName: result.snapshot.elementName,
		appExe: result.snapshot.appExe ?? "",
		url: result.snapshot.url ?? "",
		promptFragmentChars: result.promptFragment.length,
		asrPromptTailChars: result.asrPromptTail.length,
		prunedTreeChars: result.prunedTree.length,
		hasSelection: Boolean(result.snapshot.selectedText),
		hasClipboard: Boolean(result.snapshot.clipboardText),
	};
}

function focusLabel(result: CaptureResult): string {
	if (result.focusError) {
		return `✗ focus: ${result.focusError}`;
	}
	if (result.focusMiss) {
		return "✗ FOCUS MISS (captured window chrome, not the field)";
	}
	return "✓ focus";
}

function logResult(result: CaptureResult): void {
	const fg = result.foregroundOk ? "✓ foreground" : "✗ FOREGROUND MISMATCH";
	const focus = focusLabel(result);
	process.stdout.write(
		`  ${result.app.label}: ${fg} · ${focus} · ` +
			`fragment=${result.promptFragment.length}c · pruned=${result.prunedTree.length}c · ` +
			`asr=${result.asrPromptTail.length}c\n`
	);
}

async function connect() {
	try {
		return await chromium.connectOverCDP(CDP_ENDPOINT);
	} catch (err) {
		process.stderr.write(
			`\nCould not connect to Chrome at ${CDP_ENDPOINT}.\n` +
				"Launch Chrome with --remote-debugging-port first (see the header of this file).\n" +
				`Underlying error: ${err instanceof Error ? err.message : String(err)}\n`
		);
		process.exit(1);
	}
}

/**
 * Open `url` in a brand-new Chrome WINDOW (not a tab) and return its Playwright
 * page. Each app gets its own window so their tabs can't collide — when two apps
 * shared one window, both `--hwnd` reads hit whichever tab was active, capturing
 * the wrong app. Uses CDP `Target.createTarget({newWindow:true})` (verified
 * available), then resolves the Page via the targetId. Falls back to a plain new
 * tab if the CDP path fails.
 */
async function openInNewWindow(context: BrowserContext, url: string): Promise<Page> {
	const existing = context.pages()[0];
	if (!existing) {
		// No page to host a CDP session — degrade to a normal new tab.
		const tab = await context.newPage();
		await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		return tab;
	}
	const before = new Set(context.pages());
	const session = await context.newCDPSession(existing);
	try {
		await session.send("Target.createTarget", { url, newWindow: true });
	} finally {
		await session.detach().catch(() => {
			// best effort
		});
	}
	// The new window's Page appears asynchronously — poll for the page that
	// wasn't present before createTarget.
	let fresh: Page | undefined;
	for (let i = 0; i < 50 && !fresh; i++) {
		fresh = context.pages().find((pg) => !before.has(pg));
		if (!fresh) {
			// biome-ignore lint: sequential poll for the new page to appear.
			await existing.waitForTimeout(100);
		}
	}
	if (!fresh) {
		throw new Error("new window did not surface a Playwright page");
	}
	await fresh.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {
		// some SPAs never reach a quiet domcontentloaded; the nav-settle covers it
	});
	return fresh;
}

async function captureOne(context: BrowserContext, app: HarnessApp): Promise<CaptureResult> {
	process.stdout.write(`\n▶ ${app.label} — opening ${app.url} in a new window\n`);
	const page = await openInNewWindow(context, app.url);
	try {
		await page.waitForTimeout(NAV_SETTLE_MS);
		const result = await captureApp(page, app, OUT_DIR);
		logResult(result);
		return result;
	} finally {
		await page.close().catch(() => {
			// best-effort — closing the only tab closes the window
		});
	}
}

async function main(): Promise<void> {
	const apps = selectApps(process.argv.slice(2));
	if (apps.length === 0) {
		process.stderr.write("No apps selected.\n");
		process.exit(1);
	}

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	const browser = await connect();
	// Reuse the existing (logged-in) browser context, not a fresh incognito one.
	const context = browser.contexts()[0];
	if (!context) {
		process.stderr.write("Connected to Chrome but it has no open context/window.\n");
		process.exit(1);
	}

	const results: CaptureResult[] = [];
	for (const app of apps) {
		// biome-ignore lint: capture MUST be sequential — only one OS window can be foreground at a time.
		results.push(await captureOne(context, app));
	}

	await writeFile(
		path.join(OUT_DIR, "summary.json"),
		JSON.stringify(results.map(summarize), null, 2),
		"utf8"
	);
	await browser.close().catch(() => {
		// detaching from a CDP-attached browser shouldn't kill the user's Chrome
	});

	const bad = results.filter((r) => !r.foregroundOk);
	process.stdout.write(`\nDone. ${results.length} app(s) captured → ${OUT_DIR}\n`);
	if (bad.length > 0) {
		process.stdout.write(
			`⚠ ${bad.length} had a foreground mismatch (capture may be of the wrong window): ` +
				`${bad.map((r) => r.app.id).join(", ")}\n`
		);
	}
}

main().catch((err) => {
	process.stderr.write(`Harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
