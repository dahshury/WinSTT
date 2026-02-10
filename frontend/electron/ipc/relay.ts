import { BrowserWindow, ipcMain } from "electron";
import { dbg } from "../lib/debug-log";
import { pasteText } from "../lib/paste";
import { store } from "../lib/store";
import { applyPostProcessing, initPostProcessing } from "../lib/text-processing";
import type { SttClient } from "../ws/stt-client";
import { muteSystemAudio, unmuteSystemAudio } from "./audio-mute";

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

	const safeSend = (channel: string, ...args: unknown[]) => {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, ...args);
		}
	};

	const onDataEvent = (event: Record<string, unknown>) => {
		const type = event.type;
		if (typeof type !== "string") {
			dbg("relay", "Data event WITHOUT type:", JSON.stringify(event));
			return;
		}
		if (type !== "audio_level") {
			dbg("relay", `data-event: ${type}`);
		}

		switch (type) {
			case "realtime":
				dbg("relay", "realtime:", String(event.text).slice(0, 80));
				safeSend("stt:realtime-text", { text: event.text });
				break;
			case "fullSentence": {
				const processed = applyPostProcessing(String(event.text));
				const mode = store.get("general.recordingMode") as string;
				dbg("relay", `fullSentence: text=${JSON.stringify(processed)} mode=${mode}`);
				safeSend("stt:full-sentence", { text: processed });
				// Skip auto-paste in listen mode (passive monitoring, not dictation)
				if (mode !== "listen") {
					pasteText(`${processed} `);
				}
				break;
			}
			case "recording_start":
				safeSend("stt:recording-start");
				// Skip mute in listen mode — would silence the audio being transcribed
				if (
					store.get("general.muteSystemAudioWhileDictating") &&
					store.get("general.recordingMode") !== "listen"
				) {
					didMuteAudio = muteSystemAudio();
				}
				break;
			case "recording_stop":
				safeSend("stt:recording-stop");
				if (didMuteAudio) {
					unmuteSystemAudio();
					didMuteAudio = false;
				}
				break;
			case "vad_detect_start":
				safeSend("stt:vad-start");
				break;
			case "vad_detect_stop":
				safeSend("stt:vad-stop");
				break;
			case "transcription_start":
				safeSend("stt:transcription-start", {
					audioBase64: event.audio_bytes_base64,
				});
				break;
			case "wakeword_detected":
				safeSend("stt:wakeword-detected");
				break;
			case "wakeword_detection_start":
				safeSend("stt:wakeword-detection-start");
				break;
			case "wakeword_detection_end":
				safeSend("stt:wakeword-detection-end");
				break;
			case "model_download_start":
				safeSend("stt:model-download-start", { model: event.model });
				break;
			case "model_download_progress":
				safeSend("stt:model-download-progress", {
					model: event.model,
					progress: event.progress,
					downloadedBytes: event.downloaded_bytes,
					totalBytes: event.total_bytes,
					speedBps: event.speed_bps,
					etaSeconds: event.eta_seconds,
				});
				break;
			case "model_download_complete":
				safeSend("stt:model-download-complete", {
					model: event.model,
					cancelled: event.cancelled ?? false,
				});
				break;
			case "audio_level":
				safeSend("stt:audio-level", { level: event.level });
				break;
			case "loopback_started":
				safeSend("stt:loopback-started", { deviceName: event.deviceName });
				break;
			case "loopback_stopped":
				safeSend("stt:loopback-stopped");
				break;
			default:
				break;
		}
	};

	const onConnected = () => {
		dbg("relay", "STT server CONNECTED");
		safeSend("stt:connection-change", { connected: true });
	};

	const onDisconnected = () => {
		dbg("relay", "STT server DISCONNECTED");
		serverIsReady = false;
		safeSend("stt:connection-change", { connected: false });
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
		dbg(
			"relay",
			"Store realtime config: enableRealtimeTranscription=",
			store.get("quality.enableRealtimeTranscription"),
			"useMainModelForRealtime=",
			store.get("quality.useMainModelForRealtime"),
			"realtimeModel=",
			store.get("model.realtimeModel")
		);
		serverIsReady = true;
		safeSend("stt:server-status", { status: "running" });

		// Diagnostic: query the server's actual realtime transcription config
		client
			.getParameter("enable_realtime_transcription")
			.then((val) => {
				dbg("relay", "SERVER reports enable_realtime_transcription=", val);
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
	};
}
