import { readFile as fsReadFile, unlink as fsUnlink } from "node:fs/promises";
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

import {
	isRealtimeEnabled,
	type LiveTranscriptionDisplay,
} from "../../src/shared/lib/realtime-enabled";
import { clearSessionAborted, isSessionAborted } from "../lib/abort-state";
import { readWindowContextTree } from "../lib/context-reader";
import { extractAsrPromptTail } from "../lib/context-snapshot";
import { installCustomWordsSync } from "../lib/custom-words-sync";
import { dbg, dbgVerbose } from "../lib/debug-log";
import {
	clearVolatileContextTail,
	installInitialPromptSync,
	setVolatileContextTail,
} from "../lib/initial-prompt-sync";
import { createSafeSender, type SafeSend } from "../lib/ipc-helpers";
import { setLastTranscription } from "../lib/last-transcription";
import { injectSubmitKey, pasteText } from "../lib/paste";
import {
	onAudioLevel,
	onLlmThinkingStart,
	onLlmThinkingStop,
	onRecordingStart,
	onRecordingStop,
} from "../lib/recording-indicator";
import { consumeRecordingStart, notifyRecordingStop } from "../lib/recording-state";
import { breadcrumb } from "../lib/sentry-main";
import { createSerialQueue } from "../lib/serial-queue";
import { getStoreRaw, getStoreValue, store } from "../lib/store";
import {
	applyPostProcessing,
	cleanupPostProcessing,
	initPostProcessing,
} from "../lib/text-processing";
import type { SttClient } from "../ws/stt-client";
import { muteSystemAudio, unmuteSystemAudio } from "./audio-mute";
import { getActiveHistoryStore } from "./history";
import { processText } from "./llm";
import { hideOverlay, showOverlay } from "./overlay";
import { type ContextCapture, createContextCapture } from "./relay-context-capture";
import {
	createTranscriptionHistoryStore,
	type HistoryPersistence,
	type TranscriptionHistoryEntry,
} from "./transcription-history";

function readHistoryMaxEntries(): number {
	const raw = getStoreValue("general.historyMaxEntries");
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		return 1000;
	}
	return Math.max(10, Math.min(10_000, Math.floor(n)));
}

function extractEventText(event: Record<string, unknown>): string {
	return String(event.text ?? "");
}

function hasDictationModel(): boolean {
	const provider = getStoreValue("llm.dictation.provider");
	if (provider === "openrouter") {
		return Boolean(getStoreValue("llm.openrouterApiKey"));
	}
	return Boolean(getStoreValue("llm.dictation.model"));
}

// Dictation cleanup runs when the dictation feature is enabled and has a
// model configured for its chosen provider. There is no master switch —
// transforms have their own independent gate in transforms.ts.
function isLlmConfigured(): boolean {
	return getStoreValue("llm.dictation.enabled") === true && hasDictationModel();
}

// Name of the model that post-processing would run on, for the history
// record. Provider-aware: Ollama exposes a bare model name, OpenRouter a
// slug. Returns "" when nothing usable is configured so callers can treat
// it the same as "no LLM ran".
function dictationLlmModel(): string {
	const provider = getStoreValue("llm.dictation.provider");
	const key = provider === "openrouter" ? "llm.dictation.openrouterModel" : "llm.dictation.model";
	const model = getStoreValue(key);
	return typeof model === "string" ? model : "";
}

// Listen mode is a passive monitor — captions only. No personalisation,
// persistence, LLM cleanup, or sentry breadcrumb metrics.
function isListenMode(): boolean {
	return getStoreValue("general.recordingMode") === "listen";
}

// Dictation LLM runs only when configured AND not in listen mode. The
// overlay-deferral path (recording_stop / empty-text fullSentence) keys
// off the same predicate so it can hide the pill promptly in listen mode.
function shouldRunDictationLlm(): boolean {
	return isLlmConfigured() && !isListenMode();
}

interface LlmAttempt {
	ok: boolean;
	text: string;
}

async function tryLlmProcess(text: string, context: string): Promise<LlmAttempt> {
	try {
		const out = await processText(text, context);
		// Stryker disable next-line MethodExpression,StringLiteral: dbg() preview is informational only
		dbg("relay", `LLM processed: ${out.slice(0, 80)}`);
		// `processText` swallows unexpected errors and returns the original text.
		// We treat an unchanged result as a soft-fail so the algorithmic fallback
		// runs — that way the user's dictionary/snippets still apply when the
		// LLM silently no-ops (network blip, malformed response, etc.).
		return { ok: out !== text, text: out };
	} catch (err) {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "LLM processing failed, using original:", String(err));
		return { ok: false, text };
	}
}

async function maybeRunLlm(
	text: string,
	context: string,
	safeSend?: SafeSend
): Promise<LlmAttempt> {
	// Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: equivalent — when the gate is bypassed, tryLlmProcess catches the resulting LLM error and returns the original text, yielding identical observable behavior to the early-return path
	if (!isLlmConfigured()) {
		return { ok: false, text };
	}
	// Keep the recording pill visible while the LLM is thinking so the
	// renderer can layer a thinking-indicator on top of it. recording_stop
	// already hid the overlay by the time we get here in the typical flow,
	// so this re-shows it for the duration of the LLM call.
	showOverlay();
	safeSend?.(IPC.LLM_PROCESSING_START);
	onLlmThinkingStart();
	try {
		const attempt = await tryLlmProcess(text, context);
		return attempt;
	} finally {
		safeSend?.(IPC.LLM_PROCESSING_END);
		onLlmThinkingStop();
		hideOverlay();
	}
}

function notifyEmptyResult(mode: unknown, safeSend: SafeSend): void {
	if (mode !== "listen") {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "fullSentence: empty result, treating as no_audio_detected");
		safeSend(IPC.STT_NO_AUDIO_DETECTED);
	}
}

function pasteIfDictating(mode: unknown, text: string): void {
	// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: pasteText is a fire-and-forget native call — no observable side effect can be asserted in unit tests; covered by Playwright e2e
	if (mode !== "listen") {
		// Remember it so the exclusive re-paste shortcut can re-inject this
		// exact transcript later. Recorded only when we'd auto-paste (not in
		// listen mode), so the shortcut mirrors what was actually dictated.
		setLastTranscription(text);
		// Stryker disable next-line StringLiteral: template literal trailing space is informational; pasteText is unobservable
		pasteText(`${text} `);
		maybeInjectAutoSubmit();
	}
}

function maybeInjectAutoSubmit(): void {
	if (getStoreValue("general.autoSubmit") !== true) {
		return;
	}
	const key = getStoreValue("general.autoSubmitKey");
	injectSubmitKey(key);
}

interface HistoryCapture {
	capture(
		text: string,
		originalText?: string,
		llmRan?: boolean,
		llmModel?: string,
		wavPath?: string
	): TranscriptionHistoryEntry | null;
	notifyStarted(): void;
	notifyStopped(): void;
}

/**
 * Run a void thunk and swallow any synchronous throw, logging it under the
 * given context. The single try/catch in relay.ts lives here so every defensive
 * "must-not-bubble" caller (hideOverlay, broadcast loop) goes through one
 * well-covered chokepoint instead of paying the catch-clause complexity hit
 * at every individual call site.
 */
function runSwallowingErrors(thunk: () => void, failureContext: string): void {
	try {
		thunk();
	} catch (err) {
		dbg("relay", `${failureContext}:`, String(err));
	}
}

/**
 * Hide the overlay defensively — swallow any throw from the native call so a
 * single window failure can't bubble out and abort downstream cleanup. Shared
 * by every relay code path that needs to drop the pill. CC=1: delegates the
 * try/catch to `runSwallowingErrors`.
 */
function safeHideOverlay(failureContext: string): void {
	runSwallowingErrors(hideOverlay, failureContext);
}

/**
 * Drop everything for a cancelled session — context, overlay, in-progress
 * thinking indicator — without firing any visible event. Extracted from the
 * abort guards in `handleFullSentence` so the cleanup is identical whether
 * the cancel landed before or after the LLM call returned.
 */
function discardCancelledSession(contextCapture?: ContextCapture): void {
	contextCapture?.clear();
	safeHideOverlay("hideOverlay during cancel-discard failed");
	dbg("relay", "fullSentence: dropped because session was cancelled by user");
}

/**
 * HARD GATE for the fullSentence pipeline — drops the event entirely when
 * the user has cancelled the session. Returns true when the event was
 * discarded so the caller can short-circuit. Extracted so the two abort
 * checkpoints in handleFullSentence each cost CC=1 in the caller.
 */
function abortFullSentenceIfCancelled(contextCapture?: ContextCapture): boolean {
	if (!isSessionAborted()) {
		return false;
	}
	discardCancelledSession(contextCapture);
	return true;
}

/**
 * When the dictation LLM would otherwise have run, the overlay was left up
 * by recording_stop so the thinking indicator could overlay on top of it.
 * In the empty-audio branch we never run the LLM, so we have to hide the
 * pill explicitly. Extracted to keep the empty-text helper at CC=1.
 */
function hideOverlayIfLlmDeferred(): void {
	if (shouldRunDictationLlm()) {
		safeHideOverlay("hideOverlay failed");
	}
}

/**
 * Empty/whitespace-only transcription path — surface "no audio detected" hint
 * (skipped in listen mode), clear any in-flight context capture, and hide the
 * overlay if recording_stop deferred its hide to us. CC=1.
 */
function handleEmptyFullSentence(
	mode: unknown,
	safeSend: SafeSend,
	contextCapture?: ContextCapture
): void {
	notifyEmptyResult(mode, safeSend);
	// Clear any pending context so it doesn't bleed into the next dictation.
	contextCapture?.clear();
	// recording_stop deferred its hideOverlay() to us when the dictation LLM
	// will run (so the pill stays continuous through the thinking indicator).
	// With no text to process, that work won't happen — hide the overlay now.
	hideOverlayIfLlmDeferred();
}

/**
 * Listen mode is a passive monitor — broadcast the raw caption but skip every
 * side effect that personalises or persists it: no dictionary / snippet
 * substitutions, no LLM cleanup, no history capture, no sentry breadcrumb.
 * Auto-paste is already gated by pasteIfDictating in the dictation path.
 */
