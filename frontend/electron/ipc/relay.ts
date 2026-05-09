import { BrowserWindow, ipcMain } from "electron";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { createSafeSender, type SafeSend } from "../lib/ipc-helpers";
import { pasteText } from "../lib/paste";
import { onAudioLevel, onRecordingStart, onRecordingStop } from "../lib/recording-indicator";
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

async function tryLlmProcess(text: string): Promise<string> {
	try {
		const out = await processText(text);
		dbg("relay", `LLM processed: ${out.slice(0, 80)}`);
		return out;
	} catch (err) {
		dbg("relay", "LLM processing failed, using original:", String(err));
		return text;
	}
}

function maybeRunLlm(text: string): Promise<string> {
	if (!isLlmConfigured()) {
		return Promise.resolve(text);
	}
	return tryLlmProcess(text);
}

function notifyEmptyResult(mode: unknown, safeSend: SafeSend): void {
	if (mode !== "listen") {
		dbg("relay", "fullSentence: empty result, treating as no_audio_detected");
		safeSend("stt:no-audio-detected");
	}
}

function pasteIfDictating(mode: unknown, text: string): void {
	if (mode !== "listen") {
		pasteText(`${text} `);
	}
}

async function handleFullSentence(
	event: Record<string, unknown>,
	safeSend: SafeSend
): Promise<void> {
	const rawText = extractEventText(event);
	const mode = getStoreValue("general.recordingMode");

	// Empty/whitespace-only result means VAD found no transcribable audio.
	// Surface this as a "no audio detected" hint instead of an empty subtitle.
	if (rawText.trim().length === 0) {
		notifyEmptyResult(mode, safeSend);
		return;
	}

	const processed = await maybeRunLlm(applyPostProcessing(rawText));

	dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
	safeSend("stt:full-sentence", { text: processed });
	// Skip auto-paste in listen mode (passive monitoring, not dictation)
	pasteIfDictating(mode, processed);
}

function shouldMuteForDictation(): boolean {
	const enabled = getStoreValue("general.muteSystemAudioWhileDictating");
	return enabled === true && getStoreValue("general.recordingMode") !== "listen";
}

function handleRecordingStart(safeSend: SafeSend): { muted: boolean; attempted: boolean } {
	safeSend("stt:recording-start");
	onRecordingStart();
	showOverlay();
	// Skip mute in listen mode — would silence the audio being transcribed
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

function handleAudioLevel(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("stt:audio-level", { level: event.level });
	if (typeof event.level === "number") {
		onAudioLevel(event.level);
	}
}

function handleRealtimeEvent(event: Record<string, unknown>, safeSend: SafeSend): void {
	if (!event.text) {
		return;
	}
	dbgVerbose("relay", "realtime:", String(event.text).slice(0, 80));
	safeSend("stt:realtime-text", { text: event.text });
}

function handleRecordingStop(wasMuted: boolean, safeSend: SafeSend): boolean {
	safeSend("stt:recording-stop");
	onRecordingStop();
	hideOverlay();
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
	getMuted: () => boolean;
	mainSend: SafeSend;
	setMuted: (value: boolean) => void;
}

type DataEventHandler = (
	event: Record<string, unknown>,
	ctx: DispatchContext
) => Promise<void> | void;

const DATA_EVENT_HANDLERS: Record<string, DataEventHandler> = {
	realtime: (event, ctx) => handleRealtimeEvent(event, ctx.broadcast),
	fullSentence: (event, ctx) => handleFullSentence(event, ctx.broadcast),
	recording_start: (_event, ctx) => {
		const result = handleRecordingStart(ctx.broadcast);
		if (result.attempted) {
			ctx.setMuted(result.muted);
		}
	},
	recording_stop: (_event, ctx) => {
		ctx.setMuted(handleRecordingStop(ctx.getMuted(), ctx.broadcast));
	},
	audio_level: (event, ctx) => handleAudioLevel(event, ctx.broadcast),
	model_download_progress: (event, ctx) => handleModelDownloadProgress(event, ctx.mainSend),
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

function broadcastToAll(channel: string, ...args: unknown[]): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		if (!bw.isDestroyed()) {
			bw.webContents.send(channel, ...args);
		}
	}
}

