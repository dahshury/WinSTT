import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, clipboard } from "electron";
import { getErrorMessage } from "../../src/shared/lib/errors";
import { readWindowSelection } from "./context-reader";
import { dbg } from "./debug-log";

/**
 * Snapshot of the user's selected text immediately before a Transform fires.
 *
 * `source` tells the caller whether the read came from a clean UIA path
 * (`"uia"` — leaves the user's clipboard untouched) or from the clipboard
 * trick (`"clipboard"` — the user's clipboard now holds the captured
 * selection, which is also fine: after the transform the result will
 * occupy the clipboard anyway when we paste it back).
 *
 * `originalClipboard` is captured up front in the clipboard path so the
 * caller can choose to restore it after pasting. We only return it from
 * the clipboard path because UIA reads don't disturb the clipboard.
 */
export interface SelectionSnapshot {
	originalClipboard: string | null;
	source: "uia" | "clipboard" | "empty";
	text: string;
}

export const EMPTY_SELECTION: SelectionSnapshot = {
	text: "",
	source: "empty",
	originalClipboard: null,
};

/** How long we wait for the clipboard to update after SendInput Ctrl+C. */
const CLIPBOARD_POLL_TIMEOUT_MS = 700;
/** Polling interval — fast enough to feel instant, slow enough that we don't
 *  burn CPU when the app is slow to populate the clipboard. */
const CLIPBOARD_POLL_INTERVAL_MS = 25;
/** Hard ceiling on the paste-binary spawn used to emit Ctrl+C. */
const COPY_SPAWN_TIMEOUT_MS = 2000;

/** Absolute path the paste binary would live at, ignoring whether it exists. */
function pasteBinaryCandidate(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "native", "bin", "winstt-paste.exe");
	}
	return path.join(import.meta.dirname, "..", "electron", "native", "bin", "winstt-paste.exe");
}

function resolvePasteBinary(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	const candidate = pasteBinaryCandidate();
	if (existsSync(candidate)) {
		return candidate;
	}
	return null;
}

let cachedPasteBinary: string | null | undefined;
function getPasteBinary(): string | null {
	if (cachedPasteBinary === undefined) {
		cachedPasteBinary = resolvePasteBinary();
	}
	return cachedPasteBinary;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function readClipboardSafe(): string {
	try {
		return clipboard.readText() ?? "";
	} catch (err) {
		dbg("selection", `clipboard read failed: ${getErrorMessage(err)}`);
		return "";
	}
}

function writeClipboardSafe(text: string): void {
	try {
		clipboard.writeText(text);
	} catch (err) {
		dbg("selection", `clipboard write failed: ${getErrorMessage(err)}`);
	}
}

/**
 * Spawn winstt-paste.exe with `--copy`. Returns when the binary exits or
 * after a hard timeout. We don't gate this through the paste-lib's serial
 * queue: a transform's Ctrl+C is paired with a Ctrl+V that the paste-lib
 * serializes on its own.
 */
function sendCopyKeystroke(): Promise<void> {
	const binary = getPasteBinary();
	if (!binary) {
		dbg("selection", "paste binary not found; cannot send Ctrl+C");
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		execFile(binary, ["--copy"], { timeout: COPY_SPAWN_TIMEOUT_MS, windowsHide: true }, (err) => {
			if (err) {
				dbg("selection", `Ctrl+C spawn error: ${err.message}`);
			}
			resolve();
		});
	});
}

/** True when `current` is a usable new clipboard value (changed + non-empty). */
function isFreshClipboard(current: string, original: string): boolean {
	return current !== original && current.length > 0;
}

/**
 * Poll the clipboard until it changes from `original` or the timeout
 * elapses. Returns the new value (or `original` if nothing happened).
 */
async function waitForClipboardChange(original: string): Promise<string> {
	const deadline = Date.now() + CLIPBOARD_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = readClipboardSafe();
		if (isFreshClipboard(current, original)) {
			return current;
		}
		// react-doctor-disable-next-line async-await-in-loop
		await sleep(CLIPBOARD_POLL_INTERVAL_MS);
	}
	return readClipboardSafe();
}

/**
 * Capture the user's currently-selected text. Tries UIA TextPattern first
 * (no clipboard side effects); on empty result, falls back to simulating
 * Ctrl+C and reading the new clipboard contents. Always resolves — never
 * throws. An empty selection resolves to {@link EMPTY_SELECTION}.
 */
/**
 * Fast path: UIA TextPattern selection. Reliable in Word, Notepad,
 * Edge / Firefox URL bar, modern .NET controls. Fails silently in
 * Chromium-based renderers (Slack, Discord, VS Code) and most
 * Electron apps unless accessibility is force-enabled. Returns `null`
 * when UIA yields no usable selection so the caller falls back.
 */
async function tryUiaSelection(): Promise<SelectionSnapshot | null> {
	const uiaSnapshot = await readWindowSelection();
	const uiaText = uiaSnapshot.focusedText.trim();
	if (uiaText.length === 0) {
		return null;
	}
	dbg("selection", `UIA selection: ${uiaText.length} chars`);
	return { text: uiaText, source: "uia", originalClipboard: null };
}

/** True when the clipboard never picked up a fresh selection. */
function clipboardCaptureFailed(captured: string, original: string): boolean {
	return !captured || captured === original;
}

/**
 * Fallback: clipboard-copy trick. Saves the current clipboard so the
 * caller can restore it after a successful paste-replace, simulates
 * Ctrl+C, then waits for the clipboard to change.
 */
async function captureViaClipboard(): Promise<SelectionSnapshot> {
	const originalClipboard = readClipboardSafe();
	await sendCopyKeystroke();
	const captured = await waitForClipboardChange(originalClipboard);
	if (clipboardCaptureFailed(captured, originalClipboard)) {
		dbg("selection", "clipboard fallback returned no new selection");
		// Restore the clipboard since we polluted nothing useful.
		restoreClipboard(originalClipboard);
		return EMPTY_SELECTION;
	}
	dbg("selection", `clipboard selection: ${captured.length} chars`);
	return { text: captured, source: "clipboard", originalClipboard };
}

/** Write `original` back to the clipboard if it held something. */
function restoreClipboard(original: string): void {
	if (original) {
		writeClipboardSafe(original);
	}
}

export async function captureSelection(): Promise<SelectionSnapshot> {
	const uia = await tryUiaSelection();
	if (uia) {
		return uia;
	}
	return captureViaClipboard();
}

/** Reset cached binary path. Test-only. */
export function __resetSelectionCaptureForTesting__(): void {
	cachedPasteBinary = undefined;
}

/** Pure helpers exposed for direct branch-coverage in tests only. */
export const __test_isFreshClipboard = isFreshClipboard;
export const __test_clipboardCaptureFailed = clipboardCaptureFailed;
export const __test_resolvePasteBinary = resolvePasteBinary;
export const __test_readClipboardSafe = readClipboardSafe;
export const __test_pasteBinaryCandidate = pasteBinaryCandidate;