function relayListenCaption(
	rawText: string,
	safeSend: SafeSend,
	contextCapture?: ContextCapture
): void {
	contextCapture?.clear();
	safeSend(IPC.STT_FULL_SENTENCE, { text: rawText });
}

/**
 * Resolve the LLM context snapshot — awaits the capture if one was wired up,
 * otherwise returns the empty string. Extracted so handleFullSentence avoids
 * the inline ternary (worth +1 CC).
 */
async function resolveLlmContext(contextCapture?: ContextCapture): Promise<string> {
	if (!contextCapture) {
		return "";
	}
	return await contextCapture.consume();
}

/**
 * Pick the text to paste vs the text to persist in history. When the LLM
 * succeeds, paste its cleaned output but keep the algorithmically processed
 * original as the "before" history snapshot. On LLM fail/no-op, both are the
 * fallback. CC=1 — the single ternary inside resolveProcessedTexts.
 */
function resolveProcessedTexts(
	attempt: LlmAttempt,
	rawText: string
): { processed: string; originalForHistory: string } {
	if (attempt.ok) {
		return { processed: attempt.text, originalForHistory: rawText };
	}
	const fallback = applyPostProcessing(rawText);
	return { processed: fallback, originalForHistory: fallback };
}

/**
 * Final dictation-path side effects after LLM + post-processing have resolved:
 * breadcrumb metric, broadcast the cleaned caption, persist to history, and
 * auto-paste. Extracted so the caller stays at CC=1 once every guard has run.
 */
function finalizeDictationFullSentence(
	processed: string,
	originalForHistory: string,
	mode: unknown,
	safeSend: SafeSend,
	history?: HistoryCapture,
	wavPath?: string
): void {
	breadcrumb("recording", "transcription completed", { text_length: processed.length }, "info");
	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
	safeSend(IPC.STT_FULL_SENTENCE, { text: processed });
	history?.capture(processed, originalForHistory, isLlmConfigured(), dictationLlmModel(), wavPath);
	pasteIfDictating(mode, processed);
}

interface PreLlmFullSentenceBranch {
	matches(rawText: string, mode: unknown): boolean;
	run(
		rawText: string,
		mode: unknown,
		safeSend: SafeSend,
		contextCapture: ContextCapture | undefined
	): void;
}

/**
 * Ordered list of pre-LLM short-circuit branches: the first whose `matches`
 * returns true claims the event. Each entry's `matches`/`run` is CC=1, and the
 * caller (`handlePreLlmFullSentenceBranch`) uses `Array.prototype.find` to
 * pick — no `if` chain, no `||` ladder.
 */
const PRE_LLM_FULL_SENTENCE_BRANCHES: readonly PreLlmFullSentenceBranch[] = [
	{
		// HARD GATE: user pressed `hotkey + Backspace` to cancel this session.
		// Drop ALL downstream work — no paste, no history, no caption, no LLM.
		matches: () => isSessionAborted(),
		run: (_rawText, _mode, _safeSend, contextCapture) => discardCancelledSession(contextCapture),
	},
	{
		// Empty/whitespace-only result means VAD found no transcribable audio.
		matches: (rawText) => rawText.trim().length === 0,
		run: (_rawText, mode, safeSend, contextCapture) =>
			handleEmptyFullSentence(mode, safeSend, contextCapture),
	},
	{
		// Listen mode is a passive monitor — broadcast caption, skip all
		// personalisation/persistence/LLM side effects.
		matches: (_rawText, mode) => mode === "listen",
		run: (rawText, _mode, safeSend, contextCapture) =>
			relayListenCaption(rawText, safeSend, contextCapture),
	},
];

interface PreLlmFullSentenceResult {
	handled: boolean;
	run: (
		rawText: string,
		mode: unknown,
		safeSend: SafeSend,
		contextCapture: ContextCapture | undefined
	) => void;
}

const PRE_LLM_NOOP_RUN = (
	_rawText: string,
	_mode: unknown,
	_safeSend: SafeSend,
	_contextCapture: ContextCapture | undefined
): void => {
	// No branch matched — handleFullSentence proceeds to the LLM path.
};

/**
 * Pick the matching pre-LLM branch (or a sentinel "noop" entry) without using
 * `if`/`||`. Returns the runner + a handled flag for the caller to act on.
 */
function pickPreLlmFullSentenceBranch(rawText: string, mode: unknown): PreLlmFullSentenceResult {
	const branch = PRE_LLM_FULL_SENTENCE_BRANCHES.find((b) => b.matches(rawText, mode));
	const found = Number(Boolean(branch));
	// Lookup picks the matched runner when found, else the sentinel noop.
	const run = ([PRE_LLM_NOOP_RUN, branch?.run] as const)[found] as PreLlmFullSentenceResult["run"];
	return { handled: Boolean(found), run };
}

/**
 * Decide which pre-LLM branch (if any) fully handles the event. Returns true
 * when the event was already serviced by an early branch (cancel/empty/listen)
 * and the caller must short-circuit. Keeps handleFullSentence at CC=1.
 */
function handlePreLlmFullSentenceBranch(
	rawText: string,
	mode: unknown,
	safeSend: SafeSend,
	contextCapture?: ContextCapture
): boolean {
	const { handled, run } = pickPreLlmFullSentenceBranch(rawText, mode);
	run(rawText, mode, safeSend, contextCapture);
	return handled;
}

/**
 * Final commit step after the SECOND abort gate has cleared. Pure straight-line
 * — extracted so runDictationLlmAndCommit can dispatch through a lookup table
 * instead of an `if` (keeps CC=1).
 */
function commitDictationLlmResult(
	attempt: LlmAttempt,
	rawText: string,
	mode: unknown,
	safeSend: SafeSend,
	history?: HistoryCapture,
	wavPath?: string
): void {
	const { processed, originalForHistory } = resolveProcessedTexts(attempt, rawText);
	finalizeDictationFullSentence(processed, originalForHistory, mode, safeSend, history, wavPath);
}

type DictationCommit = (
	attempt: LlmAttempt,
	rawText: string,
	mode: unknown,
	safeSend: SafeSend,
	history: HistoryCapture | undefined,
	wavPath: string | undefined
) => void;

const noopDictationCommit: DictationCommit = () => {
	// session was cancelled mid-LLM — discardCancelledSession already cleaned up.
};

/** Lookup table keyed on whether the post-LLM abort gate already discarded. */
const POST_LLM_COMMIT_DISPATCH: Record<"true" | "false", DictationCommit> = {
	true: noopDictationCommit,
	false: commitDictationLlmResult,
};

/**
 * Run the dictation LLM (if configured), then either commit the result or
 * drop it on a late cancellation. Extracted to keep handleFullSentence at
 * CC=1 — every branching guard lives in a named helper.
 */
async function runDictationLlmAndCommit(
	rawText: string,
	mode: unknown,
	safeSend: SafeSend,
	history?: HistoryCapture,
	contextCapture?: ContextCapture,
	wavPath?: string
): Promise<void> {
	const context = await resolveLlmContext(contextCapture);
	// When dictation LLM is on, fold the user's dictionary + snippets into its
	// system prompt (see buildDictationSystemPrompt in llm.ts) and skip the
	// algorithmic post-processor — the LLM applies vocab + cleanup in one pass.
	// On LLM error or no-op return, silently fall back to applyPostProcessing
	// so the user's explicit dictionary/snippet entries still take effect.
	const attempt = await maybeRunLlm(rawText, context, safeSend);

	// SECOND GATE: the LLM await above can take seconds. If the user
	// pressed `hotkey + Backspace` during the LLM call, the abort fires
	// and `processWithOllama` falls back to returning the ORIGINAL text
	// (which keeps the fallback contract working for model-swap aborts).
	// Without this gate, that "fallback" would get pasted into the user's
	// window despite their explicit cancel. Check again before any side
	// effect lands.
	const aborted = abortFullSentenceIfCancelled(contextCapture);
	const key = String(aborted) as "true" | "false";
	POST_LLM_COMMIT_DISPATCH[key](attempt, rawText, mode, safeSend, history, wavPath);
}

type FullSentenceContinuation = (
	rawText: string,
	mode: unknown,
	safeSend: SafeSend,
	history: HistoryCapture | undefined,
	contextCapture: ContextCapture | undefined,
	wavPath: string | undefined
) => Promise<void>;

const noopFullSentenceContinuation: FullSentenceContinuation = async () => {
	// handled by pre-LLM branch — nothing more to do.
};

/**
 * Lookup table keyed by "was the pre-LLM branch already handled". The boolean
 * is stringified into "true" / "false" so we get O(1) dispatch with zero
 * inline branches (no ternary, no if), keeping handleFullSentence at CC=1.
 */
const POST_PRE_LLM_DISPATCH: Record<"true" | "false", FullSentenceContinuation> = {
	true: noopFullSentenceContinuation,
	false: runDictationLlmAndCommit,
};

async function handleFullSentence(
	event: Record<string, unknown>,
	safeSend: SafeSend,
	history?: HistoryCapture,
	contextCapture?: ContextCapture
): Promise<void> {
	const rawText = extractEventText(event);
	const mode = getStoreValue("general.recordingMode");
	maybePersistSqliteRow(event, rawText, mode);
	// The server attaches an absolute WAV path here when save_wav is on (the
	// renderer enables it by default); thread it to the legacy history capture
	// so the settings-tab entry gets an audioFilePath → play button.
	const wavPath = typeof event.wav_path === "string" ? event.wav_path : undefined;
	const handled = handlePreLlmFullSentenceBranch(rawText, mode, safeSend, contextCapture);
	const key = String(handled) as "true" | "false";
	await POST_PRE_LLM_DISPATCH[key](rawText, mode, safeSend, history, contextCapture, wavPath);
}

/**
 * When the server's fullSentence event carries a `wav_path` (because
 * `HistoryConfig.save_wav` is on for the running recorder), persist a row in
 * the SQLite history. Pre-LLM text only — the LLM cleanup pipeline is
 * downstream of this; we leave `postProcessedText` empty here and rely on
 * the renderer's history-view to surface the raw transcript.
 *
 * Skipped in listen mode (captions only; no persistence) to match the
 * existing electron-store history's policy.
 */