function logServerRealtimeWarning(val: unknown): void {
	dbgVerbose("relay", "SERVER reports enable_realtime_transcription=", val);
	if (!val) {
		dbg(
			"relay",
			"WARNING: Server has realtime transcription DISABLED. " +
				"Pass --enable_realtime_transcription when starting the server, " +
				"or restart via the Electron app."
		);
	}
}

function logServerRealtimeError(err: unknown): void {
	dbg("relay", "Could not query server realtime config:", String(err));
}

function logServerRealtimeConfig(): void {
	dbgVerbose(
		"relay",
		"Store realtime config: enableRealtimeTranscription=",
		store.get("quality.enableRealtimeTranscription"),
		"useMainModelForRealtime=",
		store.get("quality.useMainModelForRealtime"),
		"realtimeModel=",
		store.get("model.realtimeModel")
	);
}

export function setupRelay(win: BrowserWindow, client: SttClient): () => void {
	/** Last known model catalog — cached so any window can fetch it on demand. */
	let cachedModelCatalog: unknown[] = [];

	/** Tracks whether server_ready has been received (survives renderer late-mount). */
	let serverIsReady = false;

	// Allow any window (including settings) to request the cached catalog.
	ipcMain.handle("stt:get-model-catalog", () => cachedModelCatalog);

	// Allow renderer to query current server-ready status on mount (fixes race condition
	// where server_ready fires before renderer IPC listeners are subscribed).
	ipcMain.handle("stt:get-server-ready", () => serverIsReady);

	// Initialize text post-processing (dictionary + snippet caches + store listeners)
	initPostProcessing(store);

	// Cancel download handler — sends command on control WebSocket
	ipcMain.handle("stt:cancel-download", () => {
		client.sendControl({ command: "cancel_download" });
	});
	let didMuteAudio = false;

	const mainSend = createSafeSender(win);
	// Events the overlay window also needs (realtime text, audio level, recording
	// state, VAD, no-audio hint). Broadcast to every renderer so the overlay
	// receives them alongside the main window.
	const broadcast: SafeSend = (channel: string, ...args: unknown[]) => {
		broadcastToAll(channel, ...args);
	};

	const ctx: DispatchContext = {
		broadcast,
		mainSend,
		getMuted: () => didMuteAudio,
		setMuted: (value: boolean) => {
			didMuteAudio = value;
		},
	};

	const onDataEvent = async (event: Record<string, unknown>): Promise<void> => {
		const type = event.type;
		if (typeof type !== "string") {
			dbg("relay", "Data event WITHOUT type:", JSON.stringify(event));
			return;
		}
		if (type !== "audio_level") {
			dbgVerbose("relay", `data-event: ${type}`);
		}
		await dispatchDataEvent(type, event, ctx);
	};

	const broadcastConnectionChange = (connected: boolean) => {
		broadcastToAll("stt:connection-change", { connected });
	};

	const onConnected = () => {
		dbg("relay", "STT server CONNECTED");
		broadcastConnectionChange(true);
	};

	const onDisconnected = () => {
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

	const onServerReady = () => {
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
	client.on("server-ready", onServerReady);

	return () => {
		client.off("data-event", onDataEvent);
		client.off("connected", onConnected);
		client.off("disconnected", onDisconnected);
		client.off("model-catalog", onModelCatalog);
		client.off("server-ready", onServerReady);
		ipcMain.removeHandler("stt:cancel-download");
		ipcMain.removeHandler("stt:get-model-catalog");
		ipcMain.removeHandler("stt:get-server-ready");
		cleanupPostProcessing();
	};
}

export const __relay_test_helpers__ = {
	extractEventText,
	hasLlmModel,
	isLlmConfigured,
	tryLlmProcess,
	maybeRunLlm,
	notifyEmptyResult,
	pasteIfDictating,
	shouldMuteForDictation,
	pickSenderForSimpleEvent,
	broadcastToAll,
	logServerRealtimeWarning,
	logServerRealtimeError,
	logServerRealtimeConfig,
	dispatchDataEvent,
	handleSimpleRelayEvent,
	handleFullSentence,
	handleRecordingStart,
	handleRecordingStop,
	handleRealtimeEvent,
	handleAudioLevel,
	handleModelDownloadProgress,
	SIMPLE_RELAY_HANDLERS,
	DATA_EVENT_HANDLERS,
	OVERLAY_RELEVANT_SIMPLE_TYPES,
};
