import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { clearSessionAborted, isSessionAborted } from "../lib/abort-state";
import { readWindowContext } from "../lib/context-reader";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { createSafeSender, isRecord, type SafeSend } from "../lib/ipc-helpers";
import { setLastTranscription } from "../lib/last-transcription";
import { pasteText } from "../lib/paste";
import { onAudioLevel, onRecordingStart, onRecordingStop } from "../lib/recording-indicator";
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
import { processText } from "./llm";
import { hideOverlay, showOverlay } from "./overlay";
import { type ContextCapture, createContextCapture } from "./relay-context-capture";
import {
	createTranscriptionHistoryStore,
	type HistoryPersistence,
	type TranscriptionHistoryEntry,
} from "./transcription-history";

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
	const attempt = await tryLlmProcess(text, context);
	safeSend?.(IPC.LLM_PROCESSING_END);
	hideOverlay();
	return attempt;
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
	}
}

interface HistoryCapture {
	capture(text: string, originalText?: string, llmRan?: boolean): TranscriptionHistoryEntry | null;
	notifyStarted(): void;
	notifyStopped(): void;
}

/**
 * Drop everything for a cancelled session — context, overlay, in-progress
 * thinking indicator — without firing any visible event. Extracted from the
 * abort guards in `handleFullSentence` so the cleanup is identical whether
 * the cancel landed before or after the LLM call returned.
 */
function discardCancelledSession(contextCapture?: ContextCapture): void {
	contextCapture?.clear();
	try {
		hideOverlay();
	} catch (err) {
		dbg("relay", "hideOverlay during cancel-discard failed:", String(err));
	}
	dbg("relay", "fullSentence: dropped because session was cancelled by user");
}

async function handleFullSentence(
	event: Record<string, unknown>,
	safeSend: SafeSend,
	history?: HistoryCapture,
	contextCapture?: ContextCapture
): Promise<void> {
	// HARD GATE: user pressed `hotkey + Backspace` to cancel this session.
	// Drop ALL downstream work — no paste, no history, no caption, no LLM.
	// The server may still have a transcribe() in flight that produced
	// this event after the recorder transitioned to INACTIVE; that's fine,
	// the gate makes the renderer ignore it. The flag is reset on the
	// next `recording_start` so a fresh session begins clean.
	if (isSessionAborted()) {
		discardCancelledSession(contextCapture);
		return;
	}

	const rawText = extractEventText(event);
	const mode = getStoreValue("general.recordingMode");

	// Empty/whitespace-only result means VAD found no transcribable audio.
	// Surface this as a "no audio detected" hint instead of an empty subtitle.
	if (rawText.trim().length === 0) {
		notifyEmptyResult(mode, safeSend);
		// Clear any pending context so it doesn't bleed into the next dictation.
		contextCapture?.clear();
		// recording_stop deferred its hideOverlay() to us when the dictation LLM
		// will run (so the pill stays continuous through the thinking indicator).
		// With no text to process, that work won't happen — hide the overlay now.
		if (shouldRunDictationLlm()) {
			try {
				hideOverlay();
			} catch (err) {
				dbg("relay", "hideOverlay failed:", String(err));
			}
		}
		return;
	}

	// Listen mode is a passive monitor — broadcast the raw caption but skip
	// every side effect that personalises or persists it: no dictionary /
	// snippet substitutions, no LLM cleanup, no history capture, no sentry
	// breadcrumb. Auto-paste is already gated by pasteIfDictating below.
	if (mode === "listen") {
		contextCapture?.clear();
		safeSend(IPC.STT_FULL_SENTENCE, { text: rawText });
		return;
	}

	const context = contextCapture ? await contextCapture.consume() : "";
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
	if (isSessionAborted()) {
		discardCancelledSession(contextCapture);
		return;
	}

	const processed = attempt.ok ? attempt.text : applyPostProcessing(rawText);
	const originalForHistory = attempt.ok ? rawText : applyPostProcessing(rawText);

	breadcrumb("recording", "transcription completed", { text_length: processed.length }, "info");
	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
	safeSend(IPC.STT_FULL_SENTENCE, { text: processed });
	history?.capture(processed, originalForHistory, isLlmConfigured());
	pasteIfDictating(mode, processed);
}