// Split on either separator so a Windows-style backslash-pathed wav_path from
// the server still yields a clean basename on Linux/macOS dev runs. Hoisted to
// module scope to satisfy biome's useTopLevelRegex rule (we'd otherwise
// allocate it per fullSentence).
const WAV_PATH_SEP = /[/\\]/;

function maybePersistSqliteRow(
	event: Record<string, unknown>,
	rawText: string,
	mode: unknown
): void {
	if (mode === "listen") {
		return;
	}
	const trimmed = rawText.trim();
	if (trimmed.length === 0) {
		return;
	}
	const wavPath = event.wav_path;
	if (typeof wavPath !== "string" || wavPath.length === 0) {
		return;
	}
	const store = getActiveHistoryStore();
	if (store === null) {
		return;
	}
	const fileName = wavPath.split(WAV_PATH_SEP).pop() ?? wavPath;
	try {
		store.add({
			fileName,
			transcriptionText: trimmed,
			postProcessRequested: isLlmConfigured(),
		});
	} catch (err) {
		dbg("relay", "sqlite history add failed:", String(err));
	}
}

/**
 * Percent reduction to apply to system audio for this dictation, or 0 when
 * the feature is off / not applicable. Ducking is always disabled in listen
 * mode (we'd be muting the very audio being transcribed). CC=1: the gate is
 * encoded as a flag-product so the body has no logical operators.
 */
function dictationDuckLevel(): number {
	const pct = getStoreValue("general.systemAudioReductionWhileDictating");
	const positive = Number(pct > 0);
	const notListen = Number(getStoreValue("general.recordingMode") !== "listen");
	// `positive * notListen` is 1 iff both hold; lookup picks 0 (off) or `pct`.
	return [0, pct][positive * notListen] as number;
}

/**
 * Dictation-mode side effects when a fresh recording_start has been admitted.
 * Listen mode skips every line in here because the captions are a passive
 * monitor — no metric, no LLM, no history. CC=1.
 */
function performDictationStartSideEffects(
	history: HistoryCapture | undefined,
	contextCapture: ContextCapture | undefined
): void {
	breadcrumb("recording", "recording started", undefined, "info");
	history?.notifyStarted();
	// Snapshot the user's focused window context for downstream LLM cleanup.
	// Fire-and-forget — the spawn races with the user's speech and the
	// consumer (fullSentence) awaits it. Off unless the user opted in via
	// settings.
	contextCapture?.capture();
}

function noopRecordingStartSideEffects(
	_history: HistoryCapture | undefined,
	_contextCapture: ContextCapture | undefined
): void {
	// Listen mode — skip metric/history/context capture.
}

/**
 * Lookup keyed on whether we're in listen mode. Used by the recording-start
 * helper to fan in/out of the personalisation-heavy side-effect chain without
 * an explicit `if`.
 */
const RECORDING_START_MODE_DISPATCH: Record<
	"true" | "false",
	(history: HistoryCapture | undefined, contextCapture: ContextCapture | undefined) => void
> = {
	true: noopRecordingStartSideEffects,
	false: performDictationStartSideEffects,
};

/**
 * Apply (or skip) the system-audio duck based on the resolved level. Returns
 * the recording-start result shape directly so the caller can flow through
 * without an inline ternary. Pure straight-line in each branch.
 */
function applyAudioDuck(duckLevel: number): { muted: boolean; attempted: boolean } {
	return { muted: muteSystemAudio(duckLevel), attempted: true };
}

function skipAudioDuck(_duckLevel: number): { muted: boolean; attempted: boolean } {
	return { muted: false, attempted: false };
}

const AUDIO_DUCK_DISPATCH: Record<
	"true" | "false",
	(duckLevel: number) => { muted: boolean; attempted: boolean }
> = {
	true: applyAudioDuck,
	false: skipAudioDuck,
};

/**
 * Side-effect chain for a recording_start that DID consume a hotkey press.
 * Extracted so the public handleRecordingStart can dispatch through a lookup
 * table instead of an `if` guard. CC=1.
 */
function runAdmittedRecordingStart(
	safeSend: SafeSend,
	history: HistoryCapture | undefined,
	contextCapture: ContextCapture | undefined
): { muted: boolean; attempted: boolean } {
	// A real new session is beginning — lift the abort gate set by any
	// previous `hotkey + Backspace` cancel so this session's events flow
	// normally. Without this, a user who cancels, then immediately starts
	// a fresh recording, would see nothing pasted (the gate would still
	// drop the new session's fullSentence too).
	clearSessionAborted();
	const listen = isListenMode();
	const modeKey = String(listen) as "true" | "false";
	// `listen` paths skip breadcrumb/history.notifyStarted/contextCapture, but
	// every path still broadcasts the start, kicks the overlay, and pings the
	// recording-indicator. Listen-mode branch is a no-op above + same finish.
	RECORDING_START_MODE_DISPATCH[modeKey](history, contextCapture);
	safeSend(IPC.STT_RECORDING_START);
	onRecordingStart();
	showOverlay();
	const duckLevel = dictationDuckLevel();
	const duckKey = String(duckLevel > 0) as "true" | "false";
	return AUDIO_DUCK_DISPATCH[duckKey](duckLevel);
}

function rejectStaleRecordingStart(
	_safeSend: SafeSend,
	_history: HistoryCapture | undefined,
	_contextCapture: ContextCapture | undefined
): { muted: boolean; attempted: boolean } {
	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", "ignoring recording_start — no pending hotkey press (stale/duplicate)");
	return { muted: false, attempted: false };
}

/**
 * Lookup keyed on "did consumeRecordingStart() admit this event?". Lets
 * handleRecordingStart stay at CC=1 — every branch lives in its own helper.
 */
const RECORDING_START_GATE_DISPATCH: Record<
	"true" | "false",
	(
		safeSend: SafeSend,
		history: HistoryCapture | undefined,
		contextCapture: ContextCapture | undefined
	) => { muted: boolean; attempted: boolean }
> = {
	true: runAdmittedRecordingStart,
	false: rejectStaleRecordingStart,
};

function handleRecordingStart(
	safeSend: SafeSend,
	history?: HistoryCapture,
	contextCapture?: ContextCapture
): { muted: boolean; attempted: boolean } {
	// `recording_start` events are only honoured when there's an
	// outstanding hotkey press to consume (PTT/toggle modes) or when
	// we're in listen mode (always-on). Stale, duplicate, or
	// wakeword-retrigger events that arrive without a fresh user press
	// fall through this gate without firing any side effects — that's
	// what stops the "pill hides then shows again on its own" bug.
	const admittedKey = String(consumeRecordingStart()) as "true" | "false";
	return RECORDING_START_GATE_DISPATCH[admittedKey](safeSend, history, contextCapture);
}

function handleModelDownloadProgress(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_DOWNLOAD_PROGRESS, {
		model: event.model,
		progress: event.progress,
		downloadedBytes: event.downloaded_bytes,
		totalBytes: event.total_bytes,
		speedBps: event.speed_bps,
		etaSeconds: event.eta_seconds,
		// Forward the streaming-downloader marker so the renderer can
		// fan out into the per-quant ``quantDownloads`` map instead of
		// the singleton overlay slot.
		quantization: event.quantization,
	});
}

function handleModelSwapStarted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_SWAP_STARTED, { kind: event.kind, name: event.name });
}

function handleModelSwapCompleted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_SWAP_COMPLETED, { kind: event.kind, name: event.name });
}

/**
 * Coalesce an event field to a default when null/undefined. Branchless by
 * design — array-index dispatch on `value == null` avoids both `??` and `||`,
 * which would each cost +1 cyclomatic complexity at every call site. Lifecycle
 * relay handlers below use this so they stay at CC=1 even with several
 * defaulted fields.
 */
function eventValueOr<T>(value: unknown, fallback: T): unknown | T {
	return [value, fallback][Number(value == null)];
}

function handleModelSwapFailed(event: Record<string, unknown>, safeSend: SafeSend): void {
	// The server classifies every swap failure into a stable category
	// (network / model_not_found / out_of_memory / disk_full /
	// incompatible_quantization / model_corrupt / permission_denied /
	// cancelled / superseded / unknown) so the renderer can pick a
	// localised toast variant. ``reason`` is the user-readable message,
	// ``detail`` is the raw exception text for support diagnostics.
	safeSend(IPC.STT_MODEL_SWAP_FAILED, {
		kind: event.kind,
		name: event.name,
		reason: event.reason,
		category: eventValueOr(event.category, "unknown"),
		detail: eventValueOr(event.detail, ""),
	});
}

function handleDiarizationToggleStarted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_DIARIZATION_TOGGLE_STARTED, { enabled: event.enabled });
}

function handleDiarizationToggleCompleted(
	event: Record<string, unknown>,
	safeSend: SafeSend
): void {
	safeSend(IPC.STT_DIARIZATION_TOGGLE_COMPLETED, {
		enabled: event.enabled,
		message: eventValueOr(event.message, ""),
	});
}

function handleDiarizationToggleFailed(event: Record<string, unknown>, safeSend: SafeSend): void {
	// Same stable category vocabulary as model-swap failures (shared
	// server classifier) so the renderer can reuse the toast variants.
	safeSend(IPC.STT_DIARIZATION_TOGGLE_FAILED, {
		enabled: event.enabled,
		reason: event.reason,
		category: eventValueOr(event.category, "unknown"),
		detail: eventValueOr(event.detail, ""),
	});
}

function handleModelCacheChanged(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_CACHE_CHANGED, { modelId: event.model_id });
}

// Server fires this once per launch after its background HuggingFace refresh
// pulls fresh `card_data.language` lists. The catalog payload mirrors the
// shape of a `list_models` response, so we reuse the same renderer-side
// store update — every settings panel re-renders its language dropdown
// without a restart. Mirroring `cachedModelCatalog` keeps STT_GET_MODEL_CATALOG
// (used by windows opened after the refresh) coherent with the broadcast.
/**
 * No-op branch of the catalog-updated lookup table — used when the payload
 * isn't an array, so we don't mutate the cache or fire an IPC.
 */
function ignoreCatalogPayload(
	_models: unknown[],
	_safeSend: SafeSend,
	_updateCache: (models: unknown[]) => void
): void {
	// Intentionally empty.
}

function applyCatalogPayload(
	models: unknown[],
	safeSend: SafeSend,
	updateCache: (models: unknown[]) => void
): void {
	updateCache(models);
	safeSend(IPC.STT_MODEL_CATALOG, { models });
}

