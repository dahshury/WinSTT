/**
 * TTS orchestrator — Electron main process.
 *
 * Mirrors the shape of `transforms.ts` for the inverse direction:
 *   - Renderer (or hotkey) triggers a synthesis request via IPC.
 *   - Main captures the active text selection if needed, generates a
 *     fresh ``request_id``, and dispatches ``tts_synthesize`` over the
 *     existing WebSocket control channel to the Python server.
 *   - Server streams audio chunks back as binary frames on the data
 *     channel; this module subscribes to those frames via
 *     ``SttClient.on("data-binary")`` and forwards each to every
 *     renderer window via ``IPC.TTS_CHUNK``.
 *   - ``tts_complete`` / ``tts_failed`` / ``tts_model_download_*`` JSON
 *     events come through ``data-event`` and are similarly relayed.
 *
 * No PyTorch, no audio decoding on this side — just plumbing. The
 * renderer's playback queue does the Web Audio scheduling.
 */

import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { isPlainObject } from "../lib/ipc-helpers";
import { captureSelection } from "../lib/selection-capture";
import { getStoreValue, store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

interface SpeakSelectionPayload {
	requestId?: string;
}

interface SpeakPayload {
	lang?: string;
	requestId?: string;
	speed?: number;
	text: string;
	voice?: string;
}

interface BinaryChunkPayload {
	header: Record<string, unknown>;
	pcm: Buffer;
}

interface ListVoicesResult {
	languages: Array<{ code: string; label: string }>;
	voices: Array<{ id: string; label: string; language: string; gender: string }>;
}

/**
 * Set by {@link setupTts} so the global TTS hotkey listener (a separate
 * module) can trigger a full cancel without re-implementing the
 * cooperative-cancel + optimistic-broadcast logic. Null until setup runs.
 */
let activeCancelAll: (() => void) | null = null;

/** Stop every in-flight / buffered TTS playback. Safe no-op before setup. */
export function triggerTtsCancelAll(): void {
	activeCancelAll?.();
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function asRecord(payload: unknown, label: string): Record<string, unknown> {
	if (!isPlainObject(payload)) {
		throw new ValidationError(`${label} payload must be an object`, "payload");
	}
	return payload;
}

function assertSpeakPayload(payload: unknown): asserts payload is SpeakPayload {
	const obj = asRecord(payload, "TTS speak");
	if (!isNonEmptyString(obj.text)) {
		throw new ValidationError("TTS speak payload.text is required", "text");
	}
}

function broadcastAll(channel: string, payload: unknown): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		if (bw.isDestroyed()) {
			continue;
		}
		try {
			bw.webContents.send(channel, payload);
		} catch (err) {
			dbg("tts", `broadcast failed for ${channel}: ${(err as Error).message}`);
		}
	}
}

/** Read effective synthesis params from the store, falling back to defaults. */
function effectiveParams(overrides: Partial<SpeakPayload> = {}): {
	voice: string;
	lang: string;
	speed: number;
} {
	const voice = overrides.voice || getStoreValue("tts.voice") || "af_heart";
	const lang = overrides.lang || getStoreValue("tts.lang") || "en-us";
	const speedRaw = overrides.speed ?? getStoreValue("tts.speed");
	const speed = Math.max(0.5, Math.min(2.0, typeof speedRaw === "number" ? speedRaw : 1.0));
	return { voice, lang, speed };
}

/**
 * State held inside the closure returned by ``setupTts`` so multiple
 * concurrent requests don't clobber each other's listeners. ``activeIds``
 * tracks every request that hasn't yet seen a ``tts_complete``/``tts_failed``.
 */
