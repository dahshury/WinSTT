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

export { EMPTY_CONTEXT, formatContextForPrompt, type WindowContextSnapshot };

/**
 * Hard timeout for the native helper. The binary has its own internal
 * watchdog at 800ms; this is the outer fence in case the spawn itself
 * stalls (e.g., antivirus inspection of a fresh .exe). 1200ms is short
 * enough to be invisible behind the recording-start latency on a healthy
 * box and long enough to absorb cold-start jitter.
 */
const READ_TIMEOUT_MS = 1200;

/**
 * Cap on raw stdout bytes from the helper. The binary already caps its
 * output, but we re-cap defensively so a runaway never balloons Node's
 * buffer. 64KB is a few orders of magnitude more than the binary should
 * ever produce.
 */
const MAX_BUFFER_BYTES = 64 * 1024;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function parseSnapshot(raw: string): WindowContextSnapshot {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			return EMPTY_CONTEXT;
		}
		return {
			windowTitle: asString(parsed.windowTitle),
			elementName: asString(parsed.elementName),
			focusedText: asString(parsed.focusedText),
		};
	} catch {
		return EMPTY_CONTEXT;
	}
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
 * Read only the user's currently-selected text via UIA TextPattern. Returns
 * a snapshot whose `focusedText` carries the selection (empty if none, or if
 * the focused control doesn't expose TextPattern — e.g., many Chromium /
 * Electron / Slack inputs). Callers should fall back to the clipboard trick
 * when `focusedText` is empty.
 */
export function readWindowSelection(): Promise<WindowContextSnapshot> {
	return spawnContextHelper(["--selection"]);
}

/** Reset the cached binary path. Test-only. */
export function __resetContextReaderForTesting__(): void {
	cachedBinary = undefined;
}