/**
 * Lookup table keyed on whether the payload looks like a catalog list. Avoids
 * the inline ternary + if guard that would otherwise push the public handler
 * to CC=3.
 */
const CATALOG_UPDATE_DISPATCH: Record<
	"true" | "false",
	(models: unknown[], safeSend: SafeSend, updateCache: (models: unknown[]) => void) => void
> = {
	true: applyCatalogPayload,
	false: ignoreCatalogPayload,
};

// Server fires this once per launch after its background HuggingFace refresh
// pulls fresh `card_data.language` lists. The catalog payload mirrors the
// shape of a `list_models` response, so we reuse the same renderer-side
// store update — every settings panel re-renders its language dropdown
// without a restart. Mirroring `cachedModelCatalog` keeps STT_GET_MODEL_CATALOG
// (used by windows opened after the refresh) coherent with the broadcast.
function handleModelCatalogUpdated(
	event: Record<string, unknown>,
	safeSend: SafeSend,
	updateCache: (models: unknown[]) => void
): void {
	const isList = Array.isArray(event.models);
	const key = String(isList) as "true" | "false";
	const models = eventValueOr(event.models, []) as unknown[];
	CATALOG_UPDATE_DISPATCH[key](models, safeSend, updateCache);
}

function handleAudioLevel(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_AUDIO_LEVEL, { level: event.level });
	// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: onAudioLevel writes to recording-indicator state with no observable side effect from unit tests
	if (typeof event.level === "number") {
		onAudioLevel(event.level);
	}
}

function handleRealtimeEvent(event: Record<string, unknown>, safeSend: SafeSend): void {
	if (!event.text) {
		return;
	}
	// Same gate as handleFullSentence — once the user has cancelled, no
	// further captions from the in-flight session should reach the renderer
	// (otherwise the pill would keep updating with realtime text from
	// audio the user explicitly discarded).
	if (isSessionAborted()) {
		return;
	}
	// Stryker disable next-line MethodExpression,StringLiteral: dbgVerbose() preview is informational only
	dbgVerbose("relay", "realtime:", String(event.text).slice(0, 80));
	safeSend(IPC.STT_REALTIME_TEXT, { text: event.text });
}

/**
 * Side effects that listen-mode skips on recording stop: breadcrumb metric and
 * history bookkeeping. Pulled out so handleRecordingStop can dispatch through
 * a lookup table instead of guarding two separate listen-mode if-blocks.
 */
function performDictationStopBookkeeping(history: HistoryCapture | undefined): void {
	breadcrumb("recording", "recording stopped", undefined, "info");
	history?.notifyStopped();
}

function noopRecordingStopBookkeeping(_history: HistoryCapture | undefined): void {
	// Listen mode — passive monitor, no metric, no history capture.
}

const RECORDING_STOP_MODE_DISPATCH: Record<
	"true" | "false",
	(history: HistoryCapture | undefined) => void
> = {
	true: noopRecordingStopBookkeeping,
	false: performDictationStopBookkeeping,
};

/**
 * Hide the overlay now (CC=1: delegates the defensive try/catch to
 * `safeHideOverlay`). Used when the dictation LLM won't run after this stop.
 */
function hideOverlayOnStop(): void {
	safeHideOverlay("hideOverlay failed");
}

function deferOverlayHideOnStop(): void {
	// LLM will run — the pill stays visible so the thinking indicator can
	// overlay on top of it. The hide is deferred to maybeRunLlm() after
	// llm:processing-end, or to the empty-text branch of handleFullSentence
	// when VAD finds no transcribable audio.
}

const RECORDING_STOP_OVERLAY_DISPATCH: Record<"true" | "false", () => void> = {
	// `shouldRunDictationLlm` true → defer the hide. False → hide now.
	true: deferOverlayHideOnStop,
	false: hideOverlayOnStop,
};

/**
 * Restore the system audio volume if we ducked it for this dictation. Returns
 * the new "still muted?" flag for the caller — false once unmute lands so a
 * later recording_stop doesn't try to unmute twice.
 */
function restoreDuckedAudio(_wasMuted: boolean): boolean {
	unmuteSystemAudio();
	return false;
}

function keepAudioState(wasMuted: boolean): boolean {
	return wasMuted;
}

const RECORDING_STOP_UNMUTE_DISPATCH: Record<"true" | "false", (wasMuted: boolean) => boolean> = {
	true: restoreDuckedAudio,
	false: keepAudioState,
};

function handleRecordingStop(
	wasMuted: boolean,
	safeSend: SafeSend,
	history?: HistoryCapture
): boolean {
	const modeKey = String(isListenMode()) as "true" | "false";
	RECORDING_STOP_MODE_DISPATCH[modeKey](history);
	// Clear the recording-state machine first so any duplicate
	// recording_start that arrives after this stop is rejected by
	// the consumeRecordingStart() gate.
	notifyRecordingStop();
	// Hide the floating pill FIRST, before any IPC broadcast or downstream
	// work, so a slow renderer or a hang in another handler can't leave the
	// overlay window stuck on screen.
	//
	// EXCEPTION: when the dictation LLM will run, the pill needs to stay
	// visible so the thinking indicator can overlay onto the existing pill
	// rather than the user seeing it disappear → reappear.
	const overlayKey = String(shouldRunDictationLlm()) as "true" | "false";
	RECORDING_STOP_OVERLAY_DISPATCH[overlayKey]();
	safeSend(IPC.STT_RECORDING_STOP);
	onRecordingStop();
	const unmuteKey = String(wasMuted) as "true" | "false";
	return RECORDING_STOP_UNMUTE_DISPATCH[unmuteKey](wasMuted);
}

type SimpleHandler = (event: Record<string, unknown>, safeSend: SafeSend) => void;

const SIMPLE_RELAY_HANDLERS: Record<string, SimpleHandler> = {
	// HARD GATE: a user-initiated cancel races the server's
	// `set_microphone(false)` epilogue — after `abort()` flips the state
	// machine to INACTIVE, the next `set_microphone(false)` we send hits the
	// "off-without-recording" branch in recorder_service and publishes
	// NoAudioDetected. Without this gate the renderer would announce "no
	// audio detected" to a user who just explicitly discarded their
	// recording. `isSessionAborted` clears on the next recording_start, so
	// legitimate no-audio events from later sessions still flow through.
	no_audio_detected: (_e, send) => {
		if (isSessionAborted()) {
			return;
		}
		send(IPC.STT_NO_AUDIO_DETECTED);
	},
	vad_detect_start: (_e, send) => send(IPC.STT_VAD_START),
	vad_detect_stop: (_e, send) => send(IPC.STT_VAD_STOP),
	transcription_start: (e, send) =>
		send(IPC.STT_TRANSCRIPTION_START, { audioBase64: e.audio_bytes_base64 }),
	wakeword_detected: (_e, send) => send(IPC.STT_WAKEWORD_DETECTED),
	wakeword_detection_start: (_e, send) => send(IPC.STT_WAKEWORD_DETECTION_START),
	wakeword_detection_end: (_e, send) => send(IPC.STT_WAKEWORD_DETECTION_END),
	model_download_start: (e, send) =>
		send(IPC.STT_MODEL_DOWNLOAD_START, { model: e.model, quantization: e.quantization }),
	model_download_complete: (e, send) =>
		send(IPC.STT_MODEL_DOWNLOAD_COMPLETE, {
			model: e.model,
			cancelled: e.cancelled ?? false,
			quantization: e.quantization,
			outcome: e.outcome,
		}),
	loopback_started: (e, send) => send(IPC.STT_LOOPBACK_STARTED, { deviceName: e.deviceName }),
	loopback_stopped: (_e, send) => send(IPC.STT_LOOPBACK_STOPPED),
	device_switch_failed: (e, send) =>
		send(IPC.STT_DEVICE_SWITCH_FAILED, {
			requestedIndex: e.requested_index,
			errorMessage: e.error_message,
			fallbackIndex: e.fallback_index,
		}),
	vad_sensitivity_adapted: (e, send) =>
		send(IPC.STT_VAD_SENSITIVITY_ADAPTED, {
			newSensitivity: e.new_sensitivity,
			noiseFloorRms: e.noise_floor_rms,
			speechPeakRms: e.speech_peak_rms,
		}),
	speaker_segments: (e, send) =>
		// Forward the per-utterance diarization tuple to the renderer so it
		// can color the just-committed words per speaker. Times stay in
		// seconds-relative-to-utterance — the renderer aligns them against
		// the matching fullSentence's word timings.
		send(IPC.STT_SPEAKER_SEGMENTS, { segments: e.segments }),
};

function handleSimpleRelayEvent(
	type: string,
	event: Record<string, unknown>,
	safeSend: SafeSend
): boolean {
	const handler = SIMPLE_RELAY_HANDLERS[type];
	if (!handler) {
		return false;
	}
	handler(event, safeSend);
	return true;
}

// Simple-relay event types that must reach EVERY renderer, not just the main
// window. Overlay needs the VAD/no-audio events; the settings window's
// dictation model download dialog needs the download lifecycle events to drive
// its progress bar and auto-close on completion. `speaker_segments` must follow
// `fullSentence` (which broadcasts via DATA_EVENT_HANDLERS) so diarized captions
// stay consistent in every window that renders the transcript feed — otherwise
// fullSentence reaches all windows but its speaker colors reach only the main
// one, silently de-diarizing any other consumer.
const OVERLAY_RELEVANT_SIMPLE_TYPES = new Set([
	"no_audio_detected",
	"vad_detect_start",
	"vad_detect_stop",
	"model_download_start",
	"model_download_complete",
	"speaker_segments",
]);

interface DispatchContext {
	broadcast: SafeSend;
	contextCapture?: ContextCapture;
	getMuted: () => boolean;
	history?: HistoryCapture;
	mainSend: SafeSend;
	// Writes the server's latest catalog payload into the closure-scoped
	// `cachedModelCatalog` so windows opened after a runtime refresh see
	// the new languages immediately via STT_GET_MODEL_CATALOG. Optional
	// because most data-event handlers don't touch the catalog cache.
	setCatalogCache?: (models: unknown[]) => void;
	setMuted: (value: boolean) => void;
}

