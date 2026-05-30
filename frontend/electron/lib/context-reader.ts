import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
	EMPTY_CONTEXT,
	formatContextForPrompt,
	isDeniedByList,
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
 * Hard timeout for the OCR helper. Heavier than a UIA read (it screenshots
 * the window then runs the on-device OCR model), so it gets more headroom —
 * but still bounded so a non-accessible app can't stall a dictation. Only
 * ever incurred when UIA returned nothing, which is rare.
 */
const OCR_TIMEOUT_MS = 3000;

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

function binaryCandidate(exe: string): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "native", "bin", exe);
	}
	return path.join(import.meta.dirname, "..", "electron", "native", "bin", exe);
}

function resolveHelper(exe: string): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	const candidate = binaryCandidate(exe);
	return existsSync(candidate) ? candidate : null;
}

let cachedBinary: string | null | undefined;

function getBinary(): string | null {
	if (cachedBinary === undefined) {
		cachedBinary = resolveHelper("winstt-context.exe");
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

let cachedOcrBinary: string | null | undefined;

/** OCR helper path (optional last-resort fallback). NULL when the binary
 *  wasn't built (no MSVC/SDK at build time) — callers degrade to UIA-only. */
function getOcrBinary(): string | null {
	if (cachedOcrBinary === undefined) {
		cachedOcrBinary = resolveHelper("winstt-ocr.exe");
		dbg(
			"context",
			cachedOcrBinary
				? `OCR fallback available: ${cachedOcrBinary}`
				: "winstt-ocr.exe not found — OCR fallback disabled (UIA-only)"
		);
	}
	return cachedOcrBinary;
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
	// Attach each caret side independently — never as a pair. Materializing
	// `textBefore: ""` just because `textAfter` is present (or vice-versa)
	// would put an empty key on the snapshot, violating the "attach only
	// when non-empty" invariant the empty-triple shape relies on (a
	// caret-less side stays absent, not present-but-blank).
	const textBefore = asString(parsed.textBefore);
	if (textBefore.length > 0) {
		snapshot.textBefore = textBefore;
	}
	const textAfter = asString(parsed.textAfter);
	if (textAfter.length > 0) {
		snapshot.textAfter = textAfter;
	}
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
/** Below this many chars of element text, an axHtml tree is "contentless" —
 *  structure/chrome only, no real body — and the OCR fallback may run. */
const OCR_CONTENT_THRESHOLD = 40;
/** Inner text between `>` and `<` in the compact axHtml serialization. */
const AX_TEXT_RE = />([^<]+)</g;

function axHtmlTextLength(ax: string): number {
	let total = 0;
	for (const match of ax.matchAll(AX_TEXT_RE)) {
		total += (match[1] ?? "").trim().length;
		if (total >= OCR_CONTENT_THRESHOLD) {
			break;
		}
	}
	return total;
}

/** The three plain-text fields that, if any carries content, mean UIA
 *  exposed usable text and the OCR fallback should be skipped. */
const READABLE_TEXT_FIELDS: readonly (keyof WindowContextSnapshot)[] = [
	"focusedText",
	"textBefore",
	"textAfter",
];

function hasReadableText(snapshot: WindowContextSnapshot): boolean {
	return READABLE_TEXT_FIELDS.some((field) => asString(snapshot[field]).trim().length > 0);
}

/** True when UIA exposed no usable text — empty caret/focused text AND an
 *  axHtml with essentially no element body (the OCR-fallback trigger).
 *  Exported so the context-playground debug tooling can show the same
 *  "would OCR fire here?" verdict the production tree path computes. */
export function snapshotIsContentless(snapshot: WindowContextSnapshot): boolean {
	if (hasReadableText(snapshot)) {
		return false;
	}
	return axHtmlTextLength(snapshot.axHtml ?? "") < OCR_CONTENT_THRESHOLD;
}

/**
 * Spawn the on-device OCR helper (screenshot + Windows.Media.Ocr). Resolves
 * to the recognized text, or "" on any failure / missing binary / non-Windows.
 * Never throws — an empty result just means "no OCR context", which the
 * pipeline handles like any other empty capture.
 */
export function readWindowOcrText(): Promise<string> {
	const binary = getOcrBinary();
	if (!binary) {
		return Promise.resolve("");
	}
	return new Promise((resolve) => {
		execFile(
			binary,
			[],
			{ timeout: OCR_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8" },
			(err, stdout) => {
				if (err) {
					dbg("context", `ocr failed: ${err.message}`);
					resolve("");
					return;
				}
				resolve(String(stdout).trim());
			}
		);
	});
}

/**
 * Tree read for the LLM cleanup path (caret split + foreground UIA tree +
 * browser URL). When `opts.ocrFallback` is set and UIA exposed no readable
 * text (canvas/game/RDP windows), falls back to on-device OCR of the window.
 *
 * The OCR path screenshots the WHOLE window, so it MUST respect the deny-list
 * — checked here, before redaction, because the relay applies the deny-list
 * downstream and a denied app would otherwise be screenshotted anyway.
 */
export async function readWindowContextTree(
	opts: { ocrFallback?: boolean; denyList?: readonly string[] } = {}
): Promise<WindowContextSnapshot> {
	const snapshot = await spawnContextHelper(["--tree"]);
	if (!opts.ocrFallback) {
		return snapshot;
	}
	if (!snapshotIsContentless(snapshot)) {
		return snapshot;
	}
	if (isDeniedByList(snapshot, opts.denyList ?? [])) {
		return snapshot;
	}
	const ocr = await readWindowOcrText();
	if (!ocr) {
		return snapshot;
	}
	dbg("context", `UIA empty — OCR fallback captured ${ocr.length} chars`);
	return { ...snapshot, ocrText: ocr };
}

/** Reset the cached binary paths (both the UIA context helper and the OCR
 *  helper). Test-only. Resetting BOTH lets a test re-exercise either
 *  binary's missing/present resolution branch after a prior call memoised
 *  it. */
export function __resetContextReaderForTesting__(): void {
	cachedBinary = undefined;
	cachedOcrBinary = undefined;
}
