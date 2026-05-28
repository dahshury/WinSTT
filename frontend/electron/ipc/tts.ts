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
import { z } from "zod";
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

// `listTtsVoices()` crosses the WS-RPC trust boundary from the Python server,
// so its result is validated with Zod (parse at the boundary; the schema is the
// single source of truth and `ListVoicesResult` is inferred from it).
const ListVoicesResultSchema = z.object({
	languages: z.array(z.object({ code: z.string(), label: z.string() })),
	voices: z.array(
		z.object({ id: z.string(), label: z.string(), language: z.string(), gender: z.string() })
	),
});
type ListVoicesResult = z.infer<typeof ListVoicesResultSchema>;

interface TtsDownloadEstimate {
	/** True when nothing needs downloading (everything already on disk). */
	alreadyInstalled: boolean;
	/** Per-component breakdown (engine pack / voice model / voicepacks). */
	components: Array<{ id: string; label: string; bytes: number; installed: boolean }>;
	/** Sum of every component that still needs downloading, in bytes. */
	totalBytes: number;
	/** True when the estimate couldn't be fetched (server/internet down). */
	unavailable?: boolean;
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
			dbg("tts", `broadcast failed for ${channel}: ${getErrorMessage(err)}`);
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
		tts_install_status: (event) =>
			broadcastAll(IPC.TTS_INSTALL_STATUS, {
				phase: typeof event.phase === "string" ? event.phase : "unknown",
			}),
		tts_install_failed: (event) =>
			broadcastAll(IPC.TTS_INSTALL_FAILED, {
				reason:
					typeof event.reason === "string" && event.reason ? event.reason : "TTS install failed",
				category: typeof event.category === "string" ? event.category : null,
			}),
		tts_install_paused: () => broadcastAll(IPC.TTS_INSTALL_PAUSED, {}),
		tts_install_resumed: () => broadcastAll(IPC.TTS_INSTALL_RESUMED, {}),
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
	// One-shot guard for the "the previous session was mid-install" check.
	// We only want to flip the toggle off on the FIRST connect after app
	// boot — subsequent reconnects (server crash recovery, dev hot-reload)
	// should warm up as normal even if the install is incomplete, since
	// the user already opted in earlier in the session.
	let bootInstallCheckDone = false;

	const maybeWarmup = async (): Promise<void> => {
		if (!(isTtsEnabled() && sttClient.isConnected)) {
			return;
		}
		// First-connect-of-session check: if TTS was left enabled across an
		// app restart but the install never finished (partial files on
		// disk, or never started), DON'T silently auto-resume. Flip the
		// store flag off so the user sees the toggle in OFF state on
		// startup; re-enabling triggers the existing install gate which
		// shows the dialog and resumes from the partials via HTTP Range.
		// Subsequent reconnects skip this guard so a server restart in
		// the middle of a session doesn't keep flipping the toggle off.
		if (!bootInstallCheckDone) {
			bootInstallCheckDone = true;
			try {
				const raw = (await sttClient.ttsDownloadEstimate()) as unknown;
				const alreadyInstalled =
					isPlainObject(raw) && (raw as { already_installed?: unknown }).already_installed === true;
				if (!alreadyInstalled) {
					dbg(
						"tts",
						"boot: install incomplete; flipping enabled OFF (user must re-enable to resume)"
					);
					store.set("tts.enabled", false);
					// Keep lastTtsEnabled aligned so the store.onDidChange
					// listener below doesn't fire a spurious warm-up when the
					// store mutation lands.
					lastTtsEnabled = false;
					return;
				}
			} catch (err) {
				// Probe failed (server / network blip). Fall through to the
				// warm-up — if there's a real problem, it'll surface as
				// tts_install_failed and the user sees the retry banner.
				dbg("tts", `boot install-check probe failed: ${getErrorMessage(err)}`);
			}
		}
		try {
			sttClient.initTts();
			dbg("tts", "warm-up: init_tts dispatched");
		} catch (err) {
			dbg("tts", `warm-up init_tts failed: ${getErrorMessage(err)}`);
		}
	};

	// Fire now (covers the already-connected case) and on every
	// (re)connect so a server restart re-warms the engine. ``maybeWarmup``
	// is async now (it may probe the install estimate before deciding
	// whether to fire ``init_tts``), but the caller doesn't care about
	// the result — wrap in a void-returning closure so the event-emitter
	// signature stays clean and the promise isn't accidentally awaited.
	const fireWarmup = (): void => {
		// Discard the promise via .catch so Biome's `useUndefined` (which
		// rejects bare `void expr`) stays happy; any genuine rejection is
		// already logged inside `maybeWarmup`'s try/catch blocks, so the
		// no-op handler here is purely belt-and-suspenders.
		maybeWarmup().catch(() => undefined);
	};
	fireWarmup();
	sttClient.on("connected", fireWarmup);