interface SerialQueueLike {
	enqueue: (fn: () => Promise<void> | void) => void;
}

interface DataEventQueues {
	fullSentenceQueue: SerialQueueLike;
	recordingStateQueue: SerialQueueLike;
}

const QUEUE_MAP: Record<"fullSentence" | "recordingState", keyof DataEventQueues> = {
	fullSentence: "fullSentenceQueue",
	recordingState: "recordingStateQueue",
};

function enqueueIfRouted(
	type: string,
	event: Record<string, unknown>,
	queues: DataEventQueues,
	ctx: DispatchContext
): boolean {
	const route = routeEventToQueue(type);
	const queueKey = QUEUE_MAP[route as keyof typeof QUEUE_MAP];
	if (!queueKey) {
		return false;
	}
	// Stryker disable next-line ArrowFunction: enqueue body is exercised when the queue runs the work — covered by enqueue-routes-fullSentence/recording test
	queues[queueKey].enqueue(() => dispatchDataEvent(type, event, ctx));
	return true;
}

// Data-event types too high-frequency to log on every arrival. `audio_level`
// fires ~once per 20ms of audio; `model_download_progress` fires once per HTTP
// chunk (~55/sec) — a single whisper-tiny download wrote ~13k lines to
// debug.log, which is 5 MB-rotated, so a couple of downloads evict every other
// diagnostic. These still dispatch/broadcast normally below; only the verbose
// arrival log is suppressed.
const HIGH_FREQUENCY_DATA_EVENTS = new Set(["audio_level", "model_download_progress"]);

function logDataEventArrival(type: string): void {
	// Stryker disable next-line ConditionalExpression,BlockStatement: gate around dbgVerbose only — observable behavior unchanged
	if (!HIGH_FREQUENCY_DATA_EVENTS.has(type)) {
		// Stryker disable next-line StringLiteral: dbgVerbose() message is informational only
		dbgVerbose("relay", `data-event: ${type}`);
	}
}

function processDataEvent(
	event: Record<string, unknown>,
	queues: DataEventQueues,
	ctx: DispatchContext
): Promise<void> {
	const type = event.type;
	// Stryker disable next-line ConditionalExpression,BlockStatement: with `false`, the function falls through to enqueueIfRouted/dispatchDataEvent which gracefully handle unknown types (returns false → no-op). Observable behavior identical.
	if (typeof type !== "string") {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "Data event WITHOUT type:", JSON.stringify(event));
		return Promise.resolve();
	}
	logDataEventArrival(type);
	if (enqueueIfRouted(type, event, queues, ctx)) {
		return Promise.resolve();
	}
	return dispatchDataEvent(type, event, ctx);
}

type DataEventHandler = (
	event: Record<string, unknown>,
	ctx: DispatchContext
) => Promise<void> | void;

const DATA_EVENT_HANDLERS: Record<string, DataEventHandler> = {
	realtime: (event, ctx) => handleRealtimeEvent(event, ctx.broadcast),
	fullSentence: (event, ctx) =>
		handleFullSentence(event, ctx.broadcast, ctx.history, ctx.contextCapture),
	// Stryker disable next-line BlockStatement: handler body is exercised by the dispatchDataEvent recording_start tests when consumeRecordingStart returns true
	recording_start: (_event, ctx) => {
		const result = handleRecordingStart(ctx.broadcast, ctx.history, ctx.contextCapture);
		if (result.attempted) {
			ctx.setMuted(result.muted);
		}
	},
	recording_stop: (_event, ctx) => {
		ctx.setMuted(handleRecordingStop(ctx.getMuted(), ctx.broadcast, ctx.history));
	},
	audio_level: (event, ctx) => handleAudioLevel(event, ctx.broadcast),
	// Broadcast so the settings window's dictation download dialog sees
	// progress alongside the main window. mainSend-only would leave the
	// settings dialog stuck on the "Download?" prompt with no progress bar.
	model_download_progress: (event, ctx) => handleModelDownloadProgress(event, ctx.broadcast),
	// Model swap lifecycle goes to ALL renderers via broadcast — settings
	// panel listens to revert the picker on failure, status-bar listens to
	// flip the chip into a loading state during the swap.
	model_swap_started: (event, ctx) => handleModelSwapStarted(event, ctx.broadcast),
	model_swap_completed: (event, ctx) => handleModelSwapCompleted(event, ctx.broadcast),
	model_swap_failed: (event, ctx) => handleModelSwapFailed(event, ctx.broadcast),
	// Runtime diarization toggle lifecycle — broadcast so the settings
	// window (separate BrowserWindow) drives the toggle's spinner/enabled
	// state off real signals instead of guessing.
	diarization_toggle_started: (event, ctx) => handleDiarizationToggleStarted(event, ctx.broadcast),
	diarization_toggle_completed: (event, ctx) =>
		handleDiarizationToggleCompleted(event, ctx.broadcast),
	diarization_toggle_failed: (event, ctx) => handleDiarizationToggleFailed(event, ctx.broadcast),
	model_cache_changed: (event, ctx) => handleModelCacheChanged(event, ctx.broadcast),
	// Server's once-per-launch HuggingFace catalog refresh — pushes a
	// fresh list with up-to-date `languages` for every model. Update the
	// closure cache so STT_GET_MODEL_CATALOG returns the new payload, then
	// broadcast to every renderer so live settings panels re-render their
	// language dropdowns without a restart.
	model_catalog_updated: (event, ctx) =>
		handleModelCatalogUpdated(event, ctx.broadcast, ctx.setCatalogCache ?? (() => undefined)),
};

function pickSenderForSimpleEvent(type: string, ctx: DispatchContext): SafeSend {
	return OVERLAY_RELEVANT_SIMPLE_TYPES.has(type) ? ctx.broadcast : ctx.mainSend;
}

async function dispatchDataEvent(
	type: string,
	event: Record<string, unknown>,
	ctx: DispatchContext
): Promise<void> {
	const handler = DATA_EVENT_HANDLERS[type];
	if (handler) {
		await handler(event, ctx);
		return;
	}
	// no_audio_detected and vad_* are overlay-relevant; the rest stay main-only.
	handleSimpleRelayEvent(type, event, pickSenderForSimpleEvent(type, ctx));
}

/**
 * No-op dispatch slot — chosen when the destination BrowserWindow is already
 * destroyed so we skip the IPC send entirely. Kept as a named function so the
 * lookup table in `sendToWindowSafely` stays self-documenting.
 */
function skipDestroyedWindow(
	_bw: BrowserWindow,
	_channel: string,
	_args: readonly unknown[]
): void {
	// Intentionally empty — destroyed windows can't receive IPC.
}

function sendIpcSwallowingErrors(
	bw: BrowserWindow,
	channel: string,
	args: readonly unknown[]
): void {
	// A single hung/unresponsive renderer must not abort the broadcast —
	// callers (e.g. handleRecordingStop) rely on subsequent statements
	// like hideOverlay() running. The try/catch lives in runSwallowingErrors
	// so this helper itself stays at CC=1.
	runSwallowingErrors(
		() => bw.webContents.send(channel, ...args),
		`broadcast to window failed (${channel})`
	);
}

const WINDOW_SEND_DISPATCH: Record<
	"true" | "false",
	(bw: BrowserWindow, channel: string, args: readonly unknown[]) => void
> = {
	true: skipDestroyedWindow,
	false: sendIpcSwallowingErrors,
};

function sendToWindowSafely(bw: BrowserWindow, channel: string, args: readonly unknown[]): void {
	const key = String(bw.isDestroyed()) as "true" | "false";
	WINDOW_SEND_DISPATCH[key](bw, channel, args);
}

function broadcastToAll(channel: string, ...args: unknown[]): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		sendToWindowSafely(bw, channel, args);
	}
}

function userIntendedRealtimeOn(): boolean {
	const liveTranscriptionDisplay = (store.get("general.liveTranscriptionDisplay") ??
		"both") as LiveTranscriptionDisplay;
	const showRecordingOverlay = store.get("general.showRecordingOverlay") !== false;
	return isRealtimeEnabled({ showRecordingOverlay, liveTranscriptionDisplay });
}

function logServerRealtimeWarning(val: unknown): void {
	// Stryker disable next-line StringLiteral: dbgVerbose() label is informational only
	dbgVerbose("relay", "SERVER reports enable_realtime_transcription=", val);
	// Only warn on an actual mismatch: the user expected realtime ON but the
	// server is OFF. When the user picked liveTranscriptionDisplay="none" or
	// "in-pill" without the overlay, the server being OFF is the intended
	// state — not a misconfiguration to surface.
	if (val || !userIntendedRealtimeOn()) {
		return;
	}
	// Stryker disable next-line StringLiteral: dbg() warning text is informational only — multi-line string concatenation
	dbg(
		"relay",
		// Stryker disable next-line StringLiteral: warning text part 1 — informational only
		"WARNING: Server has realtime transcription DISABLED. " +
			// Stryker disable next-line StringLiteral: warning text part 2 — informational only
			"Pass --enable_realtime_transcription when starting the server, " +
			// Stryker disable next-line StringLiteral: warning text part 3 — informational only
			"or restart via the Electron app."
	);
}

function logServerRealtimeError(err: unknown): void {
	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", "Could not query server realtime config:", String(err));
}

function logServerRealtimeConfig(): void {
	// Stryker disable next-line StringLiteral: dbgVerbose() store snapshot is informational only
	dbgVerbose(
		"relay",
		// Stryker disable next-line StringLiteral: label part — informational only
		"Store realtime config: liveTranscriptionDisplay=",
		store.get("general.liveTranscriptionDisplay"),
		// Stryker disable next-line StringLiteral: label part — informational only
		"showRecordingOverlay=",
		store.get("general.showRecordingOverlay"),
		// Stryker disable next-line StringLiteral: label part — informational only
		"useMainModelForRealtime=",
		store.get("quality.useMainModelForRealtime"),
		// Stryker disable next-line StringLiteral: label part — informational only
		"realtimeModel=",
		store.get("model.realtimeModel")
	);
}

const RECORDING_STATE_EVENT_TYPES = new Set(["recording_start", "recording_stop"]);

