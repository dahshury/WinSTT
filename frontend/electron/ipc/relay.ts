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

async function handleFullSentence(
	event: Record<string, unknown>,
	safeSend: SafeSend
): Promise<void> {
	const rawText = String(event.text ?? "");
	const mode = getStoreValue("general.recordingMode");

	// Empty/whitespace-only result means VAD found no transcribable audio.
	// Surface this as a "no audio detected" hint instead of an empty subtitle.
	if (rawText.trim().length === 0) {
		if (mode !== "listen") {
			dbg("relay", "fullSentence: empty result, treating as no_audio_detected");
			safeSend("stt:no-audio-detected");
		}
		return;
	}

	let processed = applyPostProcessing(rawText);

	const llmEnabled = getStoreValue("llm.enabled");
	const llmModel = getStoreValue("llm.model");
	const llmPreset = getStoreValue("llm.preset");
	const llmEndpoint = getStoreValue("llm.endpoint");
	const llmTimeout = getStoreValue("llm.timeout");

	if (llmEnabled && llmModel) {
		try {
			processed = await processText(processed, llmModel, llmPreset, llmEndpoint, llmTimeout);
			dbg("relay", `LLM processed: ${processed.slice(0, 80)}`);
		} catch (err) {
			dbg("relay", "LLM processing failed, using original:", String(err));
		}
	}

	dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
	safeSend("stt:full-sentence", { text: processed });
	// Skip auto-paste in listen mode (passive monitoring, not dictation)
	if (mode !== "listen") {
		pasteText(`${processed} `);
	}
}

function handleRecordingStart(safeSend: SafeSend): { muted: boolean; attempted: boolean } {
	safeSend("stt:recording-start");
	onRecordingStart();
	showOverlay();
	// Skip mute in listen mode — would silence the audio being transcribed
	if (
		getStoreValue("general.muteSystemAudioWhileDictating") &&
		getStoreValue("general.recordingMode") !== "listen"
	) {
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

function handleSimpleRelayEvent(
	type: string,
	event: Record<string, unknown>,
	safeSend: SafeSend
): boolean {
	switch (type) {
		case "no_audio_detected":
			safeSend("stt:no-audio-detected");
			return true;
		case "vad_detect_start":
			safeSend("stt:vad-start");
			return true;
		case "vad_detect_stop":
			safeSend("stt:vad-stop");
			return true;
		case "transcription_start":
			safeSend("stt:transcription-start", { audioBase64: event.audio_bytes_base64 });
			return true;
		case "wakeword_detected":
			safeSend("stt:wakeword-detected");
			return true;
		case "wakeword_detection_start":
			safeSend("stt:wakeword-detection-start");
			return true;
		case "wakeword_detection_end":
			safeSend("stt:wakeword-detection-end");
			return true;
		case "model_download_start":
			safeSend("stt:model-download-start", { model: event.model });
			return true;
		case "model_download_complete":
			safeSend("stt:model-download-complete", {
				model: event.model,
				cancelled: event.cancelled ?? false,
			});
			return true;
		case "loopback_started":
			safeSend("stt:loopback-started", { deviceName: event.deviceName });
			return true;
		case "loopback_stopped":
			safeSend("stt:loopback-stopped");
			return true;
		default:
			return false;
	}
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
		for (const bw of BrowserWindow.getAllWindows()) {
			if (!bw.isDestroyed()) {
				bw.webContents.send(channel, ...args);
			}
		}
	};

	const dispatchDataEvent = async (type: string, event: Record<string, unknown>): Promise<void> => {
		if (type === "realtime") {
			handleRealtimeEvent(event, broadcast);
			return;
		}
		if (type === "fullSentence") {
			await handleFullSentence(event, broadcast);
			return;
		}
		if (type === "recording_start") {
			const result = handleRecordingStart(broadcast);
			if (result.attempted) {
				didMuteAudio = result.muted;
			}
			return;
		}
		if (type === "recording_stop") {
			didMuteAudio = handleRecordingStop(didMuteAudio, broadcast);
			return;
		}
		if (type === "audio_level") {
			handleAudioLevel(event, broadcast);
			return;
		}
		if (type === "model_download_progress") {
			handleModelDownloadProgress(event, mainSend);
			return;
		}
		// no_audio_detected and vad_* are overlay-relevant; the rest stay main-only.
		if (
			type === "no_audio_detected" ||
			type === "vad_detect_start" ||
			type === "vad_detect_stop"
		) {
			handleSimpleRelayEvent(type, event, broadcast);
			return;
		}
		handleSimpleRelayEvent(type, event, mainSend);
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
		await dispatchDataEvent(type, event);
	};

	const broadcastConnectionChange = (connected: boolean) => {
		for (const bw of BrowserWindow.getAllWindows()) {
			if (!bw.isDestroyed()) {
				bw.webContents.send("stt:connection-change", { connected });
			}
		}
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
		for (const bw of BrowserWindow.getAllWindows()) {
			if (!bw.isDestroyed()) {
				bw.webContents.send("stt:model-catalog", { models });
			}
		}
	};

	const onServerReady = () => {
		dbg("relay", "Server READY — recorder initialized, sending status=running to renderer");
		dbgVerbose(
			"relay",
			"Store realtime config: enableRealtimeTranscription=",
			store.get("quality.enableRealtimeTranscription"),
			"useMainModelForRealtime=",
			store.get("quality.useMainModelForRealtime"),
			"realtimeModel=",
			store.get("model.realtimeModel")
		);
		serverIsReady = true;
		mainSend("stt:server-status", { status: "running" });

		// Diagnostic: query the server's actual realtime transcription config
		client
			.getParameter("enable_realtime_transcription")
			.then((val) => {
				dbgVerbose("relay", "SERVER reports enable_realtime_transcription=", val);
				if (!val) {
					dbg(
						"relay",
						"WARNING: Server has realtime transcription DISABLED. " +
							"Pass --enable_realtime_transcription when starting the server, " +
							"or restart via the Electron app."
					);
				}
			})
			.catch((err) => {
				dbg("relay", "Could not query server realtime config:", String(err));
			});
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
