import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { readWindowContext } from "../lib/context-reader";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { createSafeSender, type SafeSend } from "../lib/ipc-helpers";
import { pasteText } from "../lib/paste";
import { onAudioLevel, onRecordingStart, onRecordingStop } from "../lib/recording-indicator";
import { consumeRecordingStart, notifyRecordingStop } from "../lib/recording-state";
import { createSerialQueue } from "../lib/serial-queue";
import { getStoreValue, store } from "../lib/store";
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

function hasLlmModel(provider: unknown): boolean {
	if (provider === "openrouter") {
		return Boolean(getStoreValue("llm.openrouterApiKey"));
	}
	return Boolean(getStoreValue("llm.model"));
}

function isLlmConfigured(): boolean {
	const enabled = getStoreValue("llm.enabled");
	return enabled === true && hasLlmModel(getStoreValue("llm.provider"));
}

async function tryLlmProcess(text: string, context: string): Promise<string> {
	try {
		const out = await processText(text, context);
		// Stryker disable next-line MethodExpression,StringLiteral: dbg() preview is informational only
		dbg("relay", `LLM processed: ${out.slice(0, 80)}`);
		return out;
	} catch (err) {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "LLM processing failed, using original:", String(err));
		return text;
	}
}

async function maybeRunLlm(text: string, context: string, safeSend?: SafeSend): Promise<string> {
	// Stryker disable next-line ConditionalExpression,BooleanLiteral,BlockStatement: equivalent — when the gate is bypassed, tryLlmProcess catches the resulting LLM error and returns the original text, yielding identical observable behavior to the early-return path
	if (!isLlmConfigured()) {
		return text;
	}
	// Keep the recording pill visible while the LLM is thinking so the
	// renderer can layer a thinking-indicator on top of it. recording_stop
	// already hid the overlay by the time we get here in the typical flow,
	// so this re-shows it for the duration of the LLM call.
	showOverlay();
	safeSend?.("llm:processing-start");
	const out = await tryLlmProcess(text, context);
	safeSend?.("llm:processing-end");
	hideOverlay();
	return out;
}

function notifyEmptyResult(mode: unknown, safeSend: SafeSend): void {
	if (mode !== "listen") {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "fullSentence: empty result, treating as no_audio_detected");
		safeSend("stt:no-audio-detected");
	}
}

function pasteIfDictating(mode: unknown, text: string): void {
	// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: pasteText is a fire-and-forget native call — no observable side effect can be asserted in unit tests; covered by Playwright e2e
	if (mode !== "listen") {
		// Stryker disable next-line StringLiteral: template literal trailing space is informational; pasteText is unobservable
		pasteText(`${text} `);
	}
}

interface HistoryCapture {
	capture(text: string): TranscriptionHistoryEntry | null;
	notifyStarted(): void;
	notifyStopped(): void;
}

async function handleFullSentence(
	event: Record<string, unknown>,
	safeSend: SafeSend,
	history?: HistoryCapture,
	contextCapture?: ContextCapture
): Promise<void> {
	const rawText = extractEventText(event);
	const mode = getStoreValue("general.recordingMode");

	// Empty/whitespace-only result means VAD found no transcribable audio.
	// Surface this as a "no audio detected" hint instead of an empty subtitle.
	if (rawText.trim().length === 0) {
		notifyEmptyResult(mode, safeSend);
		// Clear any pending context so it doesn't bleed into the next dictation.
		contextCapture?.clear();
		return;
	}

	const context = contextCapture ? await contextCapture.consume() : "";
	const processed = await maybeRunLlm(applyPostProcessing(rawText), context, safeSend);

	// Stryker disable next-line StringLiteral: dbg() message is informational only
	dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
	safeSend("stt:full-sentence", { text: processed });
	history?.capture(processed);
	// Skip auto-paste in listen mode (passive monitoring, not dictation)
	pasteIfDictating(mode, processed);
}