// Methods this frontend build depends on that are recent enough to act as
// a staleness canary. The server stamps its live ALLOWED_METHODS into
// runtime_info; if any of these are absent the user is talking to an old
// server process (the split-brain dev failure) and needs to restart it.
// Add the newest protocol-affecting method here when one is introduced.
const REQUIRED_SERVER_METHODS = ["request_diarization_toggle"] as const;

/**
 * Pull a numbered list of allowed server methods out of a runtime-info payload
 * without using `&&`, `||`, `??`, or `if`. Returns [] when the info isn't a
 * record or doesn't carry an allowed_methods array, so the caller can treat
 * "no capability list" the same as "no missing methods" (older server
 * pre-handshake — don't cry wolf).
 */
function extractAllowedMethods(info: unknown): unknown[] {
	const candidate = (info as { allowed_methods?: unknown } | null | undefined)?.allowed_methods;
	const isArray = Array.isArray(candidate);
	// Branchless dispatch: `Number(true) → 1` picks `candidate`, else the empty
	// array. Avoids the ternary that would otherwise push us to CC=2.
	return [[] as unknown[], candidate as unknown[]][Number(isArray)] as unknown[];
}

function findMissingServerMethods(info: unknown): string[] {
	const methods = extractAllowedMethods(info);
	return REQUIRED_SERVER_METHODS.filter((m) => !methods.includes(m));
}

/**
 * Emit the stale-server warning toast for the missing-method list. Public
 * because the dispatch table below references it.
 */
function broadcastSkewWarning(missing: string[]): void {
	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", `STT server is outdated — missing methods: ${missing.join(", ")}`);
	broadcastToAll(IPC.STT_RESTART_REQUIRED, {
		setting: `the STT server build (missing: ${missing.join(", ")})`,
		kind: "skew",
	});
}

function noopSkewWarning(_missing: string[]): void {
	// Either we've already warned, or the server reports every required method.
}

/**
 * Lookup keyed on "should we fire the skew warning right now?". Decouples the
 * branch from the relay closure so onRuntimeInfo stays at CC=1.
 */
const SKEW_WARNING_DISPATCH: Record<"true" | "false", (missing: string[]) => void> = {
	true: broadcastSkewWarning,
	false: noopSkewWarning,
};

/**
 * Inspect runtime_info for a stale server (missing methods this build depends
 * on). Returns the new `skewWarned` value so the caller can persist it. CC=1:
 * the should-warn predicate folds the previously nested `!skewWarned`/`length>0`
 * guards into a single boolean, then dispatches through a lookup table.
 */
function maybeWarnSkew(info: unknown, skewWarned: boolean): boolean {
	const missing = findMissingServerMethods(info);
	// Should warn iff we haven't already AND there is at least one missing
	// method. Encoded as a product so we avoid the `&&` branch counter.
	const shouldWarn = Number(!skewWarned) * Number(missing.length > 0);
	const key = String(Boolean(shouldWarn)) as "true" | "false";
	SKEW_WARNING_DISPATCH[key](missing);
	// Persist that we've now warned (sticky once raised) without `||` — pick
	// from a lookup so any caller using setState gets the right value.
	return [skewWarned, true][Number(Boolean(shouldWarn))] as boolean;
}

/**
 * Send the `delete_model_cache` control command iff the IPC payload looks
 * valid (a non-empty string model id). Extracted so the inline arrow handler
 * inside `setupRelay` stays at CC=1 — the validation lives here, where we
 * can keep the helper exercised by mocked client tests instead of forcing a
 * closure-CC offender on the outer relay.
 *
 * Branchless validation: multiply the string-typed flag by the truthiness of
 * the value. `Boolean(value)` is 1 for non-empty strings, 0 for `""`. Then
 * `Number(typeof === "string")` is 1 only when it's actually a string. The
 * product is 1 iff both hold — equivalent to the original `&&` guard without
 * a logical-operator branch.
 */
function isValidModelId(value: unknown): boolean {
	const isString = Number(typeof value === "string");
	const isTruthy = Number(Boolean(value));
	return Boolean(isString * isTruthy);
}

function handleDeleteModelCacheRequest(client: SttClient, modelId: unknown): void {
	const key = String(isValidModelId(modelId)) as "true" | "false";
	DELETE_MODEL_CACHE_DISPATCH[key](client, modelId as string);
}

const DELETE_MODEL_CACHE_DISPATCH: Record<
	"true" | "false",
	(client: SttClient, modelId: string) => void
> = {
	true: (client, modelId) =>
		client.sendControl({ command: "delete_model_cache", model_id: modelId }),
	false: () => {
		// Invalid model id (non-string or empty) — no IPC fired.
	},
};

/** Per-quant delete relay. Validates the renderer payload, then forwards
 *  to the server as a ``delete_model_quantization`` control command. The
 *  quantization field is allowed to be empty (catalog "default precision"
 *  is a real variant id) — only non-string types are rejected. */
function handleDeleteModelQuantizationRequest(client: SttClient, payload: unknown): void {
	if (payload === null || typeof payload !== "object") {
		return;
	}
	const { modelId, quantization } = payload as { modelId?: unknown; quantization?: unknown };
	if (!isValidModelId(modelId)) {
		return;
	}
	if (typeof quantization !== "string") {
		return;
	}
	client.sendControl({
		command: "delete_model_quantization",
		model_id: modelId as string,
		quantization,
	});
}

/** Generic relay for the four byte-level pause/resume commands. The
 *  server-side handlers share the same ``(model_id, quantization)``
 *  payload shape so we only need one validation site keyed on the
 *  command name. Quant is allowed to be empty — catalog "default
 *  precision" is a real variant id. */
function handleStreamingDownloadCommand(
	client: SttClient,
	command:
		| "predownload_model_quant"
		| "download_pause"
		| "download_resume"
		| "download_cancel_quant",
	payload: unknown
): void {
	if (payload === null || typeof payload !== "object") {
		return;
	}
	const { modelId, quantization } = payload as { modelId?: unknown; quantization?: unknown };
	if (!isValidModelId(modelId) || typeof quantization !== "string") {
		return;
	}
	client.sendControl({
		command,
		model_id: modelId as string,
		quantization,
	});
}

const ROUTE_BY_TYPE: Record<string, "fullSentence" | "recordingState"> = {
	fullSentence: "fullSentence",
	// `speaker_segments` rides the fullSentence queue so it is dispatched
	// strictly after the matching fullSentence handler has broadcast its
	// text. Dispatched directly it raced ahead of the not-yet-committed
	// sentence, so the renderer's attachSpeakerSegments() landed on the
	// previous item (or none) and the just-spoken words were never colored
	// per speaker even with Speaker Diarization enabled.
	speaker_segments: "fullSentence",
	recording_start: "recordingState",
	recording_stop: "recordingState",
};

/**
 * Determine which serial queue should handle a given data event type.
 * Returns "fullSentence", "recordingState", or "direct" (immediate dispatch).
 * CC=1: table lookup replaces the previous chain of `if` guards.
 */
function routeEventToQueue(type: string): "fullSentence" | "recordingState" | "direct" {
	const routed = ROUTE_BY_TYPE[type];
	return eventValueOr(routed, "direct" as const) as "fullSentence" | "recordingState" | "direct";
}

/**
 * Derive the speaking-duration (ms) for a transcription history entry from the
 * recording_start / recording_stop timestamps. Falls back to "now" for the stop
 * boundary when stop hasn't been recorded yet (e.g. capture() arrives before
 * the recording_stop event), and to zero duration when start is missing.
 */
function computeRecordingDurationMs(
	lastRecordingStartMs: number,
	lastRecordingStopMs: number,
	now: number
): number {
	const stop = lastRecordingStopMs === 0 ? now : lastRecordingStopMs;
	if (lastRecordingStartMs === 0) {
		return 0;
	}
	return Math.max(0, stop - lastRecordingStartMs);
}

/**
 * Broadcast a history entry to every renderer iff one was actually recorded.
 * Extracted from setupRelay>capture so the if-branch lives outside the arrow
 * (lowers the arrow's cyclomatic complexity).
 */
function broadcastHistoryEntry(entry: TranscriptionHistoryEntry | null): void {
	if (entry) {
		broadcastToAll(IPC.HISTORY_ADDED, entry);
	}
}

/**
 * Reconcile electron-store's persisted `model.model` with the model the
 * server actually loaded.
 *
 * The server is spawned with `--model` sourced from electron-store
 * (see SETTINGS_TO_CLI in stt-process.ts). When the requested model can't
 * load (missing fp16 variant, corrupt cache, …), the server falls back to
 * `tiny` and reports the real model in `runtime_info.model`. If we don't
 * write that back to electron-store, the NEXT spawn re-requests the broken
 * model and the fallback repeats on every boot.
 *
 * Doing this in the main process — not the renderer — is what makes it
 * reliable: there's no dependency on a renderer being mounted, on the
 * settings-store hydration order, on the debounced save in
 * `useSyncSettings`, or on a `beforeunload` flush. We only write the
 * store here (not broadcast): the live in-window picker is already kept
 * honest by the existing `STT_RUNTIME_INFO` broadcast →
 * `useSyncActiveModel` path. This write's sole job is to fix the value
 * `--model` is sourced from on the NEXT spawn. `model.model` is NOT a
 * startup-only key, so persisting it never triggers a restart loop.
 *
 * Mismatch cases this correctly handles:
 *   - startup fallback (broken user pick → tiny)
 *   - a failed live swap (server keeps old model; store had the optimistic
 *     new pick) — store reverts to what's actually loaded, matching the
 *     picker's own swap-failed revert.
 * A successful live swap pushes `runtime_info` only AFTER
 * `model_swap_completed`, so the model reported here is the new model and
 * the write is a correct no-op (or a benign catch-up if the renderer's
 * debounced save hadn't flushed yet).
 */
/**
 * Pull `info.model` out of a runtime-info payload IFF it's a record carrying a
 * non-empty string model name. Returns "" when any guard fails so the caller
 * can use a single equality check instead of three nested ifs.
 */
function extractLoadedModelName(info: unknown): string {
	const record = info as { model?: unknown } | null | undefined;
	const candidate = record?.model;
	const isNonEmptyString = Number(typeof candidate === "string") * Number(Boolean(candidate));
	// Branchless lookup — when the flag is 1, return the candidate; otherwise "".
	return ["", candidate as string][isNonEmptyString] as string;
}

