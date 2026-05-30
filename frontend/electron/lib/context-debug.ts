import type {
	ContextDebugReport,
	ContextMetrics,
	ContextModeResult,
	ContextSnapshotView,
} from "../../src/shared/api/context-debug-types";
import {
	readWindowContext,
	readWindowContextSplit,
	readWindowContextTree,
	readWindowSelection,
	snapshotIsContentless,
} from "./context-reader";
import {
	extractAsrPromptTail,
	formatContextForPrompt,
	isDeniedByList,
	isIdeContext,
	looksLikeTerminal,
	redactSensitiveFields,
	type WindowContextSnapshot,
} from "./context-snapshot";
import { sanitiseContextTail } from "./initial-prompt";

/**
 * Debug-only analysis layer for the context-awareness playground.
 *
 * Assembles a {@link ContextDebugReport} that mirrors EXACTLY what dictation's
 * context-awareness pulls and feeds the model:
 *   - the production-faithful primary capture
 *     (`readWindowContextTree({ ocrFallback, denyList })` — the same call
 *     `relay.ts` makes),
 *   - the deny-list verdict + redaction,
 *   - the LLM cleanup fragment (`formatContextForPrompt`),
 *   - the Whisper ASR prompt tail (`extractAsrPromptTail`),
 *   - and, on a "deep" capture, the raw output of all four UIA modes
 *     side-by-side so the user can see what each extraction strategy sees.
 *
 * This module is purely additive — it reuses the production helpers rather than
 * re-implementing them, so the report can't drift from real behaviour.
 */

/** Mirrors `MAX_AXHTML_CHARS` in `electron/native/src/winstt-context.c`. */
const AXHTML_CAP = 150_000;

export interface CaptureContextDebugOptions {
	/** Mirror of `general.contextAwareness` — surfaced in the report, doesn't gate capture. */
	contextAwarenessEnabled: boolean;
	/** When true, also run --split / default / --selection for the comparison panel. */
	deep: boolean;
	/** The user's `general.contextDenyList`. */
	denyList: readonly string[];
}

function trimmedLen(value: string | undefined): number {
	return (value ?? "").trim().length;
}

/** True when any field carries non-whitespace content — the "this mode got something" signal. */
function snapshotHasContent(snapshot: WindowContextSnapshot): boolean {
	return (
		trimmedLen(snapshot.windowTitle) > 0 ||
		trimmedLen(snapshot.elementName) > 0 ||
		trimmedLen(snapshot.focusedText) > 0 ||
		trimmedLen(snapshot.textBefore) > 0 ||
		trimmedLen(snapshot.textAfter) > 0 ||
		trimmedLen(snapshot.axHtml) > 0 ||
		trimmedLen(snapshot.url) > 0 ||
		trimmedLen(snapshot.ocrText) > 0
	);
}

function hasCaret(snapshot: WindowContextSnapshot): boolean {
	return (snapshot.textBefore?.length ?? 0) > 0 || (snapshot.textAfter?.length ?? 0) > 0;
}

/** The first deny-list pattern that matches the snapshot, or null. Reuses the
 *  production matcher one pattern at a time so the reason can't diverge. */
function firstDenyMatch(
	snapshot: WindowContextSnapshot,
	denyList: readonly string[]
): string | null {
	for (const pattern of denyList) {
		if (isDeniedByList(snapshot, [pattern])) {
			return pattern;
		}
	}
	return null;
}

function buildMetrics(
	raw: WindowContextSnapshot,
	promptFragment: string,
	denyList: readonly string[]
): ContextMetrics {
	return {
		axHtmlCap: AXHTML_CAP,
		axHtmlChars: raw.axHtml?.length ?? 0,
		denyListSize: denyList.length,
		focusedTextChars: raw.focusedText.length,
		promptFragmentChars: promptFragment.length,
		textAfterChars: raw.textAfter?.length ?? 0,
		textBeforeChars: raw.textBefore?.length ?? 0,
	};
}

/** Time a single helper-mode spawn and wrap it as a {@link ContextModeResult}. */
async function captureMode(
	mode: ContextModeResult["mode"],
	read: () => Promise<WindowContextSnapshot>
): Promise<ContextModeResult> {
	const start = Date.now();
	const snapshot = await read();
	return {
		durationMs: Date.now() - start,
		mode,
		ok: snapshotHasContent(snapshot),
		snapshot,
	};
}