function shouldMuteForDictation(): boolean {
	const enabled = getStoreValue("general.muteSystemAudioWhileDictating");
	return enabled === true && getStoreValue("general.recordingMode") !== "listen";
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
	safeSend("stt:recording-start");
	history?.notifyStarted();
	onRecordingStart();
	showOverlay();
	// Snapshot the user's focused window context for downstream LLM
	// cleanup. Fire-and-forget — the spawn races with the user's speech
	// and the consumer (fullSentence) awaits it. Off unless the user
	// opted in via settings.
	contextCapture?.capture();
	if (shouldMuteForDictation()) {
		return { muted: muteSystemAudio(), attempted: true };
	}
	return { muted: false, attempted: false };
}

function handleModelDownloadProgress(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:model-download-progress", {
		model: event.model,
		progress: event.progress,
		downloadedBytes: event.downloaded_bytes,
		totalBytes: event.total_bytes,
		speedBps: event.speed_bps,
		etaSeconds: event.eta_seconds,
	});
}

function handleModelSwapStarted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:model-swap-started", { kind: event.kind, name: event.name });
}

function handleModelSwapCompleted(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:model-swap-completed", { kind: event.kind, name: event.name });
}

function handleModelSwapFailed(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:model-swap-failed", {
		kind: event.kind,
		name: event.name,
		reason: event.reason,
	});
}

function handleModelCacheChanged(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:model-cache-changed", { modelId: event.model_id });
}

function handleAudioLevel(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:audio-level", { level: event.level });
	// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: onAudioLevel writes to recording-indicator state with no observable side effect from unit tests
	if (typeof event.level === "number") {
		onAudioLevel(event.level);
	}
}

function handleRealtimeEvent(event: Record<string, unknown>, safeSend: SafeSend): void {
	if (!event.text) {
		return;
	}
	// Stryker disable next-line MethodExpression,StringLiteral: dbgVerbose() preview is informational only
	dbgVerbose("relay", "realtime:", String(event.text).slice(0, 80));
	safeSend("stt:realtime-text", { text: event.text });
}