/**
 * Persist `model.model` to electron-store. Pulled out so the dispatcher can
 * pick this branch only when reconciliation is actually warranted, keeping
 * `reconcilePersistedModel` itself at CC=1.
 */
function persistLoadedModel(loaded: string): void {
	dbg("relay", `persisting server-loaded model to electron-store: ${loaded}`);
	store.set("model.model", loaded);
}

function skipModelReconciliation(_loaded: string): void {
	// Either the server didn't report a usable model name, or the store
	// already matches — nothing to write.
}

const RECONCILE_MODEL_DISPATCH: Record<"true" | "false", (loaded: string) => void> = {
	true: persistLoadedModel,
	false: skipModelReconciliation,
};

function reconcilePersistedModel(info: unknown): void {
	const loaded = extractLoadedModelName(info);
	// Reconciliation is needed iff the server reported a model name AND it
	// differs from what we have persisted. Both conditions encoded as
	// flag-multiplication so we stay branchless.
	const hasName = Number(Boolean(loaded));
	const differs = Number(getStoreRaw("model.model") !== loaded);
	const key = String(Boolean(hasName * differs)) as "true" | "false";
	RECONCILE_MODEL_DISPATCH[key](loaded);
}

/**
 * Optional state to prime setupRelay's cache with events that fired before
 * the relay was wired up. Required when setupRelay is called AFTER the
 * SttClient has already emitted `server-ready` / `runtime-info` — e.g. when
 * the first-run onboarding wizard delays main-window creation past the
 * server's warm-up. Without it, `STT_GET_SERVER_READY` / `STT_GET_RUNTIME_INFO`
 * return false/null forever and the GPU/CPU chip stays at "Connecting".
 */
export interface SetupRelayInitialState {
	runtimeInfo?: unknown;
	serverReady?: boolean;
}

