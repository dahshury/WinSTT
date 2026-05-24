import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
	EMPTY_CONTEXT,
	formatContextForPrompt,
	type WindowContextSnapshot,
} from "./context-snapshot";
import { dbg } from "./debug-log";
import { isPlainObject } from "./ipc-helpers";

export { EMPTY_CONTEXT, formatContextForPrompt, type WindowContextSnapshot };

/**
 * Hard timeout for the native helper. The binary has its own internal
 * watchdog at 750ms (matching Wispr Flow's documented limit); this is
 * the outer fence in case the spawn itself stalls (e.g., antivirus
 * inspection of a fresh .exe). 1200ms is short enough to be invisible
 * behind the recording-start latency on a healthy box and long enough
 * to absorb cold-start jitter on top of the 750ms walk budget.
 */
const READ_TIMEOUT_MS = 1200;

/**
 * Cap on raw stdout bytes from the helper.
 *
 * The legacy modes (default / --selection / --split) emit at most
 * ~10KB. The new `--tree` mode caps axHtml at 150K chars, which after
 * JSON escaping (quotes, newlines, the occasional `\u00xx`) and the
 * surrounding envelope can reach ~600KB worst-case. 1MB gives a safety
 * margin without committing real memory until the spawn actually
 * produces that much output.
 */
const MAX_BUFFER_BYTES = 1024 * 1024;

function getBinaryCandidate(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "native", "bin", "winstt-context.exe");
	}
	return path.join(import.meta.dirname, "..", "electron", "native", "bin", "winstt-context.exe");
}

function resolveBinary(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	const candidate = getBinaryCandidate();
	return existsSync(candidate) ? candidate : null;
}

let cachedBinary: string | null | undefined;

function getBinary(): string | null {
	if (cachedBinary === undefined) {
		cachedBinary = resolveBinary();
		if (cachedBinary) {
			dbg("context", `using ${cachedBinary}`);
		} else {
			dbg(
				"context",
				"winstt-context.exe not found — context awareness will fall back to empty snapshot"
			);
		}
	}
	return cachedBinary;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function parseJsonOrNull(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function attachCaretFields(snapshot: WindowContextSnapshot, parsed: Record<string, unknown>): void {
	const textBefore = asString(parsed.textBefore);
	const textAfter = asString(parsed.textAfter);
	if (textBefore.length === 0 && textAfter.length === 0) {
		return;
	}
	snapshot.textBefore = textBefore;
	snapshot.textAfter = textAfter;
}

function attachIfNonEmpty(
	snapshot: WindowContextSnapshot,
	parsed: Record<string, unknown>,
	field: "appExe" | "url" | "axHtml"
): void {
	const value = asString(parsed[field]);
	if (value.length > 0) {
		snapshot[field] = value;
	}
}

function buildSnapshotFromParsed(parsed: Record<string, unknown>): WindowContextSnapshot {
	// Build the snapshot field-by-field, attaching each optional
	// enrichment only when it carries non-empty content. Keeping the
	// minimum shape exactly 3-field when nothing was captured means
	// `toEqual(EMPTY_CONTEXT)` assertions throughout the test suite
	// stay valid and the deny-list filter can return a redacted
	// snapshot that's indistinguishable from "nothing captured."
	const snapshot: WindowContextSnapshot = {
		windowTitle: asString(parsed.windowTitle),
		elementName: asString(parsed.elementName),
		focusedText: asString(parsed.focusedText),
	};
	attachCaretFields(snapshot, parsed);
	attachIfNonEmpty(snapshot, parsed, "appExe");
	attachIfNonEmpty(snapshot, parsed, "url");
	attachIfNonEmpty(snapshot, parsed, "axHtml");
	return snapshot;
}

function parseSnapshot(raw: string): WindowContextSnapshot {
	const parsed = parseJsonOrNull(raw);
	if (!isPlainObject(parsed)) {
		return EMPTY_CONTEXT;
	}
	return buildSnapshotFromParsed(parsed);
}

/**
 * Spawn the native UIA helper and return the captured snapshot. Always
 * resolves — never throws. Falls back to {@link EMPTY_CONTEXT} on any
 * failure (binary missing, timeout, malformed JSON, non-Windows host).
 *
 * Fire-and-forget at the call site: the snapshot becomes input to the
 * downstream LLM cleanup step, and an empty snapshot just means "no
 * extra hint" — the pipeline degrades cleanly.
 */
function handleExecResult(
	err: Error | null,
	stdout: string | Buffer | undefined
): WindowContextSnapshot {
	if (err) {
		dbg("context", `read failed: ${err.message}`);
		return EMPTY_CONTEXT;
	}
	// `parseSnapshot` already returns `EMPTY_CONTEXT` on any JSON failure
	// (empty input throws SyntaxError, which the catch handles), so we
	// can call it unconditionally without a separate empty-string branch.
	return parseSnapshot(String(stdout).trim());
}

function spawnContextHelper(args: readonly string[]): Promise<WindowContextSnapshot> {
	const binary = getBinary();
	if (!binary) {
		return Promise.resolve(EMPTY_CONTEXT);
	}
	return new Promise((resolve) => {
		execFile(
			binary,
			[...args],
			{
				timeout: READ_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: MAX_BUFFER_BYTES,
				encoding: "utf8",
			},
			(err, stdout) => {
				resolve(handleExecResult(err, stdout));
			}
		);
	});
}

export function readWindowContext(): Promise<WindowContextSnapshot> {
	return spawnContextHelper([]);
}

/**
 * Caret-aware read for the dictation cleanup path. Splits the focused
 * element's text at the caret/selection so the LLM can tell a mid-sentence
 * continuation from a fresh line. Falls back internally (in the native
 * helper) to the whole-text read when the focused control exposes no
 * TextPattern caret, so the returned snapshot is always usable.
 */
export function readWindowContextSplit(): Promise<WindowContextSnapshot> {
	return spawnContextHelper(["--split"]);
}

/**
 * Read only the user's currently-selected text via UIA TextPattern. Returns
 * a snapshot whose `focusedText` carries the selection (empty if none, or if
 * the focused control doesn't expose TextPattern — e.g., many Chromium /
 * Electron / Slack inputs). Callers should fall back to the clipboard trick
 * when `focusedText` is empty.
 */
export function readWindowSelection(): Promise<WindowContextSnapshot> {
	return spawnContextHelper(["--selection"]);
}

/**
 * Wispr-style full read: caret split + foreground window UIA tree
 * (axHtml) + browser URL (omnibox/urlbar) + process exe. This is the
 * snapshot the LLM cleanup uses when `general.contextAwareness` is on
 * and you want the strongest "reply to this email" behaviour.
 *
 * Compared to `readWindowContextSplit`, the tree path is slower
 * (bounded at 750ms) and emits significantly more data — up to 150K
 * chars of axHtml. The relay's deny-list filter strips the heavy
 * fields before they reach the LLM when the user has flagged the app.
 */
export function readWindowContextTree(): Promise<WindowContextSnapshot> {
	return spawnContextHelper(["--tree"]);
}

/** Reset the cached binary path. Test-only. */
export function __resetContextReaderForTesting__(): void {
	cachedBinary = undefined;
}
