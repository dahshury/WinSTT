/**
 * Type contract for the context-awareness playground (debug tooling).
 *
 * Defined in `shared/` so BOTH the reference main analysis layer
 * (`electron/lib/context-debug.ts`, which assembles the report) and the
 * renderer view (`views/context-playground`, which renders it) speak the same
 * shape without the renderer importing backend-only types.
 *
 * Plain data only — no behaviour. Mirrors the production capture pipeline in
 * `electron/lib/context-reader.ts` + `lib/context-snapshot.ts` so the user can
 * see precisely what dictation's context-awareness would feed the model.
 */

/** The four `winstt-context.exe` extraction modes the helper supports. */
type ContextCaptureMode = "tree" | "split" | "default" | "selection";

/**
 * Renderer-safe mirror of `WindowContextSnapshot` (electron/lib/context-snapshot).
 * Structurally identical; declared here so the renderer needn't reach into
 * reference main code for the type.
 */
export interface ContextSnapshotView {
	/** Lowercased exe basename of the foreground window's process. */
	appExe?: string;
	/** Hierarchical XML serialization of the focused window's UIA subtree. */
	axHtml?: string;
	elementName: string;
	focusedText: string;
	/** On-device OCR text (last-resort fallback when UIA exposed no text). */
	ocrText?: string;
	textAfter?: string;
	textBefore?: string;
	/** Active page URL when the foreground app is a recognized browser. */
	url?: string;
	windowTitle: string;
}

/** One mode's raw capture result, for the side-by-side "deep capture" panel. */
export interface ContextModeResult {
	/** Wall-clock time the helper spawn took for this mode (ms). */
	durationMs: number;
	mode: ContextCaptureMode;
	/** False when the helper errored / timed out (snapshot is the empty triple). */
	ok: boolean;
	snapshot: ContextSnapshotView;
}

/** Derived size/threshold counters surfaced for tuning the native caps. */
export interface ContextMetrics {
	/** Hard cap the native helper enforces on axHtml (chars). */
	axHtmlCap: number;
	axHtmlChars: number;
	/** Number of patterns in the user's `general.contextDenyList`. */
	denyListSize: number;
	focusedTextChars: number;
	promptFragmentChars: number;
	textAfterChars: number;
	textBeforeChars: number;
}

/**
 * Full debug report for a single capture against the production-faithful path
 * (`readWindowContextTree({ ocrFallback, denyList })`), plus the derived views
 * dictation actually consumes.
 */
export interface ContextDebugReport {
	/** ASR (Whisper) prior-text bias AS RECEIVED — sanitised (decorative/control
	 *  noise stripped, whitespace collapsed) and capped to the last 250 chars.
	 *  This is what actually biases the decoder, not the raw textBefore. */
	asrPromptTail: string;
	/** The raw `textBefore` (trimmed) BEFORE sanitisation/cap — shown alongside
	 *  `asrPromptTail` so the cleanup's effect is visible. */
	asrPromptTailRaw: string;
	/** Epoch ms when the capture completed. */
	capturedAt: number;
	/** True when UIA exposed no readable text (would trigger the OCR fallback). */
	contentless: boolean;
	/** Mirror of `general.contextAwareness` at capture time. */
	contextAwarenessEnabled: boolean;
	/** True when the capture ran all four modes (vs the live tree-only path). */
	deep: boolean;
	/** Whether the snapshot matched the deny-list (sensitive fields stripped). */
	denied: boolean;
	/** The deny-list pattern that matched, or null. */
	deniedReason: string | null;
	/** Total wall-clock for the whole capture (ms). */
	durationMs: number;
	/** Snapshot AFTER deny-list redaction — what the pipeline actually uses. */
	filteredSnapshot: ContextSnapshotView;
	/** True when a caret split (textBefore/textAfter) was detected. */
	hasCaret: boolean;
	/** True when the foreground app is a recognized IDE/code editor. */
	isIde: boolean;
	/** True when the focused control is a terminal/console — its caret context
	 *  is scrollback soup (animation frames, ANSI/log residue), not prior text. */
	isTerminal: boolean;
	metrics: ContextMetrics;
	/** Per-mode raw results (present only on deep captures). */
	modes?: ContextModeResult[];
	/** True when the on-device OCR fallback contributed text. */
	ocrUsed: boolean;
	/** LLM cleanup prompt fragment via `formatContextForPrompt(filtered)`. */
	promptFragment: string;
	/** Snapshot BEFORE deny-list redaction (the raw UIA capture). */
	rawSnapshot: ContextSnapshotView;
}

/**
 * Live-channel push payload. The poll loop pushes a `report` whenever it
 * captures an EXTERNAL focused field; it pushes `waiting` (without clobbering
 * the last report on the renderer) when it can't capture — either the
 * playground/WinSTT itself holds OS focus, or live mode is off.
 */
export type ContextPlaygroundPush =
	| { at: number; kind: "report"; report: ContextDebugReport }
	| { at: number; kind: "waiting"; reason: ContextPlaygroundWaitReason };

export type ContextPlaygroundWaitReason = "own-window-focused" | "live-off";