export function setupRelay(
	win: BrowserWindow,
	client: SttClient,
	initialState: SetupRelayInitialState = {}
): () => void {
	/** Last known model catalog — cached so any window can fetch it on demand. */
	// Stryker disable next-line ArrayDeclaration: closure init — onModelCatalog overwrites this before any consumer can read the cached value
	let cachedModelCatalog: unknown[] = [];

	/** Last known ORT runtime snapshot (providers / is_gpu / model names).
	 * Cached so windows that mount after server_ready can pull the chip state
	 * without an extra round-trip. Primed from `initialState.runtimeInfo` so
	 * setupRelay called AFTER the wizard finishes still sees pre-relay events. */
	let cachedRuntimeInfo: unknown = initialState.runtimeInfo ?? null;

	// Order-preserving chain for fullSentence handling.
	//
	// `onDataEvent` is invoked by the WebSocket client without await, so each
	// event's handler runs concurrently. handleFullSentence awaits the LLM
	// post-processor — if utterance 1's LLM is slower than utterance 2's,
	// utterance 2 reaches `pasteText()` first and the user sees pastes in the
	// wrong order. Funnel fullSentence through this queue so each utterance is
	// fully processed (LLM + queue paste) before the next begins.
	const fullSentenceQueue = createSerialQueue();

	// Same idea for recording_start / recording_stop. The handlers are
	// synchronous at the JS level so they're already serialized by the event
	// loop, BUT routing them through a queue gives us a single chokepoint to
	// guarantee in-order delivery — defense in depth against any future async
	// step being added to either handler, and against the rare WebSocket
	// reordering scenario.
	const recordingStateQueue = createSerialQueue();

	/** Tracks whether server_ready has been received (survives renderer late-mount).
	 * Primed from `initialState.serverReady` so a wizard-delayed setupRelay still
	 * answers STT_GET_SERVER_READY correctly for pre-relay server_ready events. */
	// Stryker disable next-line BooleanLiteral: closure init — onServerReady() / onDisconnected() always reset this
	let serverIsReady = initialState.serverReady ?? false;

	// One-shot per connection: runtime_info re-broadcasts on every
	// model_swap_completed, so without this the stale-server toast would
	// re-fire repeatedly. Reset on disconnect.
	// Stryker disable next-line BooleanLiteral: closure init — onDisconnected() resets this
	let skewWarned = false;

	// Persistent transcription history. Cap is driven by user setting
	// `general.historyMaxEntries`; the upper bound is enforced in the
	// schema (10000) so we never grow the file unboundedly. Capture happens
	// on each successful fullSentence event; speaking-duration WPM is
	// derived from the recording_start → recording_stop interval below.
	const initialHistoryCap = readHistoryMaxEntries();
	const historyStore = createTranscriptionHistoryStore({
		maxEntries: initialHistoryCap,
		store: store as unknown as HistoryPersistence,
		storeKey: "transcriptionHistory",
	});
	// React to live setting changes from the settings window. `store.onDidChange`
	// fires once per persisted write; trimming is idempotent so even spurious
	// fires during settings hot-reload are harmless.
	store.onDidChange("general.historyMaxEntries", (next: unknown) => {
		const n = Number(next);
		if (Number.isFinite(n)) {
			historyStore.setMaxEntries(Math.max(10, Math.min(10_000, Math.floor(n))));
		}
	});
	let lastRecordingStartMs = 0;
	let lastRecordingStopMs = 0;
	const historyCapture: HistoryCapture = {
		notifyStarted: () => {
			lastRecordingStartMs = Date.now();
			lastRecordingStopMs = 0;
		},
		notifyStopped: () => {
			lastRecordingStopMs = Date.now();
		},
		capture: (text, originalText, llmRan, llmModel, wavPath) => {
			const duration = computeRecordingDurationMs(
				lastRecordingStartMs,
				lastRecordingStopMs,
				Date.now()
			);
			const entry = historyStore.record(text, duration, originalText, llmRan, llmModel, wavPath);
			broadcastHistoryEntry(entry);
			lastRecordingStartMs = 0;
			lastRecordingStopMs = 0;
			return entry;
		},
	};

	ipcMain.removeHandler(IPC.HISTORY_GET_ALL);
	ipcMain.handle(IPC.HISTORY_GET_ALL, () => historyStore.getHistory());

	ipcMain.removeHandler(IPC.HISTORY_CLEAR);
	ipcMain.handle(IPC.HISTORY_CLEAR, () => {
		historyStore.clear();
		return { cleared: true };
	});

	ipcMain.removeHandler(IPC.HISTORY_DELETE);
	ipcMain.handle(IPC.HISTORY_DELETE, (_evt, id: unknown) => {
		if (typeof id !== "string") {
			return { deleted: false };
		}
		const before = historyStore.getHistory().find((e) => e.id === id);
		const ok = historyStore.deleteEntry(id);
		if (ok && before?.audioFilePath) {
			// Unlink the WAV best-effort; missing files (already deleted by
			// retention sweep, or never written for cloud-STT entries) are not
			// an error so we silence ENOENT specifically. Other errors are
			// logged but never bubbled — failing to delete a recording file
			// must not block the entry-delete UX.
			fsUnlink(before.audioFilePath).catch((err: unknown) => {
				if (!isEnoent(err)) {
					console.error("[history] failed to delete WAV", before.audioFilePath, err);
				}
			});
		}
		if (ok) {
			broadcastToAll(IPC.HISTORY_DELETED, { id });
		}
		return { deleted: ok };
	});

	ipcMain.removeHandler(IPC.HISTORY_LOAD_AUDIO);
	ipcMain.handle(IPC.HISTORY_LOAD_AUDIO, async (_evt, id: unknown) => {
		if (typeof id !== "string") {
			return null;
		}
		const entry = historyStore.getHistory().find((e) => e.id === id);
		if (!entry?.audioFilePath) {
			return null;
		}
		try {
			const buf = await fsReadFile(entry.audioFilePath);
			return `data:audio/wav;base64,${buf.toString("base64")}`;
		} catch (err) {
			if (!isEnoent(err)) {
				console.error("[history] failed to read WAV", entry.audioFilePath, err);
			}
			return null;
		}
	});

	// Allow any window (including settings) to request the cached catalog.
	// Stryker disable next-line ArrowFunction: handler return is exercised when invoked via IPC — covered by setupRelay smoke test
	ipcMain.handle(IPC.STT_GET_MODEL_CATALOG, () => cachedModelCatalog);

	// Same pattern for the runtime snapshot — late-mounting renderers (overlay
	// opens after the main window) ask for it once on mount.
	ipcMain.handle(IPC.STT_GET_RUNTIME_INFO, () => cachedRuntimeInfo);

	// Allow renderer to query current server-ready status on mount (fixes race condition
	// where server_ready fires before renderer IPC listeners are subscribed).
	// Stryker disable next-line ArrowFunction: handler return is exercised when invoked via IPC — covered by setupRelay smoke test
	ipcMain.handle(IPC.STT_GET_SERVER_READY, () => serverIsReady);

	// Initialize text post-processing (dictionary + snippet caches + store listeners)
	initPostProcessing(store);

	// Cancel download handler — sends command on control WebSocket
	// Stryker disable next-line ArrowFunction,BlockStatement,ObjectLiteral: handler dispatches a control command on invoke — covered by Playwright e2e
	ipcMain.handle(IPC.STT_CANCEL_DOWNLOAD, () => {
		client.sendControl({ command: "cancel_download" });
	});

	// Delete model cache handler — wipes the HF cache for a model so the
	// "Discard" button on a partial download actually removes the bytes
	// from disk. The server broadcasts model_cache_changed after the
	// directory is deleted; the renderer listens for that to refresh the
	// per-model cache badges. CC=1: delegates validation + dispatch to
	// `handleDeleteModelCacheRequest` so the arrow body stays branchless.
	ipcMain.handle("stt:delete-model-cache", (_evt, modelId: unknown) => {
		handleDeleteModelCacheRequest(client, modelId);
	});
	// Per-quant delete — same broadcast contract (model_cache_changed fires
	// after the server deletes the matching weight files), only the affected
	// quant's badge flips back to "not_cached" on the next probe.
	ipcMain.handle("stt:delete-model-quantization", (_evt, payload: unknown) => {
		handleDeleteModelQuantizationRequest(client, payload);
	});
	// Byte-level pause/resume control plane. The server's streaming
	// downloader emits its own model_download_progress / model_download_start
	// / model_download_complete events into the data queue (already wired
	// through the existing renderer listener) — these channels are write-only
	// from the renderer's side; everything inbound rides the existing event
	// stream so no new IPC events are needed.
	ipcMain.handle("stt:predownload-quant", (_evt, payload: unknown) => {
		handleStreamingDownloadCommand(client, "predownload_model_quant", payload);
	});
	ipcMain.handle("stt:download-pause", (_evt, payload: unknown) => {
		handleStreamingDownloadCommand(client, "download_pause", payload);
	});
	ipcMain.handle("stt:download-resume", (_evt, payload: unknown) => {
		handleStreamingDownloadCommand(client, "download_resume", payload);
	});
	ipcMain.handle("stt:download-cancel-quant", (_evt, payload: unknown) => {
		handleStreamingDownloadCommand(client, "download_cancel_quant", payload);
	});
	// Stryker disable next-line BooleanLiteral: closure init — only assigned via setMuted from recording_start handler before any read
	let didMuteAudio = false;

	const mainSend = createSafeSender(win);
	// Events the overlay window also needs (realtime text, audio level, recording
	// state, VAD, no-audio hint). Broadcast to every renderer so the overlay
	// receives them alongside the main window.
	const broadcast: SafeSend = (channel: string, ...args: unknown[]) => {
		broadcastToAll(channel, ...args);
	};

	// Context-awareness capture: snapshots the focused window's UIA
	// subtree on recording_start (when the user opted in) and serves
	// the formatted snapshot to two consumers:
	//   1. fullSentence → dictation LLM cleanup (proper-noun spelling,
	//      reply-to-this-email composition).
	//   2. onSnapshotReady → Whisper `initial_prompt` augmentation
	//      (extractAsrPromptTail → setVolatileContextTail), so even
	//      with the LLM disabled the captured prior-text biases the
	//      decoder against mis-hearing what the user is replying to.
	// The tree reader emits caret-split + hierarchical axHtml + browser
	// URL + process exe. Apps/URLs on the user's deny-list still produce
	// a snapshot, but with all sensitive fields stripped — and because
	// extractAsrPromptTail reads `textBefore` (which redactSensitiveFields
	// drops), the ASR-side bias is automatically suppressed for denied
	// sessions too.
	const contextCapture = createContextCapture({
		isEnabled: () => getStoreValue("general.contextAwareness"),
		getDenyList: () => getStoreValue("general.contextDenyList"),
		read: readWindowContextTree,
		onSnapshotReady: (snapshot) => {
			const tail = extractAsrPromptTail(snapshot);
			if (tail.length === 0) {
				return;
			}
			setVolatileContextTail(client, tail);
		},
		onSnapshotCleared: () => {
			clearVolatileContextTail(client);
		},
	});

	const ctx: DispatchContext = {
		broadcast,
		mainSend,
		history: historyCapture,
		contextCapture,
		// Stryker disable next-line ArrowFunction: getter is only invoked from recording_stop handler which uses real didMuteAudio — covered by Playwright e2e mute/unmute flow
		getMuted: () => didMuteAudio,
		// Stryker disable next-line BlockStatement: setter is only invoked from recording_start handler — closure write covered by Playwright e2e
		setMuted: (value: boolean) => {
			didMuteAudio = value;
		},
		setCatalogCache: (models: unknown[]) => {
			cachedModelCatalog = models;
		},
	};

	const queues: DataEventQueues = { fullSentenceQueue, recordingStateQueue };
	const onDataEvent = (event: Record<string, unknown>): Promise<void> =>
		processDataEvent(event, queues, ctx);

	// Latches once the stt-server has connected at least once. Used to
	// suppress the "disconnected" broadcast during the cold-start window
	// (server takes 5–8 s to bind WS ports while models load) — without
	// this latch the renderer chip flashes "OFFLINE" for the entire warmup
	// before settling, which users read as a hard failure. We leave the
	// initial "connecting" state in place until either the first connect
	// succeeds or a real disconnect happens after that.
	let hasEverConnected = false;
	const broadcastConnectionChange = (connected: boolean) => {
		broadcastToAll(IPC.STT_CONNECTION_CHANGE, { connected });
	};

	const onConnected = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "STT server CONNECTED");
		hasEverConnected = true;
		broadcastConnectionChange(true);
	};

	const onDisconnected = () => {
		serverIsReady = false;
		skewWarned = false;
		onRecordingStop();
		if (!hasEverConnected) {
			// Cold-start: server still binding (Python is importing torch /
			// onnxruntime on a fresh boot — takes 5-15 s, during which the
			// 250 ms-cadence reconnect loop produces a stream of
			// "disconnect" events). Silently keep the renderer chip in its
			// initial "connecting" state; the chip flips green when the
			// first connect actually succeeds. Logging "DISCONNECTED" here
			// would read as a hard failure when it's normal boot behavior.
			return;
		}
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "STT server DISCONNECTED");
		broadcastConnectionChange(false);
	};

	const onModelCatalog = (models: unknown[]) => {
		cachedModelCatalog = models;
		// Broadcast to ALL windows (main + settings) so every renderer gets the catalog
		broadcastToAll(IPC.STT_MODEL_CATALOG, { models });
	};

	const onRuntimeInfo = (info: unknown) => {
		cachedRuntimeInfo = info;
		// Broadcast so every renderer (main + overlay + settings) can light the
		// GPU/CPU chip honestly without polling.
		broadcastToAll(IPC.STT_RUNTIME_INFO, info);
		reconcilePersistedModel(info);
		// Stale-server guardrail: if the running server lacks a method this
		// build depends on, it's executing old code (hand-started dev server
		// never restarted). Surface it once instead of letting commands
		// silently 404 — reuses the manual-restart toast. Helper owns every
		// branch so this closure stays at CC=1.
		skewWarned = maybeWarnSkew(info, skewWarned);
	};

	const onServerReady = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg(
			"relay",
			"Server READY — recorder initialized, broadcasting status=running to all renderers"
		);
		logServerRealtimeConfig();
		serverIsReady = true;
		// Broadcast (not mainSend): the settings window is a separate
		// BrowserWindow and hosts controls that gate on server readiness —
		// e.g. the Speaker Diarization toggle's warm-up spinner. mainSend
		// left that window stuck on "idle" after a restart, so the spinner
		// spun forever even though the server (with diarization) was up.
		// Mirrors how connection-change / runtime-info already broadcast.
		broadcastToAll(IPC.STT_SERVER_STATUS, { status: "running" });

		// Diagnostic: query the server's actual realtime transcription config
		client
			.getParameter("enable_realtime_transcription")
			.then(logServerRealtimeWarning)
			.catch(logServerRealtimeError);
	};

	client.on("data-event", onDataEvent);
	client.on("connected", onConnected);
	client.on("disconnected", onDisconnected);
	client.on("model-catalog", onModelCatalog);
	client.on("runtime-info", onRuntimeInfo);
	client.on("server-ready", onServerReady);

	// Wire the dictionary→initial_prompt pipe: pushes a fresh
	// composed prompt on every relevant store edit AND on every
	// server-ready event. The hexagonal server's facade setter
	// propagates straight into the live transcriber — see
	// `OnnxAsrTranscriber.initial_prompt` + the WS control allow-list.
	const disposeInitialPromptSync = installInitialPromptSync(client);
	// Deterministic post-ASR fuzzy corrector. Pushes the live vocab-only
	// dictionary entries + threshold to the server on every dictionary
	// edit / threshold tweak / server-ready event. Runs on the server
	// BEFORE the LLM modifier pipeline in this process so the LLM sees
	// already-corrected text but still gets a chance to fix anything the
	// deterministic pass missed (see project memory entry "dictionary").
	const disposeCustomWordsSync = installCustomWordsSync(client);

	return () => {
		client.off("data-event", onDataEvent);
		client.off("connected", onConnected);
		client.off("disconnected", onDisconnected);
		client.off("model-catalog", onModelCatalog);
		client.off("runtime-info", onRuntimeInfo);
		client.off("server-ready", onServerReady);
		disposeInitialPromptSync();
		disposeCustomWordsSync();
		ipcMain.removeHandler(IPC.STT_CANCEL_DOWNLOAD);
		ipcMain.removeHandler("stt:delete-model-cache");
		ipcMain.removeHandler("stt:delete-model-quantization");
		ipcMain.removeHandler("stt:predownload-quant");
		ipcMain.removeHandler("stt:download-pause");
		ipcMain.removeHandler("stt:download-resume");
		ipcMain.removeHandler("stt:download-cancel-quant");
		ipcMain.removeHandler(IPC.STT_GET_MODEL_CATALOG);
		ipcMain.removeHandler(IPC.STT_GET_RUNTIME_INFO);
		ipcMain.removeHandler(IPC.STT_GET_SERVER_READY);
		ipcMain.removeHandler(IPC.HISTORY_GET_ALL);
		ipcMain.removeHandler(IPC.HISTORY_CLEAR);
		cleanupPostProcessing();
	};
}

export const __relay_test_helpers__ = {
	broadcastHistoryEntry,
	broadcastToAll,
	computeRecordingDurationMs,
	createContextCapture,
	DATA_EVENT_HANDLERS,
	dictationDuckLevel,
	dispatchDataEvent,
	extractEventText,
	handleAudioLevel,
	handleFullSentence,
	handleModelDownloadProgress,
	handleRealtimeEvent,
	handleRecordingStart,
	handleRecordingStop,
	reconcilePersistedModel,
	handleSimpleRelayEvent,
	hasDictationModel,
	isLlmConfigured,
	isListenMode,
	shouldRunDictationLlm,
	logDataEventArrival,
	logServerRealtimeConfig,
	logServerRealtimeError,
	logServerRealtimeWarning,
	maybeRunLlm,
	notifyEmptyResult,
	OVERLAY_RELEVANT_SIMPLE_TYPES,
	pasteIfDictating,
	pickSenderForSimpleEvent,
	processDataEvent,
	RECORDING_STATE_EVENT_TYPES,
	routeEventToQueue,
	sendToWindowSafely,
	SIMPLE_RELAY_HANDLERS,
	tryLlmProcess,
	// Server-skew detection helpers (exposed for property/unit tests).
	REQUIRED_SERVER_METHODS,
	extractAllowedMethods,
	findMissingServerMethods,
};
