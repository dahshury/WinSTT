import { BrowserWindow, ipcMain } from "electron";
import { dbg } from "../lib/debug-log";
import { pasteText } from "../lib/paste";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { muteSystemAudio, unmuteSystemAudio } from "./audio-mute";

/** Last known model catalog — cached so any window can fetch it on demand. */
let cachedModelCatalog: unknown[] = [];

/** Tracks whether server_ready has been received (survives renderer late-mount). */
let serverIsReady = false;

// Allow any window (including settings) to request the cached catalog.
ipcMain.handle("stt:get-model-catalog", () => cachedModelCatalog);

// Allow renderer to query current server-ready status on mount (fixes race condition
// where server_ready fires before renderer IPC listeners are subscribed).
ipcMain.handle("stt:get-server-ready", () => serverIsReady);

const SENTENCE_END_RE = /[.!?]$/;
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

// ── Cached post-processing patterns ──────────────────────────────────
// Re-compiled only when the underlying store data changes (via onDidChange).

interface CompiledDictEntry {
	regex: RegExp;
	replace: string;
}

let cachedDictPatterns: CompiledDictEntry[] = [];
let cachedSnippets: Array<{ trigger: string; expansion: string }> = [];

function rebuildDictPatterns() {
	const dictionary = store.get("dictionary") as
		| Array<{ find: string; replace: string; caseSensitive?: boolean; wholeWord?: boolean }>
		| undefined;
	if (!dictionary?.length) {
		cachedDictPatterns = [];
		return;
	}
	cachedDictPatterns = dictionary
		.filter((e) => e.find)
		.map((entry) => {
			const escaped = entry.find.replace(REGEX_ESCAPE_RE, "\\$&");
			const pattern = entry.wholeWord ? `\\b${escaped}\\b` : escaped;
			const flags = entry.caseSensitive ? "g" : "gi";
			return { regex: new RegExp(pattern, flags), replace: entry.replace };
		});
}

function rebuildSnippets() {
	const snippets = store.get("snippets") as
		| Array<{ trigger: string; expansion: string }>
		| undefined;
	cachedSnippets = snippets?.filter((e) => e.trigger) ?? [];
}

// Build on startup
rebuildDictPatterns();
rebuildSnippets();

// Rebuild when store changes
store.onDidChange("dictionary" as never, rebuildDictPatterns);
store.onDidChange("snippets" as never, rebuildSnippets);

/** Apply dictionary replacements and snippet expansions to text. */
function applyPostProcessing(text: string): string {
	let result = text;

	// Ensure sentence ends with period (if enabled and not already punctuated)
	const addPeriod = store.get("quality.ensureSentenceEndsWithPeriod") as boolean | undefined;
	if (addPeriod && result.length > 0 && !SENTENCE_END_RE.test(result.trimEnd())) {
		result = `${result.trimEnd()}.`;
	}

	// Dictionary replacements (pre-compiled regexes)
	for (const entry of cachedDictPatterns) {
		entry.regex.lastIndex = 0;
		result = result.replace(entry.regex, entry.replace);
	}

	// Snippet expansions
	for (const entry of cachedSnippets) {
		result = result.replaceAll(entry.trigger, entry.expansion);
	}

	return result;
}

/** Deduplication guard — prevents pasting the same text twice within a short window. */
const PASTE_DEDUP_MS = 5000;
let lastPastedText = "";
let lastPasteTime = 0;

export function setupRelay(win: BrowserWindow, client: SttClient): () => void {
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

		switch (type) {
			case "realtime":
				safeSend("stt:realtime-text", { text: event.text });
				break;
			case "fullSentence": {
				const processed = applyPostProcessing(String(event.text));
				safeSend("stt:full-sentence", { text: processed });
				// Skip auto-paste in listen mode (passive monitoring, not dictation)
				if (store.get("general.recordingMode") !== "listen") {
					const now = Date.now();
					if (processed === lastPastedText && now - lastPasteTime < PASTE_DEDUP_MS) {
						dbg("relay", "PASTE SKIPPED (dedup):", JSON.stringify(processed));
					} else {
						dbg("relay", "PASTE:", JSON.stringify(processed));
						lastPastedText = processed;
						lastPasteTime = now;
						pasteText(`${processed} `);
					}
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
		serverIsReady = true;
		safeSend("stt:server-status", { status: "running" });
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
	};
}
