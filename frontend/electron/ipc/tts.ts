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
import { BrowserWindow, ipcMain, Notification } from "electron";
import { z } from "zod";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage, ValidationError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { isPlainObject } from "../lib/ipc-helpers";
import { isDictationActive } from "../lib/recording-state";
import { captureSelection } from "../lib/selection-capture";
import { getStoreValue, store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { hideOverlay, showOverlay } from "./overlay";
import {
	abortAllCloudTts,
	abortCloudTts,
	handleCloudListVoices,
	handleCloudSubscription,
	previewCloudClip,
	synthesizeCloud,
} from "./tts-cloud";
import { runSentenceRead, type SentenceReadControl } from "./tts-reader";

/** Clamp a read-aloud speed to the active source's allowed range. */
function clampSpeed(value: unknown, cloud: boolean): number {
	const raw = typeof value === "number" ? value : 1;
	return cloud ? Math.max(0.7, Math.min(1.2, raw)) : Math.max(0.5, Math.min(2.0, raw));
}

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

/**
 * Set by {@link setupTts} so the global TTS hotkey (a separate module that
 * captures the selection itself) can dispatch through the SAME source-aware
 * path the renderer "Speak" button uses — local Kokoro when
 * `tts.source === "local"`, ElevenLabs cloud when `"cloud"`. Null until setup
 * runs. Without this the hotkey hit `sttClient.ttsSynthesize` directly and
 * always synthesized on Kokoro, ignoring the cloud toggle.
 */
let activeSpeakText: ((text: string) => void) | null = null;

/** Speak `text` via the active TTS source (local Kokoro or cloud ElevenLabs).
 *  Safe no-op before setup, when TTS is disabled, or for blank text. */
export function triggerTtsSpeakText(text: string): void {
	activeSpeakText?.(text);
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

/** Throttle so a held / mashed hotkey can't spam the OS notification tray. */
let lastCloudTtsNotifyAt = 0;

/**
 * Surface a cloud-TTS synthesis failure (out of credits, bad key, deleted voice,
 * …) as a NATIVE OS notification. The TTS hotkey fires while the user is in
 * ANOTHER app, so an in-app toast in the main window would never be seen — a
 * system notification is. Throttled to one per 5s. Best-effort: never throws.
 */
function notifyCloudTtsFailure(reason: string): void {
	try {
		if (!Notification.isSupported()) {
			return;
		}
		const now = Date.now();
		if (now - lastCloudTtsNotifyAt < 5000) {
			return;
		}
		lastCloudTtsNotifyAt = now;
		new Notification({ title: "WinSTT — couldn't read aloud", body: reason }).show();
	} catch (err) {
		dbg("tts", `cloud TTS failure notification failed: ${getErrorMessage(err)}`);
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

	// Read-aloud (hotkey / speak-selection) plays sentence-by-sentence under one
	// parent requestId. LOCAL sentences use server SUB-request ids (`parent::i`)
	// so their chunks can be re-tagged to the parent and their per-sentence
	// `tts_complete` suppressed (the reader emits the single final complete).
	const readerSubToParent = new Map<string, string>();
	// Active read (serial — a new read supersedes the prior). `null` when idle.
	let read: {
		cancelled: boolean;
		parentId: string;
		resolveSentence: (() => void) | null;
		speed: number;
		subId: string | null;
	} | null = null;

	const isTtsEnabled = (): boolean => getStoreValue("tts.enabled") === true;

	/** True when synthesis should be served by ElevenLabs cloud, not Kokoro. */
	const isCloudSource = (): boolean => getStoreValue("tts.source") === "cloud";

	const beginRequest = (requestId: string): void => {
		activeIds.add(requestId);
		broadcastAll(IPC.TTS_STARTED, { requestId });
	};

	const endRequest = (requestId: string, channel: string, payload: unknown): void => {
		activeIds.delete(requestId);
		broadcastAll(channel, payload);
	};

	// Does THIS module currently own the overlay for a read-aloud? Only set when
	// `showOverlayForTtsRead` actually shows it, so a settings preview (which
	// never shows it) can't make the playback-ended hook hide the STT pill.
	let ttsOverlayShown = false;

	/**
	 * Surface the dynamic-island pill for a REAL read-aloud (hotkey / speak-
	 * selection — NOT a settings voice preview). The overlay is shared with
	 * dictation; if a dictation session is live it owns the pill, so we never
	 * fight it for the window.
	 */
	const showOverlayForTtsRead = (): void => {
		if (isDictationActive()) {
			return;
		}
		ttsOverlayShown = true;
		showOverlay();
	};

	/**
	 * Hide the read-aloud pill once its audio has fully drained (the renderer
	 * reports `tts:playback-ended` after the last buffered source stops, which
	 * also fires on cancel / failure via the queue's `stop()`). No-op unless WE
	 * showed it, and never yanks the pill while dictation now owns it.
	 */
	const hideOverlayForTtsRead = (): void => {
		if (!ttsOverlayShown) {
			return;
		}
		ttsOverlayShown = false;
		if (isDictationActive()) {
			return;
		}
		// `forceGrace`: keep the window composited through the island's slide-up
		// exit animation even when the user's overlay mode is floating-bottom (the
		// read-aloud pill is always a dynamic-island).
		hideOverlay({ forceGrace: true });
	};

	/**
	 * Dispatch a cloud (ElevenLabs) synthesis. The request must already be
	 * begun (``beginRequest``) so TTS_STARTED has fired; ``synthesizeCloud``
	 * streams PCM frames out via TTS_CHUNK and resolves through onDone/onError
	 * into the same TTS_COMPLETED / TTS_FAILED broadcasts the local path uses.
	 */
	const dispatchCloud = (requestId: string, text: string, voiceOverride?: string): void => {
		const voiceId = voiceOverride || getStoreValue("tts.cloud.voice") || "";
		synthesizeCloud(
			{ requestId, text, voiceId },
			{
				onChunk: (p) => broadcastAll(IPC.TTS_CHUNK, p),
				onDone: () =>
					endRequest(requestId, IPC.TTS_COMPLETED, {
						requestId,
						cancelled: false,
						elapsedMs: null,
					}),
				onError: (reason) => {
					endRequest(requestId, IPC.TTS_FAILED, { requestId, reason });
					// Hotkey / read-selection synthesis runs while the user is in another
					// app — surface the failure as a native OS notification so it's seen.
					notifyCloudTtsFailure(reason);
				},
			}
		);
	};

	// ─── Sentence-chunked read-aloud ──────────────────────────────────
	// Synthesize ONE cloud sentence under the parent id (chunks tagged parent →
	// renderer plays them in order). Resolves when its audio is fully forwarded.
	const synthCloudSentence = (parentId: string, sentence: string, speed: number): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const voiceId = getStoreValue("tts.cloud.voice") || "";
			synthesizeCloud(
				{ requestId: parentId, text: sentence, voiceId, speed },
				{
					onChunk: (p) => broadcastAll(IPC.TTS_CHUNK, p),
					onDone: resolve,
					onError: (reason) => reject(new Error(reason)),
				}
			);
		});

	// Synthesize ONE local (Kokoro) sentence. Uses a server SUB-request id so its
	// chunks are re-tagged to the parent in `onDataBinary` and its `tts_complete`
	// is recognised + suppressed in `handleTtsComplete`, which resolves this.
	const synthLocalSentence = (
		parentId: string,
		sentence: string,
		index: number,
		speed: number
	): Promise<void> =>
		new Promise<void>((resolve) => {
			if (read?.parentId !== parentId) {
				resolve();
				return;
			}
			const subId = `${parentId}::${index}`;
			read.subId = subId;
			read.resolveSentence = resolve;
			readerSubToParent.set(subId, parentId);
			const params = effectiveParams({ speed });
			sttClient.ttsSynthesize({
				requestId: subId,
				text: sentence,
				voice: params.voice,
				lang: params.lang,
				speed: params.speed,
			});
		});

	/**
	 * Run a read-aloud: split into sentences and synthesize each at the reader's
	 * live speed under one parent requestId. `beginRequest`/`showOverlayForTtsRead`
	 * must have already fired. Emits the single final TTS_COMPLETED / TTS_FAILED.
	 */
	const runRead = (parentId: string, text: string): void => {
		// Supersede any prior read (resolve its pending sentence so its loop bails).
		if (read) {
			read.cancelled = true;
			read.resolveSentence?.();
		}
		const cloud = isCloudSource();
		const speed = cloud
			? clampSpeed(getStoreValue("tts.cloud.speed"), true)
			: effectiveParams().speed;
		read = { parentId, cancelled: false, speed, resolveSentence: null, subId: null };
		const control: SentenceReadControl = {
			getSpeed: () => read?.speed ?? 1,
			isCancelled: () => !read || read.parentId !== parentId || read.cancelled,
		};
		const synth = (sentence: string, index: number, sentenceSpeed: number): Promise<void> =>
			cloud
				? synthCloudSentence(parentId, sentence, sentenceSpeed)
				: synthLocalSentence(parentId, sentence, index, sentenceSpeed);
		runSentenceRead(text, synth, control)
			.then(() => {
				if (read?.parentId !== parentId) {
					return;
				}
				const cancelled = read.cancelled;
				read = null;
				endRequest(parentId, IPC.TTS_COMPLETED, {
					requestId: parentId,
					cancelled,
					elapsedMs: null,
				});
			})
			.catch((err: unknown) => {
				if (read?.parentId === parentId) {
					read = null;
				}
				const reason = getErrorMessage(err);
				endRequest(parentId, IPC.TTS_FAILED, { requestId: parentId, reason });
				// Reads run while the user is in another app — surface cloud failures
				// (network / quota) as a native notification so they're seen.
				if (cloud) {
					notifyCloudTtsFailure(reason);
				}
			});
	};

	const onDataBinary = ({ header, pcm }: BinaryChunkPayload): void => {
		const headerType = header.type;
		if (headerType !== "tts_chunk") {
			return;
		}
		const rawId = typeof header.request_id === "string" ? header.request_id : "";
		// Re-tag a read-aloud sentence's sub-request chunks to the parent id so the
		// renderer queue plays the whole multi-sentence read as one request.
		const requestId = readerSubToParent.get(rawId) ?? rawId;
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
		// A read-aloud sentence's per-sentence complete: resolve the reader's
		// pending sentence and SUPPRESS the broadcast — the reader emits the single
		// final TTS_COMPLETED for the parent once the whole read drains.
		if (readerSubToParent.has(requestId)) {
			readerSubToParent.delete(requestId);
			if (read) {
				read.subId = null;
				if (event.cancelled === true) {
					read.cancelled = true;
				}
				const resolve = read.resolveSentence;
				read.resolveSentence = null;
				resolve?.();
			}
			return;
		}
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
	//
	// "Local Kokoro is the active synthesis path" = enabled AND not cloud. We
	// track that composite so we can free the resident Kokoro ONNX session the
	// moment it STOPS being the active path (user switches source->cloud or
	// disables TTS), mirroring how STT frees via the unload-first swap pipeline
	// and how Ollama frees via keep_alive:0 eviction when going cloud/disabled.
	const isLocalActive = (): boolean => isTtsEnabled() && !isCloudSource();
	let lastLocalActive = isLocalActive();
	// One-shot guard for the "the previous session was mid-install" check.
	// We only want to flip the toggle off on the FIRST connect after app
	// boot — subsequent reconnects (server crash recovery, dev hot-reload)
	// should warm up as normal even if the install is incomplete, since
	// the user already opted in earlier in the session.
	let bootInstallCheckDone = false;

	// First-connect-of-session check: if TTS was left enabled across an app
	// restart but the install never finished (partial files on disk, or never
	// started), DON'T silently auto-resume. Flip the store flag off so the user
	// sees the toggle in OFF state on startup; re-enabling triggers the existing
	// install gate which shows the dialog and resumes from the partials via HTTP
	// Range. Subsequent reconnects skip this guard so a server restart in the
	// middle of a session doesn't keep flipping the toggle off.
	//
	// Returns `true` when warm-up must be aborted (the toggle was flipped off);
	// `false` to proceed (already installed, probe failed, or check already ran).
	const shouldAbortForIncompleteInstall = async (): Promise<boolean> => {
		// Cloud TTS (ElevenLabs) has no Kokoro engine to install, so never flip
		// `enabled` off for a cloud-only user just because the local files aren't
		// on disk — there's nothing to gate on.
		if (isCloudSource()) {
			return false;
		}
		if (bootInstallCheckDone) {
			return false;
		}
		bootInstallCheckDone = true;
		try {
			const raw = (await sttClient.ttsDownloadEstimate()) as unknown;
			const alreadyInstalled =
				isPlainObject(raw) && (raw as { already_installed?: unknown }).already_installed === true;
			if (alreadyInstalled) {
				return false;
			}
			dbg("tts", "boot: install incomplete; flipping enabled OFF (user must re-enable to resume)");
			// Align lastLocalActive BEFORE the store write. electron-store (conf)
			// dispatches the `tts` onDidChange listener SYNCHRONOUSLY inside set()
			// — and fans a nested `tts.enabled` write up to the `tts` key — so the
			// listener below runs mid-`set`. Setting the flag first means it reads
			// the flip-off as inactive->inactive (no edge), not active->inactive,
			// so it never fires a spurious shutdown_tts (nothing was ever warmed).
			lastLocalActive = false;
			store.set("tts.enabled", false);
			return true;
		} catch (err) {
			// Probe failed (server / network blip). Fall through to the warm-up —
			// if there's a real problem, it'll surface as tts_install_failed and
			// the user sees the retry banner.
			dbg("tts", `boot install-check probe failed: ${getErrorMessage(err)}`);
			return false;
		}
	};

	const dispatchWarmup = (): void => {
		try {
			sttClient.initTts();
			dbg("tts", "warm-up: init_tts dispatched");
		} catch (err) {
			dbg("tts", `warm-up init_tts failed: ${getErrorMessage(err)}`);
		}
	};

	const maybeWarmup = async (): Promise<void> => {
		if (!(isTtsEnabled() && sttClient.isConnected)) {
			return;
		}
		// Cloud source has no Kokoro engine to warm — `init_tts` would be wasted.
		if (isCloudSource()) {
			return;
		}
		if (await shouldAbortForIncompleteInstall()) {
			return;
		}
		dispatchWarmup();
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

	// React to transitions of the "local Kokoro active" path. On the
	// inactive->active edge (TTS enabled and source went local) pre-load via
	// fireWarmup() — voice/speed edits don't flip the edge, so they're ignored.
	// On the active->inactive edge (source switched to cloud, or TTS disabled)
	// free the resident Kokoro ONNX session via shutdown_tts so it stops eating
	// RAM/VRAM, mirroring the STT unload-first swap and Ollama keep_alive:0
	// eviction. shutdownTts() is a fire-and-forget control send with no internal
	// connection guard, so gate it on sttClient.isConnected.
	const ttsStoreUnsub = store.onDidChange("tts", () => {
		const localActive = isLocalActive();
		if (localActive && !lastLocalActive) {
			fireWarmup();
		} else if (!localActive && lastLocalActive && sttClient.isConnected) {
			sttClient.shutdownTts();
			dbg("tts", "shutdown_tts dispatched (local path no longer active)");
		}
		lastLocalActive = localActive;
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
		beginRequest(requestId);
		if (isCloudSource()) {
			dispatchCloud(requestId, payload.text, payload.voice);
			return Promise.resolve({ requestId });
		}
		const params = effectiveParams(payload);
		sttClient.ttsSynthesize({
			requestId,
			text: payload.text,
			voice: params.voice,
			lang: params.lang,
			speed: params.speed,
		});
		return Promise.resolve({ requestId });
	};

	/**
	 * Play a cloud voice's FREE pre-generated sample (its `preview_url`) instead
	 * of synthesizing — browsing voices costs no ElevenLabs credits. Routes
	 * through the same begin/chunk/end bookkeeping so the settings UI's
	 * play/stop affordance tracks it identically to a real preview.
	 */
	const handleCloudPreview = (
		_event: Electron.IpcMainInvokeEvent,
		payload: unknown
	): Promise<{ requestId: string }> => {
		if (!isTtsEnabled()) {
			throw new ValidationError("TTS is disabled in settings", "tts.enabled");
		}
		const obj = isPlainObject(payload) ? (payload as { previewUrl?: string }) : {};
		const previewUrl = typeof obj.previewUrl === "string" ? obj.previewUrl : "";
		if (!previewUrl) {
			return Promise.resolve({ requestId: "" });
		}
		const requestId = randomUUID();
		beginRequest(requestId);
		previewCloudClip(
			{ requestId, previewUrl },
			{
				onChunk: (p) => broadcastAll(IPC.TTS_CHUNK, p),
				onDone: () =>
					endRequest(requestId, IPC.TTS_COMPLETED, {
						requestId,
						cancelled: false,
						elapsedMs: null,
					}),
				onError: (reason) => endRequest(requestId, IPC.TTS_FAILED, { requestId, reason }),
			}
		);
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
		beginRequest(requestId);
		showOverlayForTtsRead();
		runRead(requestId, selection.text);
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
		// If a read-aloud is being cancelled, stop its loop and cancel the in-flight
		// server SUB-request (the server knows the sentence sub-id, not the parent)
		// before the generic cleanup below also broadcasts the cancelled complete.
		if (read && (!requestId || requestId === read.parentId)) {
			read.cancelled = true;
			const sub = read.subId;
			read.subId = null;
			const resolve = read.resolveSentence;
			read.resolveSentence = null;
			if (sub) {
				readerSubToParent.delete(sub);
				try {
					sttClient.ttsCancel(sub);
				} catch (err) {
					dbg("tts", `read sub-cancel failed: ${getErrorMessage(err)}`);
				}
			}
			resolve?.();
		}
		try {
			sttClient.ttsCancel(requestId);
		} catch (err) {
			dbg("tts", `ttsCancel failed: ${getErrorMessage(err)}`);
		}
		if (requestId) {
			// Abort the matching cloud fetch (no-op when local / not tracked).
			abortCloudTts(requestId);
			broadcastAll(IPC.TTS_COMPLETED, { requestId, cancelled: true });
			activeIds.delete(requestId);
		} else {
			// Cancel-all: kill every in-flight cloud synthesis too.
			abortAllCloudTts();
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

	// Source-aware "speak this text" entry for the global TTS hotkey. The hotkey
	// captures the active selection itself, then hands the text here so it routes
	// through the SAME branch as handleSpeak — honouring the Local⇄Cloud toggle
	// (ElevenLabs when cloud) instead of always hitting Kokoro.
	activeSpeakText = (text: string): void => {
		if (!(isTtsEnabled() && text.trim())) {
			return;
		}
		const requestId = randomUUID();
		beginRequest(requestId);
		showOverlayForTtsRead();
		runRead(requestId, text);
	};

	const handleCancel = (_event: Electron.IpcMainEvent, payload: unknown): void => {
		const obj = isPlainObject(payload) ? (payload as { requestId?: string }) : {};
		cancel(obj.requestId);
	};

	/**
	 * Set the read-aloud speed from the pill's speed control. Applies to the
	 * active read's UPCOMING sentences (the playing one finishes at its speed —
	 * "next-sentence, natural pitch") AND persists to the active source's setting
	 * so the next read + the settings UI reflect it.
	 */
	const handleSetSpeed = (_event: Electron.IpcMainEvent, payload: unknown): void => {
		const obj = isPlainObject(payload) ? (payload as { speed?: unknown; value?: unknown }) : {};
		const raw = typeof obj.value === "number" ? obj.value : obj.speed;
		if (typeof raw !== "number") {
			return;
		}
		const cloud = isCloudSource();
		const speed = clampSpeed(raw, cloud);
		if (read) {
			read.speed = speed;
		}
		// Persist; a plain speed write doesn't flip the local-active edge in the
		// `tts` onDidChange listener, so it won't trigger warm-up/shutdown.
		store.set(cloud ? "tts.cloud.speed" : "tts.speed", speed);
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
		// Audio has fully drained (also fires on cancel / failure) — drop the
		// read-aloud pill. Gated so a settings preview never hides the STT pill.
		hideOverlayForTtsRead();
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
	ipcMain.on(IPC.TTS_SET_SPEED, handleSetSpeed);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_STARTED, handleReportPlaybackStarted);
	ipcMain.on(IPC.TTS_REPORT_PLAYBACK_ENDED, handleReportPlaybackEnded);
	ipcMain.handle(IPC.TTS_INIT, handleInit);
	ipcMain.handle(IPC.TTS_LIST_VOICES, handleListVoices);
	ipcMain.handle(IPC.TTS_CLOUD_LIST_VOICES, () => handleCloudListVoices());
	ipcMain.handle(IPC.TTS_CLOUD_PREVIEW, handleCloudPreview);
	ipcMain.handle(IPC.TTS_CLOUD_SUBSCRIPTION, () => handleCloudSubscription());
	ipcMain.handle(IPC.TTS_DOWNLOAD_ESTIMATE, handleDownloadEstimate);
	ipcMain.on(IPC.TTS_INSTALL_PAUSE, handleInstallPause);
	ipcMain.on(IPC.TTS_INSTALL_RESUME, handleInstallResume);
	ipcMain.on(IPC.TTS_INSTALL_CANCEL, handleInstallCancel);

	return () => {
		ipcMain.removeHandler(IPC.TTS_SPEAK);
		ipcMain.removeHandler(IPC.TTS_SPEAK_SELECTION);
		ipcMain.removeAllListeners(IPC.TTS_CANCEL);
		ipcMain.removeAllListeners(IPC.TTS_SET_SPEED);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_STARTED);
		ipcMain.removeAllListeners(IPC.TTS_REPORT_PLAYBACK_ENDED);
		ipcMain.removeHandler(IPC.TTS_INIT);
		ipcMain.removeHandler(IPC.TTS_LIST_VOICES);
		ipcMain.removeHandler(IPC.TTS_CLOUD_LIST_VOICES);
		ipcMain.removeHandler(IPC.TTS_CLOUD_PREVIEW);
		ipcMain.removeHandler(IPC.TTS_CLOUD_SUBSCRIPTION);
		ipcMain.removeHandler(IPC.TTS_DOWNLOAD_ESTIMATE);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_PAUSE);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_RESUME);
		ipcMain.removeAllListeners(IPC.TTS_INSTALL_CANCEL);
		sttClient.off("data-binary", onDataBinary);
		sttClient.off("data-event", onDataEvent);
		sttClient.off("connected", fireWarmup);
		ttsStoreUnsub();
		// Abort any cloud synthesis still streaming so its fetch doesn't outlive
		// the handler set (e.g. on server reconnect / app shutdown).
		abortAllCloudTts();
		activeIds.clear();
		readerSubToParent.clear();
		read = null;
		activeCancelAll = null;
		activeSpeakText = null;
	};
}

export function setupTts(sttClient: SttClient): () => void {
	return setupTtsImpl(sttClient);
}