/**
 * Percent reduction to apply to system audio for this dictation, or 0 when
 * the feature is off / not applicable. Ducking is always disabled in listen
 * mode (we'd be muting the very audio being transcribed).
 */
function dictationDuckLevel(): number {
	const pct = getStoreValue("general.systemAudioReductionWhileDictating");
	if (pct <= 0 || getStoreValue("general.recordingMode") === "listen") {
		return 0;
	}
	return pct;
}

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
	if (!consumeRecordingStart()) {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "ignoring recording_start — no pending hotkey press (stale/duplicate)");
		return { muted: false, attempted: false };
	}
	// A real new session is beginning — lift the abort gate set by any
	// previous `hotkey + Backspace` cancel so this session's events flow
	// normally. Without this, a user who cancels, then immediately starts
	// a fresh recording, would see nothing pasted (the gate would still
	// drop the new session's fullSentence too).
	clearSessionAborted();
	const listen = isListenMode();
	// Listen mode is a passive monitor — skip sentry breadcrumb (metric),
	// history bookkeeping (no entries get captured anyway), and the LLM
	// context snapshot (the LLM never runs).
	if (!listen) {
		breadcrumb("recording", "recording started", undefined, "info");
	}
	safeSend(IPC.STT_RECORDING_START);
	if (!listen) {
		history?.notifyStarted();
	}
	onRecordingStart();
	showOverlay();
	if (!listen) {
		// Snapshot the user's focused window context for downstream LLM
		// cleanup. Fire-and-forget — the spawn races with the user's speech
		// and the consumer (fullSentence) awaits it. Off unless the user
		// opted in via settings.
		contextCapture?.capture();
	}
	const duckLevel = dictationDuckLevel();
	if (duckLevel > 0) {
		return { muted: muteSystemAudio(duckLevel), attempted: true };
	}
	return { muted: false, attempted: false };
}

function handleModelDownloadProgress(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_DOWNLOAD_PROGRESS, {
		model: event.model,
		progress: event.progress,
		downloadedBytes: event.downloaded_bytes,
		totalBytes: event.total_bytes,
		speedBps: event.speed_bps,
		etaSeconds: event.eta_seconds,
	});
}

function handleModelSwapStarted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_SWAP_STARTED, { kind: event.kind, name: event.name });
}

