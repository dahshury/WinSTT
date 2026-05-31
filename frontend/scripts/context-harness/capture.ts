/**
 * Core capture primitive for the context-awareness harness.
 *
 * Given a Playwright `Page` (already navigated + with the caret seated in the
 * reply/compose field), this:
 *   1. brings the Chrome window to the OS foreground,
 *   2. runs the SAME native helper dictation uses (`winstt-context.exe --tree`
 *      and `--selection`) so the captured snapshot is byte-for-byte what the
 *      relay would feed the LLM,
 *   3. screenshots the page,
 *   4. assembles a `WindowContextSnapshot` and runs the REAL pure consumers
 *      (`formatContextForPrompt`, `extractAsrPromptTail`, `pruneAxHtmlForLlm`)
 *      so the artifact shows precisely what the model sees.
 *
 * No electron import: the harness spawns the .exe directly and imports only the
 * electron-free pure modules — so it runs under plain `bun`. Clipboard is read
 * via PowerShell (the relay uses electron's clipboard, unavailable here; it's
 * the lowest-signal field and not what we're tuning).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { pruneAxHtmlForLlm } from "../../electron/lib/ax-prune";
import {
	extractAsrPromptTail,
	formatContextForPrompt,
	type WindowContextSnapshot,
} from "../../electron/lib/context-snapshot";
import type { HarnessApp } from "./apps";

const execFileAsync = promisify(execFile);

/** Repo-relative path to the native UIA helper (dev tree, not packaged). */
const CONTEXT_EXE = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"electron",
	"native",
	"bin",
	"winstt-context.exe"
);

const EXE_TIMEOUT_MS = 5000;
/** Settle time after activating the tab so the page title + UIA tree stabilise. */
const TAB_SETTLE_MS = 600;
/** PowerShell helper: Chrome window TITLE substring → its HWND (decimal),
 *  restricted to chrome.exe and using EnumWindows (z-order-independent) so it
 *  resolves the window even when it's OCCLUDED behind the IDE/terminal. A
 *  point-based lookup (WindowFromPoint) can't — it returns whatever window is
 *  topmost at the pixel. winstt-context.exe --hwnd then reads that exact window
 *  with NO OS-foreground forcing. */
const RESOLVE_HWND_PS1 = path.join(import.meta.dirname, "resolve-hwnd.ps1");

export interface CaptureResult {
	readonly app: HarnessApp;
	/** What `extractAsrPromptTail` produces — the Whisper bias tail. */
	readonly asrPromptTail: string;
	/** Set when the `focus()` recipe threw (capture still ran, sans focus). */
	readonly focusError: string | null;
	/** True when the foreground window matched the app (capture is trustworthy). */
	readonly foregroundOk: boolean;
	/** True when focus didn't land in a real field — UIA reported the window /
	 *  document itself as the focused element (elementName === windowTitle) or the
	 *  DOM never confirmed focus in the compose box. The capture is then page
	 *  chrome, not the compose surface. */
	readonly focusMiss: boolean;
	/** What `formatContextForPrompt` produces — the LLM cleanup fragment. */
	readonly promptFragment: string;
	/** The Tier-3 pruned tree (empty when the pruner declined). */
	readonly prunedTree: string;
	/** The raw snapshot exactly as assembled from the native helper(s). */
	readonly snapshot: WindowContextSnapshot;
}

function parseSnapshotJson(stdout: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(stdout.trim());
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function runContextExe(args: readonly string[]): Promise<Record<string, unknown>> {
	try {
		const { stdout } = await execFileAsync(CONTEXT_EXE, [...args], {
			timeout: EXE_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8",
		});
		return parseSnapshotJson(stdout);
	} catch (err) {
		process.stderr.write(
			`  ! context exe ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}\n`
		);
		return {};
	}
}

/** Read the clipboard via PowerShell (electron's clipboard is unavailable in a
 *  plain bun script). Best-effort — empty on any failure. */
async function readClipboard(): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-Command", "Get-Clipboard -Raw"],
			{ timeout: 3000, windowsHide: true, encoding: "utf8" }
		);
		return stdout.trim();
	} catch {
		return "";
	}
}

function buildSnapshot(
	tree: Record<string, unknown>,
	selectionFocusedText: string,
	clipboardText: string
): WindowContextSnapshot {
	const snapshot: WindowContextSnapshot = {
		windowTitle: asString(tree.windowTitle),
		elementName: asString(tree.elementName),
		focusedText: asString(tree.focusedText),
	};
	const optional: (keyof WindowContextSnapshot)[] = [
		"textBefore",
		"textAfter",
		"appExe",
		"url",
		"axHtml",
	];
	for (const key of optional) {
		const value = asString(tree[key]);
		if (value.length > 0) {
			snapshot[key] = value;
		}
	}
	if (selectionFocusedText.trim().length > 0) {
		snapshot.selectedText = selectionFocusedText.trim();
	}
	if (clipboardText.trim().length > 0) {
		snapshot.clipboardText = clipboardText.trim();
	}
	return snapshot;
}

/**
 * Resolve the OS HWND of the page's Chrome window by matching its title within
 * the chrome.exe process (z-order-independent — works while occluded). The tab
 * was just activated (bringToFront), so the Chrome window title equals
 * "<document.title> - Google Chrome"; we match a distinctive slice of
 * document.title. Returns the decimal HWND, or "" on any failure (caller then
 * omits --hwnd and the exe falls back to the foreground window).
 */