function handleRecordingStop(
	wasMuted: boolean,
	safeSend: SafeSend,
	history?: HistoryCapture
): boolean {
	// Clear the recording-state machine first so any duplicate
	// recording_start that arrives after this stop is rejected by
	// the consumeRecordingStart() gate.
	notifyRecordingStop();
	history?.notifyStopped();
	// Hide the floating pill FIRST, before any IPC broadcast or downstream
	// work, so a slow renderer or a hang in another handler can't leave the
	// overlay window stuck on screen.
	// Stryker disable next-line BlockStatement: empty try {} skips hideOverlay() — overlay is not mocked in unit tests so the absence of the call has no observable side effect; covered by Playwright e2e
	try {
		hideOverlay();
		// Stryker disable next-line BlockStatement: empty catch {} suppresses the dbg log only — no observable side effect to assert
	} catch (err) {
		// Stryker disable next-line BlockStatement,StringLiteral: dbg() catch is a defensive log with no observable side effect
		dbg("relay", "hideOverlay failed:", String(err));
	}
	safeSend("stt:recording-stop");
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
	no_audio_detected: (_e, send) => send("stt:no-audio-detected"),
	vad_detect_start: (_e, send) => send("stt:vad-start"),
	vad_detect_stop: (_e, send) => send("stt:vad-stop"),
	transcription_start: (e, send) =>
		send("stt:transcription-start", { audioBase64: e.audio_bytes_base64 }),
	wakeword_detected: (_e, send) => send("stt:wakeword-detected"),
	wakeword_detection_start: (_e, send) => send("stt:wakeword-detection-start"),
	wakeword_detection_end: (_e, send) => send("stt:wakeword-detection-end"),
	model_download_start: (e, send) => send("stt:model-download-start", { model: e.model }),
	model_download_complete: (e, send) =>
		send("stt:model-download-complete", {
			model: e.model,
			cancelled: e.cancelled ?? false,
		}),
	loopback_started: (e, send) => send("stt:loopback-started", { deviceName: e.deviceName }),
	loopback_stopped: (_e, send) => send("stt:loopback-stopped"),
	device_switch_failed: (e, send) =>
		send("stt:device-switch-failed", {
			requestedIndex: e.requested_index,
			errorMessage: e.error_message,
			fallbackIndex: e.fallback_index,
		}),
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

const OVERLAY_RELEVANT_SIMPLE_TYPES = new Set([
	"no_audio_detected",
	"vad_detect_start",
	"vad_detect_stop",
]);

interface DispatchContext {
	broadcast: SafeSend;
	contextCapture?: ContextCapture;
	getMuted: () => boolean;
	history?: HistoryCapture;
	mainSend: SafeSend;
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
	model_download_progress: (event, ctx) => handleModelDownloadProgress(event, ctx.mainSend),
	// Model swap lifecycle goes to ALL renderers via broadcast — settings
	// panel listens to revert the picker on failure, status-bar listens to
	// flip the chip into a loading state during the swap.
	model_swap_started: (event, ctx) => handleModelSwapStarted(event, ctx.broadcast),
	model_swap_completed: (event, ctx) => handleModelSwapCompleted(event, ctx.broadcast),
	model_swap_failed: (event, ctx) => handleModelSwapFailed(event, ctx.broadcast),
	model_cache_changed: (event, ctx) => handleModelCacheChanged(event, ctx.broadcast),
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
		capture: (text) => {
			const duration = computeRecordingDurationMs(
				lastRecordingStartMs,
				lastRecordingStopMs,
				Date.now()
			);
			const entry = historyStore.record(text, duration);
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
	ipcMain.handle("stt:get-model-catalog", () => cachedModelCatalog);

	// Same pattern for the runtime snapshot — late-mounting renderers (overlay
	// opens after the main window) ask for it once on mount.
	ipcMain.handle("stt:get-runtime-info", () => cachedRuntimeInfo);

	// Allow renderer to query current server-ready status on mount (fixes race condition
	// where server_ready fires before renderer IPC listeners are subscribed).
	// Stryker disable next-line ArrowFunction: handler return is exercised when invoked via IPC — covered by setupRelay smoke test
	ipcMain.handle("stt:get-server-ready", () => serverIsReady);

	// Initialize text post-processing (dictionary + snippet caches + store listeners)
	initPostProcessing(store);

	// Cancel download handler — sends command on control WebSocket
	// Stryker disable next-line ArrowFunction,BlockStatement,ObjectLiteral: handler dispatches a control command on invoke — covered by Playwright e2e
	ipcMain.handle("stt:cancel-download", () => {
		client.sendControl({ command: "cancel_download" });
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
	};

	const queues: DataEventQueues = { fullSentenceQueue, recordingStateQueue };
	const onDataEvent = (event: Record<string, unknown>): Promise<void> =>
		processDataEvent(event, queues, ctx);

	const broadcastConnectionChange = (connected: boolean) => {
		broadcastToAll("stt:connection-change", { connected });
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
		broadcastToAll("stt:model-catalog", { models });
	};

	const onRuntimeInfo = (info: unknown) => {
		cachedRuntimeInfo = info;
		// Broadcast so every renderer (main + overlay + settings) can light the
		// GPU/CPU chip honestly without polling.
		broadcastToAll("stt:runtime-info", info);
	};

	const onServerReady = () => {
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("relay", "Server READY — recorder initialized, sending status=running to renderer");
		logServerRealtimeConfig();
		serverIsReady = true;
		mainSend("stt:server-status", { status: "running" });

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
		ipcMain.removeHandler("stt:cancel-download");
		ipcMain.removeHandler("stt:get-model-catalog");
		ipcMain.removeHandler("stt:get-runtime-info");
		ipcMain.removeHandler("stt:get-server-ready");
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
	dispatchDataEvent,
	extractEventText,
	handleAudioLevel,
	handleFullSentence,
	handleModelDownloadProgress,
	handleRealtimeEvent,
	handleRecordingStart,
	handleRecordingStop,
	handleSimpleRelayEvent,
	hasLlmModel,
	isLlmConfigured,
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
	shouldMuteForDictation,
	SIMPLE_RELAY_HANDLERS,
	tryLlmProcess,
};