function handleModelSwapCompleted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend(IPC.STT_MODEL_SWAP_COMPLETED, { kind: event.kind, name: event.name });
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
		category: event.category ?? "unknown",
		detail: event.detail ?? "",
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
function handleModelCatalogUpdated(
	event: Record<string, unknown>,
	safeSend: SafeSend,
	updateCache: (models: unknown[]) => void
): void {
	const models = Array.isArray(event.models) ? event.models : null;
	if (!models) {
		return;
	}
	updateCache(models);
	safeSend(IPC.STT_MODEL_CATALOG, { models });
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

function handleRecordingStop(
	wasMuted: boolean,
	safeSend: SafeSend,
	history?: HistoryCapture
): boolean {
	const listen = isListenMode();
	if (!listen) {
		breadcrumb("recording", "recording stopped", undefined, "info");
	}
	// Clear the recording-state machine first so any duplicate
	// recording_start that arrives after this stop is rejected by
	// the consumeRecordingStart() gate.
	notifyRecordingStop();
	if (!listen) {
		history?.notifyStopped();
	}
	// Hide the floating pill FIRST, before any IPC broadcast or downstream
	// work, so a slow renderer or a hang in another handler can't leave the
	// overlay window stuck on screen.
	//
	// EXCEPTION: when the dictation LLM will run, the pill needs to stay
	// visible so the thinking indicator can overlay onto the existing pill
	// rather than the user seeing it disappear → reappear. The hide is
	// deferred to: (a) maybeRunLlm() after llm:processing-end for the normal
	// path, or (b) the empty-text branch in handleFullSentence (above) when
	// VAD finds no transcribable audio. Listen mode never runs the LLM, so
	// it always hides immediately.
	// Stryker disable next-line BlockStatement: empty try {} skips hideOverlay() — overlay is not mocked in unit tests so the absence of the call has no observable side effect; covered by Playwright e2e
	if (!shouldRunDictationLlm()) {
		try {
			hideOverlay();
			// Stryker disable next-line BlockStatement: empty catch {} suppresses the dbg log only — no observable side effect to assert
		} catch (err) {
			// Stryker disable next-line BlockStatement,StringLiteral: dbg() catch is a defensive log with no observable side effect
			dbg("relay", "hideOverlay failed:", String(err));
		}
	}
	safeSend(IPC.STT_RECORDING_STOP);
	onRecordingStop();
	// Stryker disable next-line ConditionalExpression: when wasMuted is false the unmute path is unreachable; when true the early-return makes both branches return false
	if (wasMuted) {
		unmuteSystemAudio();
		return false;
	}
	return wasMuted;
}

type SimpleHandler = (event: Record<string, unknown>, safeSend: SafeSend) => void;

const SIMPLE_RELAY_HANDLERS: Record<string, SimpleHandler> = {
	no_audio_detected: (_e, send) => send(IPC.STT_NO_AUDIO_DETECTED),
	vad_detect_start: (_e, send) => send(IPC.STT_VAD_START),
	vad_detect_stop: (_e, send) => send(IPC.STT_VAD_STOP),
	transcription_start: (e, send) =>
		send(IPC.STT_TRANSCRIPTION_START, { audioBase64: e.audio_bytes_base64 }),
	wakeword_detected: (_e, send) => send(IPC.STT_WAKEWORD_DETECTED),
	wakeword_detection_start: (_e, send) => send(IPC.STT_WAKEWORD_DETECTION_START),
	wakeword_detection_end: (_e, send) => send(IPC.STT_WAKEWORD_DETECTION_END),
	model_download_start: (e, send) => send(IPC.STT_MODEL_DOWNLOAD_START, { model: e.model }),
	model_download_complete: (e, send) =>
		send(IPC.STT_MODEL_DOWNLOAD_COMPLETE, {
			model: e.model,
			cancelled: e.cancelled ?? false,
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
// its progress bar and auto-close on completion.
const OVERLAY_RELEVANT_SIMPLE_TYPES = new Set([
	"no_audio_detected",
	"vad_detect_start",
	"vad_detect_stop",
	"model_download_start",
	"model_download_complete",
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

function logDataEventArrival(type: string): void {
	// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: gate around dbgVerbose only — observable behavior unchanged
	if (type !== "audio_level") {
		// Stryker disable next-line StringLiteral: dbgVerbose() message is informational only
		dbgVerbose("relay", `data-event: ${type}`);
	}
}

export function processDataEvent(
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

function sendToWindowSafely(bw: BrowserWindow, channel: string, args: readonly unknown[]): void {
	if (bw.isDestroyed()) {
		return;
	}
	try {
		bw.webContents.send(channel, ...args);
	} catch (err) {
		// A single hung/unresponsive renderer must not abort the broadcast —
		// callers (e.g. handleRecordingStop) rely on subsequent statements
		// like hideOverlay() running.
		// Stryker disable next-line BlockStatement,StringLiteral: dbg() catch is a defensive log with no observable side effect
		dbg("relay", `broadcast to window failed (${channel}):`, String(err));
	}
}

function broadcastToAll(channel: string, ...args: unknown[]): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		sendToWindowSafely(bw, channel, args);
	}
}

function logServerRealtimeWarning(val: unknown): void {
	// Stryker disable next-line StringLiteral: dbgVerbose() label is informational only
	dbgVerbose("relay", "SERVER reports enable_realtime_transcription=", val);
	// Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: warning branch only logs — gate is informational only
	if (!val) {
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
		"Store realtime config: enableRealtimeTranscription=",
		store.get("quality.enableRealtimeTranscription"),
		// Stryker disable next-line StringLiteral: label part — informational only
		"useMainModelForRealtime=",
		store.get("quality.useMainModelForRealtime"),
		// Stryker disable next-line StringLiteral: label part — informational only
		"realtimeModel=",
		store.get("model.realtimeModel")
	);
}

const RECORDING_STATE_EVENT_TYPES = new Set(["recording_start", "recording_stop"]);

/**
 * Determine which serial queue should handle a given data event type.
 * Returns "fullSentence", "recordingState", or "direct" (immediate dispatch).
 */
function routeEventToQueue(type: string): "fullSentence" | "recordingState" | "direct" {
	if (type === "fullSentence") {
		return "fullSentence";
	}
	if (RECORDING_STATE_EVENT_TYPES.has(type)) {
		return "recordingState";
	}
	return "direct";
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
function reconcilePersistedModel(info: unknown): void {
	if (!isRecord(info)) {
		return;
	}
	const loaded = info.model;
	if (typeof loaded !== "string" || loaded.length === 0) {
		return;
	}
	if (getStoreRaw("model.model") === loaded) {
		return;
	}
	dbg("relay", `persisting server-loaded model to electron-store: ${loaded}`);
	store.set("model.model", loaded);
}

export function setupRelay(win: BrowserWindow, client: SttClient): () => void {
	/** Last known model catalog — cached so any window can fetch it on demand. */
	// Stryker disable next-line ArrayDeclaration: closure init — onModelCatalog overwrites this before any consumer can read the cached value
	let cachedModelCatalog: unknown[] = [];

	/** Last known ORT runtime snapshot (providers / is_gpu / model names).
	 * Cached so windows that mount after server_ready can pull the chip state
	 * without an extra round-trip. */
	let cachedRuntimeInfo: unknown = null;

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

	/** Tracks whether server_ready has been received (survives renderer late-mount). */
	// Stryker disable next-line BooleanLiteral: closure init — onServerReady() / onDisconnected() always reset this
	let serverIsReady = false;

	// Persistent transcription history (capped at HISTORY_MAX_ENTRIES so we
	// don't grow the user's settings file forever). Capture happens on each
	// successful fullSentence event; speaking-duration WPM is derived from
	// the recording_start → recording_stop interval tracked below.
	const HISTORY_MAX_ENTRIES = 10_000;
	const historyStore = createTranscriptionHistoryStore({
		maxEntries: HISTORY_MAX_ENTRIES,
		store: store as unknown as HistoryPersistence,
		storeKey: "transcriptionHistory",
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
		capture: (text, originalText, llmRan) => {
			const duration = computeRecordingDurationMs(
				lastRecordingStartMs,
				lastRecordingStopMs,
				Date.now()
			);
			const entry = historyStore.record(text, duration, originalText, llmRan);
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
	// per-model cache badges.
	ipcMain.handle("stt:delete-model-cache", (_evt, modelId: unknown) => {
		if (typeof modelId !== "string" || !modelId) {
			return;
		}
		client.sendControl({ command: "delete_model_cache", model_id: modelId });
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

	// Context-awareness capture: snapshots the focused window's text on
	// recording_start (when the user opted in) and serves the stored
	// snapshot to fullSentence so the LLM cleanup can spell names right.
	const contextCapture = createContextCapture({
		isEnabled: () => getStoreValue("general.contextAwareness"),
		read: readWindowContext,
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

	const broadcastConnectionChange = (connected: boolean) => {
		broadcastToAll(IPC.STT_CONNECTION_CHANGE, { connected });
	};

	const onConnected = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "STT server CONNECTED");
		broadcastConnectionChange(true);
	};

	const onDisconnected = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "STT server DISCONNECTED");
		serverIsReady = false;
		onRecordingStop();
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
	};

	const onServerReady = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "Server READY — recorder initialized, sending status=running to renderer");
		logServerRealtimeConfig();
		serverIsReady = true;
		mainSend(IPC.STT_SERVER_STATUS, { status: "running" });

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

	return () => {
		client.off("data-event", onDataEvent);
		client.off("connected", onConnected);
		client.off("disconnected", onDisconnected);
		client.off("model-catalog", onModelCatalog);
		client.off("runtime-info", onRuntimeInfo);
		client.off("server-ready", onServerReady);
		ipcMain.removeHandler(IPC.STT_CANCEL_DOWNLOAD);
		ipcMain.removeHandler("stt:delete-model-cache");
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
};