/**
 * The native-helper read functions, injectable so the colocated test can drive
 * the analysis with fake snapshots — no module mocking (which leaks across bun
 * test files). Production passes {@link DEFAULT_READERS}; matches the
 * dependency-injection pattern in `relay-context-capture.ts`.
 */
export interface ContextDebugReaders {
	readDefault: () => Promise<WindowContextSnapshot>;
	readSelection: () => Promise<WindowContextSnapshot>;
	readSplit: () => Promise<WindowContextSnapshot>;
	readTree: (opts: {
		denyList: readonly string[];
		ocrFallback: boolean;
	}) => Promise<WindowContextSnapshot>;
}

const DEFAULT_READERS: ContextDebugReaders = {
	readDefault: readWindowContext,
	readSelection: readWindowSelection,
	readSplit: readWindowContextSplit,
	readTree: readWindowContextTree,
};

/**
 * Run the three secondary modes (the tree was already captured as the primary)
 * and assemble the side-by-side comparison list. The secondary spawns run
 * concurrently — three short-lived processes reading the same (stable)
 * foreground window.
 */
async function captureComparisonModes(
	tree: WindowContextSnapshot,
	treeDurationMs: number,
	readers: ContextDebugReaders
): Promise<ContextModeResult[]> {
	const [split, def, selection] = await Promise.all([
		captureMode("split", readers.readSplit),
		captureMode("default", readers.readDefault),
		captureMode("selection", readers.readSelection),
	]);
	const treeResult: ContextModeResult = {
		durationMs: treeDurationMs,
		mode: "tree",
		ok: snapshotHasContent(tree),
		snapshot: tree,
	};
	return [treeResult, split, def, selection];
}

/**
 * Capture a full context-awareness debug report against the currently
 * foreground window. Always resolves — the underlying helpers never throw,
 * falling back to an empty snapshot on any failure.
 */
export async function captureContextDebugReport(
	opts: CaptureContextDebugOptions,
	readers: ContextDebugReaders = DEFAULT_READERS
): Promise<ContextDebugReport> {
	const start = Date.now();

	// Primary capture: byte-for-byte the call the relay makes for dictation.
	const treeStart = Date.now();
	const raw = await readers.readTree({ denyList: opts.denyList, ocrFallback: true });
	const treeDurationMs = Date.now() - treeStart;

	const denied = isDeniedByList(raw, opts.denyList);
	const filtered = denied ? redactSensitiveFields(raw) : raw;
	const promptFragment = formatContextForPrompt(filtered);
	// Faithful to production: the relay stores `extractAsrPromptTail(snapshot)`,
	// but Whisper only ever receives it AFTER `sanitiseContextTail` (drops
	// decorative/control noise, collapses whitespace, keeps the LAST 250 chars).
	// Show that — not the raw 600-char textBefore the picker used to display.
	const asrPromptTailRaw = (filtered.textBefore ?? "").trim();
	const asrPromptTail = sanitiseContextTail(extractAsrPromptTail(filtered));

	const modes = opts.deep ? await captureComparisonModes(raw, treeDurationMs, readers) : undefined;

	const report: ContextDebugReport = {
		asrPromptTail,
		asrPromptTailRaw,
		capturedAt: Date.now(),
		contentless: snapshotIsContentless(raw),
		contextAwarenessEnabled: opts.contextAwarenessEnabled,
		deep: opts.deep,
		denied,
		deniedReason: denied ? firstDenyMatch(raw, opts.denyList) : null,
		durationMs: Date.now() - start,
		filteredSnapshot: filtered as ContextSnapshotView,
		hasCaret: hasCaret(raw),
		isIde: isIdeContext(raw),
		isTerminal: looksLikeTerminal(raw),
		metrics: buildMetrics(raw, promptFragment, opts.denyList),
		ocrUsed: trimmedLen(raw.ocrText) > 0,
		promptFragment,
		rawSnapshot: raw as ContextSnapshotView,
	};
	return modes ? { ...report, modes } : report;
}

// Re-exported for the colocated test so it can drive the pure helpers without
// spawning the native binary.
export const __context_debug_test_helpers__ = {
	buildMetrics,
	captureMode,
	firstDenyMatch,
	hasCaret,
	snapshotHasContent,
	trimmedLen,
};