	// Re-warm when the user flips TTS on (off→on edge only — voice/speed
	// edits don't need a re-init, and `init_tts` while disabled is wasted).
	const ttsStoreUnsub = store.onDidChange("tts", () => {
		const nowEnabled = isTtsEnabled();
		if (nowEnabled && !lastTtsEnabled) {
			fireWarmup();
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

	// Install lifecycle controls — pure passthroughs to the server which
	// owns the partial-file state. Pause exits the streaming loop cleanly
	// at the next chunk boundary; resume re-fires warm-up; cancel discards
	// every partial download.
	const handleInstallPause = (): void => {
		try {
			sttClient.ttsInstallPause();
		} catch (err) {
			dbg("tts", `ttsInstallPause failed: ${getErrorMessage(err)}`);
		}
	};
	const handleInstallResume = (): void => {
		try {
			sttClient.ttsInstallResume();
		} catch (err) {
			dbg("tts", `ttsInstallResume failed: ${getErrorMessage(err)}`);
		}
	};
	const handleInstallCancel = (): void => {
		try {
			sttClient.ttsInstallCancel();
		} catch (err) {
			dbg("tts", `ttsInstallCancel failed: ${getErrorMessage(err)}`);
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
			const parsed = ListVoicesResultSchema.safeParse(await sttClient.listTtsVoices());
			if (parsed.success) {
				voiceCatalog = parsed.data;
				return voiceCatalog;
			}
		} catch (err) {
			dbg("tts", `listTtsVoices failed: ${getErrorMessage(err)}`);
		}
		return { voices: [], languages: [] };
	};

	const handleDownloadEstimate = async (): Promise<TtsDownloadEstimate> => {
		try {
			const raw = (await sttClient.ttsDownloadEstimate()) as unknown;
			if (
				isPlainObject(raw) &&
				typeof (raw as { total_bytes?: unknown }).total_bytes === "number"
			) {
				const r = raw as {
					total_bytes: number;
					components?: unknown;
					already_installed?: unknown;
				};
				const components = Array.isArray(r.components)
					? r.components.flatMap((c) =>
							isPlainObject(c) &&
							typeof (c as { id?: unknown }).id === "string" &&
							typeof (c as { label?: unknown }).label === "string" &&
							typeof (c as { bytes?: unknown }).bytes === "number"
								? [
										{
											id: c.id as string,
											label: c.label as string,
											bytes: c.bytes as number,
											// Older servers omit `installed`; absence ⇒ not installed
											// (the pre-status behaviour listed only missing pieces).
											installed: (c as { installed?: unknown }).installed === true,
										},
									]
								: []
						)
					: [];
				return {
					totalBytes: r.total_bytes,
					components,
					alreadyInstalled: r.already_installed === true,
				};
			}
		} catch (err) {
			dbg("tts", `ttsDownloadEstimate failed: ${getErrorMessage(err)}`);
		}
		// Network/server unavailable — caller (the confirm dialog) treats a
		// null estimate as "can't reach the internet to size this".
		return { totalBytes: 0, components: [], alreadyInstalled: false, unavailable: true };
	};

	ipcMain.handle(IPC.TTS_SPEAK, handleSpeak);
	ipcMain.handle(IPC.TTS_SPEAK_SELECTION, handleSpeakSelection);
	ipcMain.on(IPC.TTS_CANCEL, handleCancel);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_STARTED, handleReportPlaybackStarted);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_ENDED, handleReportPlaybackEnded);
	ipcMain.handle(IPC.TTS_INIT, handleInit);
	ipcMain.handle(IPC.TTS_LIST_VOICES, handleListVoices);
	ipcMain.handle(IPC.TTS_DOWNLOAD_ESTIMATE, handleDownloadEstimate);
	ipcMain.on(IPC.TTS_INSTALL_PAUSE, handleInstallPause);
	ipcMain.on(IPC.TTS_INSTALL_RESUME, handleInstallResume);
	ipcMain.on(IPC.TTS_INSTALL_CANCEL, handleInstallCancel);

	return () => {
		ipcMain.removeHandler(IPC.TTS_SPEAK);
		ipcMain.removeHandler(IPC.TTS_SPEAK_SELECTION);
		ipcMain.removeAllListeners(IPC.TTS_CANCEL);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_STARTED);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_ENDED);
		ipcMain.removeHandler(IPC.TTS_INIT);
		ipcMain.removeHandler(IPC.TTS_LIST_VOICES);
		ipcMain.removeHandler(IPC.TTS_DOWNLOAD_ESTIMATE);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_PAUSE);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_RESUME);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_CANCEL);
		sttClient.off("data-binary", onDataBinary);
		sttClient.off("data-event", onDataEvent);
		sttClient.off("connected", fireWarmup);
		ttsStoreUnsub();
		activeIds.clear();
		activeCancelAll = null;
	};
}

export function setupTts(sttClient: SttClient): () => void {
	return setupTtsImpl(sttClient);
}
