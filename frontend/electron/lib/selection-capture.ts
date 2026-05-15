import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, clipboard } from "electron";
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

function resolvePasteBinary(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	const candidate = app.isPackaged
		? path.join(process.resourcesPath, "native", "bin", "winstt-paste.exe")
		: path.join(import.meta.dirname, "..", "electron", "native", "bin", "winstt-paste.exe");
	return existsSync(candidate) ? candidate : null;
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
		dbg("selection", `clipboard read failed: ${(err as Error).message}`);
		return "";
	}
}

function writeClipboardSafe(text: string): void {
	try {
		clipboard.writeText(text);
	} catch (err) {
		dbg("selection", `clipboard write failed: ${(err as Error).message}`);
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

/**
 * Poll the clipboard until it changes from `original` or the timeout
 * elapses. Returns the new value (or `original` if nothing happened).
 */
async function waitForClipboardChange(original: string): Promise<string> {
	const deadline = Date.now() + CLIPBOARD_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = readClipboardSafe();
		if (current !== original && current.length > 0) {
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
export async function captureSelection(): Promise<SelectionSnapshot> {
	// Fast path: UIA TextPattern selection. Reliable in Word, Notepad,
	// Edge / Firefox URL bar, modern .NET controls. Fails silently in
	// Chromium-based renderers (Slack, Discord, VS Code) and most
	// Electron apps unless accessibility is force-enabled.
	const uiaSnapshot = await readWindowSelection();
	const uiaText = uiaSnapshot.focusedText.trim();
	if (uiaText.length > 0) {
		dbg("selection", `UIA selection: ${uiaText.length} chars`);
		return { text: uiaText, source: "uia", originalClipboard: null };
	}

	// Fallback: clipboard-copy trick. Save current clipboard so the caller
	// can restore it after a successful paste-replace.
	const originalClipboard = readClipboardSafe();
	await sendCopyKeystroke();
	const captured = await waitForClipboardChange(originalClipboard);
	if (!captured || captured === originalClipboard) {
		dbg("selection", "clipboard fallback returned no new selection");
		// Restore the clipboard since we polluted nothing useful.
		if (originalClipboard) {
			writeClipboardSafe(originalClipboard);
		}
		return EMPTY_SELECTION;
	}
	dbg("selection", `clipboard selection: ${captured.length} chars`);
	return {
		text: captured,
		source: "clipboard",
		originalClipboard,
	};
}

/** Reset cached binary path. Test-only. */
export function __resetSelectionCaptureForTesting__(): void {
	cachedPasteBinary = undefined;
}