function setupTtsImpl(sttClient: SttClient) {
	const activeIds = new Set<string>();
	let voiceCatalog: ListVoicesResult | null = null;

	const isTtsEnabled = (): boolean => getStoreValue("tts.enabled") === true;

	const beginRequest = (requestId: string): void => {
		activeIds.add(requestId);
		broadcastAll(IPC.TTS_STARTED, { requestId });
	};

	const endRequest = (requestId: string, channel: string, payload: unknown): void => {
		activeIds.delete(requestId);
		broadcastAll(channel, payload);
	};

	const onDataBinary = ({ header, pcm }: BinaryChunkPayload): void => {
		const headerType = header.type;
		if (headerType !== "tts_chunk") {
			return;
		}
		const requestId = typeof header.request_id === "string" ? header.request_id : "";
		// Convert Buffer to ArrayBuffer slice so the renderer receives a
		// transferable structured-clone payload; preload exposes the
		// channel via ``on`` so the data is structured-cloned anyway.
		const pcmCopy = new Uint8Array(pcm.byteLength);
		pcmCopy.set(pcm);
		broadcastAll(IPC.TTS_CHUNK, {
			requestId,
			sampleRate: typeof header.sample_rate === "number" ? header.sample_rate : 24_000,
			seq: typeof header.seq === "number" ? header.seq : 0,
			isFinal: header.is_final === true,
			format: typeof header.format === "string" ? header.format : "f32le",
			channels: typeof header.channels === "number" ? header.channels : 1,
			pcm: pcmCopy.buffer,
		});
	};

	const handleTtsComplete = (event: Record<string, unknown>, requestId: string): void => {
		endRequest(requestId, IPC.TTS_COMPLETED, {
			requestId,
			cancelled: event.cancelled === true,
			elapsedMs: typeof event.elapsed_ms === "number" ? event.elapsed_ms : null,
		});
	};
	const handleTtsFailed = (event: Record<string, unknown>, requestId: string): void => {
		endRequest(requestId, IPC.TTS_FAILED, {
			requestId,
			reason: typeof event.reason === "string" ? event.reason : "Unknown TTS error",
		});
	};
	const handleDownloadProgress = (event: Record<string, unknown>): void => {
		broadcastAll(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
			progress: typeof event.progress === "number" ? event.progress : 0,
			downloadedBytes: typeof event.downloaded_bytes === "number" ? event.downloaded_bytes : 0,
			totalBytes: typeof event.total_bytes === "number" ? event.total_bytes : 0,
		});
	};

	const dataEventHandlers: Record<
		string,
		(event: Record<string, unknown>, requestId: string) => void
	> = {
		tts_complete: handleTtsComplete,
		tts_failed: handleTtsFailed,
		tts_model_download_start: () => broadcastAll(IPC.TTS_MODEL_DOWNLOAD_START, {}),
		tts_model_download_progress: (event) => handleDownloadProgress(event),
		tts_model_download_complete: (event) =>
			broadcastAll(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, { cancelled: event.cancelled === true }),
	};

	const onDataEvent = (event: Record<string, unknown>): void => {
		const type = typeof event.type === "string" ? event.type : "";
		const requestId = typeof event.request_id === "string" ? event.request_id : "";
		dataEventHandlers[type]?.(event, requestId);
	};

	sttClient.on("data-binary", onDataBinary);
	sttClient.on("data-event", onDataEvent);

	// ─── Eager warm-up ────────────────────────────────────────────────
	// Kokoro is lazy-loaded on the first `tts_synthesize`, so the first
	// preview/read otherwise pays a multi-second model-construct (and a
	// one-time download). STT models are warmed at launch; do the same
	// for TTS whenever it's enabled. `init_tts` is idempotent and
	// `pre_ready=True` server-side, so it's safe the moment the control
	// channel is up — no need to wait for the STT recorder.
	let lastTtsEnabled = isTtsEnabled();

	const maybeWarmup = (): void => {
		if (!(isTtsEnabled() && sttClient.isConnected)) {
			return;
		}
		try {
			sttClient.initTts();
			dbg("tts", "warm-up: init_tts dispatched");
		} catch (err) {
			dbg("tts", `warm-up init_tts failed: ${getErrorMessage(err)}`);
		}
	};

	// Fire now (covers the already-connected case) and on every
	// (re)connect so a server restart re-warms the engine.
	maybeWarmup();
	sttClient.on("connected", maybeWarmup);

	// Re-warm when the user flips TTS on (off→on edge only — voice/speed
	// edits don't need a re-init, and `init_tts` while disabled is wasted).
	const ttsStoreUnsub = store.onDidChange("tts", () => {
		const nowEnabled = isTtsEnabled();
		if (nowEnabled && !lastTtsEnabled) {
			maybeWarmup();
		}
		lastTtsEnabled = nowEnabled;
	});

	// ─── Renderer-facing IPC handlers ─────────────────────────────────

	const handleSpeak = (
		_event: Electron.IpcMainInvokeEvent,
		payload: unknown
	): Promise<{ requestId: string }> => {
		assertSpeakPayload(payload);
		if (!isTtsEnabled()) {
			throw new ValidationError("TTS is disabled in settings", "tts.enabled");
		}
		const requestId = payload.requestId || randomUUID();
		const params = effectiveParams(payload);
		beginRequest(requestId);
		sttClient.ttsSynthesize({
			requestId,
			text: payload.text,
			voice: params.voice,
			lang: params.lang,
			speed: params.speed,
		});
		return Promise.resolve({ requestId });
	};

	const handleSpeakSelection = async (
		_event: Electron.IpcMainInvokeEvent,
		payload: unknown
	): Promise<{ requestId: string; text: string; source: string }> => {
		if (!isTtsEnabled()) {
			throw new ValidationError("TTS is disabled in settings", "tts.enabled");
		}
		const obj: SpeakSelectionPayload = isPlainObject(payload)
			? (payload as SpeakSelectionPayload)
			: {};
		const selection = await captureSelection();
		if (!selection.text.trim()) {
			broadcastAll(IPC.TTS_FAILED, {
				requestId: obj.requestId || "",
				reason: "No text selected",
			});
			return { requestId: "", text: "", source: selection.source };
		}
		const requestId = obj.requestId || randomUUID();
		const params = effectiveParams();
		beginRequest(requestId);
		sttClient.ttsSynthesize({
			requestId,
			text: selection.text,
			voice: params.voice,
			lang: params.lang,
			speed: params.speed,
		});
		return { requestId, text: selection.text, source: selection.source };
	};

	/**
	 * Cancel one (or every) in-flight TTS request. Sends the cooperative
	 * cancel to the server AND optimistically broadcasts a cancelled
	 * `tts_complete` so the renderer's Web Audio queue stops *immediately*
	 * — important when the server already finished generating and the
	 * audio is only buffered client-side (server-side cancel is a no-op
	 * then, but the buffered audio must still stop).
	 */
	const cancel = (requestId?: string): void => {
		try {
			sttClient.ttsCancel(requestId);
		} catch (err) {
			dbg("tts", `ttsCancel failed: ${getErrorMessage(err)}`);
		}
		if (requestId) {
			broadcastAll(IPC.TTS_COMPLETED, { requestId, cancelled: true });
			activeIds.delete(requestId);
		} else {
			for (const id of activeIds) {
				broadcastAll(IPC.TTS_COMPLETED, { requestId: id, cancelled: true });
			}
			activeIds.clear();
			// Fallback for the case where no request id was ever tracked
			// (e.g. the stop gesture fires before TTS_STARTED): broadcast a
			// wildcard completed so the renderer queue's stop() runs anyway.
			broadcastAll(IPC.TTS_COMPLETED, { requestId: "", cancelled: true });
		}
	};

	// Expose the cancel-all for the global TTS hotkey's "stop" gesture
	// (combo + Backspace), which lives in a separate module.
	activeCancelAll = () => cancel();

	const handleCancel = (_event: Electron.IpcMainEvent, payload: unknown): void => {
		const obj = isPlainObject(payload) ? (payload as { requestId?: string }) : {};
		cancel(obj.requestId);
	};

	const handleInit = (): Promise<{ ready: boolean }> => {
		try {
			sttClient.initTts();
			return Promise.resolve({ ready: true });
		} catch (err) {
			dbg("tts", `initTts failed: ${getErrorMessage(err)}`);
			return Promise.resolve({ ready: false });
		}
	};

	// The window that owns the Web Audio queue (the main app window — the
	// settings window has none) tells us when audio actually finished.
	// Fan it out to every window so a play/stop button in any window can
	// track real playback rather than the far-earlier synthesis-complete.
	const handleReportPlaybackStarted = (_event: Electron.IpcMainEvent, payload: unknown): void => {
		const obj = isPlainObject(payload) ? (payload as { requestId?: string }) : {};
		broadcastAll(IPC.TTS_PLAYBACK_STARTED, { requestId: obj.requestId ?? "" });
	};

	const handleReportPlaybackEnded = (_event: Electron.IpcMainEvent, payload: unknown): void => {
		const obj = isPlainObject(payload) ? (payload as { requestId?: string }) : {};
		broadcastAll(IPC.TTS_PLAYBACK_ENDED, { requestId: obj.requestId ?? "" });
	};

	const handleListVoices = async (): Promise<ListVoicesResult> => {
		if (voiceCatalog) {
			return voiceCatalog;
		}
		try {
			const raw = (await sttClient.listTtsVoices()) as unknown;
			if (
				isPlainObject(raw) &&
				Array.isArray((raw as { voices?: unknown }).voices) &&
				Array.isArray((raw as { languages?: unknown }).languages)
			) {
				voiceCatalog = raw as unknown as ListVoicesResult;
				return voiceCatalog;
			}
		} catch (err) {
			dbg("tts", `listTtsVoices failed: ${getErrorMessage(err)}`);
		}
		return { voices: [], languages: [] };
	};

	ipcMain.handle(IPC.TTS_SPEAK, handleSpeak);
	ipcMain.handle(IPC.TTS_SPEAK_SELECTION, handleSpeakSelection);
	ipcMain.on(IPC.TTS_CANCEL, handleCancel);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_STARTED, handleReportPlaybackStarted);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_ENDED, handleReportPlaybackEnded);
	ipcMain.handle(IPC.TTS_INIT, handleInit);
	ipcMain.handle(IPC.TTS_LIST_VOICES, handleListVoices);

	return () => {
		ipcMain.removeHandler(IPC.TTS_SPEAK);
		ipcMain.removeHandler(IPC.TTS_SPEAK_SELECTION);
		ipcMain.removeAllListeners(IPC.TTS_CANCEL);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_STARTED);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_ENDED);
		ipcMain.removeHandler(IPC.TTS_INIT);
		ipcMain.removeHandler(IPC.TTS_LIST_VOICES);
		sttClient.off("data-binary", onDataBinary);
		sttClient.off("data-event", onDataEvent);
		sttClient.off("connected", maybeWarmup);
		ttsStoreUnsub();
		activeIds.clear();
		activeCancelAll = null;
	};
}

export function setupTts(sttClient: SttClient): () => void {
	return setupTtsImpl(sttClient);
}