async function resolveChromeHwnd(page: Page, expectTitleIncludes: string): Promise<string> {
	const docTitle = (await page.title().catch(() => "")).trim();
	// A 40-char slice of the live tab title is specific enough to pick THIS
	// window over other Chrome windows; fall back to the app's expect-substring.
	const titleLike = docTitle.length >= 4 ? docTitle.slice(0, 40) : expectTitleIncludes;
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESOLVE_HWND_PS1, "-TitleLike", titleLike],
			{ timeout: 6000, windowsHide: true, encoding: "utf8" }
		);
		const out = stdout.trim();
		return out === "NO_MATCH" ? "" : out;
	} catch (err) {
		process.stderr.write(
			`  ! resolve-hwnd failed: ${err instanceof Error ? err.message : String(err)}\n`
		);
		return "";
	}
}

/** Drive `app.focus`, tolerating failure (recorded, not fatal). */
async function tryFocus(page: Page, app: HarnessApp): Promise<string | null> {
	try {
		await app.focus(page);
		await page.waitForTimeout(300);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Re-seat + verify DOM focus in the app's compose field immediately before the
 * native UIA read. The navigation recipe's focus is sometimes lost to a
 * re-render / tab re-activation by capture time (the recurring "captured the
 * inbox/timeline instead of the reply box" symptom), so we re-click the compose
 * selector and confirm `document.activeElement` actually matches it. Returns
 * true when the compose field holds focus. Best-effort — never throws.
 */
async function ensureComposeFocused(page: Page, selector: string): Promise<boolean> {
	const isFocused = () =>
		page
			.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)
			.catch(() => false);
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await isFocused()) {
			return true;
		}
		const loc = page.locator(selector).first();
		await loc.click({ force: true }).catch(() => {
			// selector absent (not logged in / layout differs) — loop reports the miss
		});
		// Lexical/Draft editors (FB Messenger, WhatsApp) don't reliably take focus
		// from a click alone — call the DOM focus() too.
		await loc.focus().catch(() => {});
		await page.waitForTimeout(350);
	}
	return await isFocused();
}

/**
 * Capture one app end-to-end and write its artifacts to `<outDir>/<app.id>/`.
 * Returns the structured result for the run summary.
 */
export async function captureApp(
	page: Page,
	app: HarnessApp,
	outDir: string
): Promise<CaptureResult> {
	const appDir = path.join(outDir, app.id);
	await mkdir(appDir, { recursive: true });

	// Activate the tab BEFORE focusing: a background tab is throttled by Chrome,
	// so heavy SPAs (Gmail) render empty and clicks fail actionability. This is
	// in-process tab activation (reliable), distinct from OS foreground.
	await page.bringToFront();
	await page.waitForTimeout(400);

	const focusError = await tryFocus(page, app);
	// Resolve the Chrome window's HWND so the native helper targets it directly.
	await page.bringToFront();
	await page.waitForTimeout(TAB_SETTLE_MS);
	const hwnd = await resolveChromeHwnd(page, app.expectWindowTitleIncludes);

	// Screenshot via CDP (captures the live page regardless of OS focus).
	await page.screenshot({ path: path.join(appDir, "screenshot.png"), fullPage: false });

	// Re-seat the caret in the compose field RIGHT before the UIA read — the
	// navigation recipe's focus can be lost to a re-render / tab re-activation by
	// now (the "captured window chrome instead of the field" flake).
	const domFocused = await ensureComposeFocused(page, app.composeSelector);

	// Native captures + clipboard, mirroring the relay's enriched tree read.
	// `--hwnd <handle>` scopes the UIA walk to the resolved Chrome window, so it
	// reads that window even though the TERMINAL owns OS focus.
	const hwndArgs = hwnd ? ["--hwnd", hwnd] : [];
	const tree = await runContextExe(["--tree", ...hwndArgs]);
	const selection = await runContextExe(["--selection", ...hwndArgs]);
	const clipboardText = await readClipboard();
	const snapshot = buildSnapshot(tree, asString(selection.focusedText), clipboardText);

	const promptFragment = formatContextForPrompt(snapshot);
	const asrPromptTail = extractAsrPromptTail(snapshot);
	const prunedTree = pruneAxHtmlForLlm(snapshot.axHtml);

	// Trustworthy when a HWND was resolved AND the captured window title matches.
	const foregroundOk =
		hwnd.length > 0 &&
		snapshot.windowTitle.toLowerCase().includes(app.expectWindowTitleIncludes.toLowerCase());
	// Focus miss: the DOM never confirmed focus in the compose field, OR UIA
	// reported the window/document itself as the focused element (elementName
	// blank or === windowTitle) — either way the capture is page chrome, not the
	// reply surface, so the run should flag it instead of a false ✓.
	const elementName = snapshot.elementName.trim();
	const focusMiss =
		!domFocused || elementName.length === 0 || elementName === snapshot.windowTitle.trim();

	// Artifacts: the screenshot + the exact JSON + the exact strings the models
	// see, so analysis (mine or a subagent's) needs nothing else.
	await writeFile(path.join(appDir, "rawSnapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
	await writeFile(path.join(appDir, "promptFragment.txt"), promptFragment, "utf8");
	await writeFile(path.join(appDir, "asrPromptTail.txt"), asrPromptTail, "utf8");
	await writeFile(path.join(appDir, "prunedTree.txt"), prunedTree, "utf8");

	return {
		app,
		snapshot,
		promptFragment,
		asrPromptTail,
		prunedTree,
		foregroundOk,
		focusMiss,
		focusError,
	};
}
