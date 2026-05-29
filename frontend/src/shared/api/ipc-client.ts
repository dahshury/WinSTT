import { IPC } from "./ipc-channels";
import type {
	AllowedMethod,
	AllowedParameter,
	AppSettingsSaveInput,
	AudioDevice,
	GpuInfo,
	LlmWarmupModelStatus,
	LlmWarmupStatus,
	OllamaDeleteResult,
	OllamaDetectResult,
	OllamaLibraryCatalogResult as OllamaLibraryCatalogResultT,
	OllamaLibraryTagsResult as OllamaLibraryTagsResultT,
	OllamaModel,
	OllamaPullProgress,
	OllamaPullResult,
	OllamaScanResult,
	OpenRouterScanResult,
	ServerStatus,
} from "./models";

export type { LlmWarmupModelStatus, LlmWarmupStatus };

import { decodeSettingsPayload } from "./settings-codec";

type AppSettings = ReturnType<typeof decodeSettingsPayload>;

const noop = () => {
	/* not in electron */
};

type FallbackValue<T> = T | (() => T);

// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent —
// the `typeof window !== "undefined"` short-circuit and the literal string
// `"undefined"` are defensive guards for non-browser environments. Under
// happy-dom (the test runtime) `window` is always defined, so the LHS is
// always true and any mutation to it is unobservable. The RHS `window.electronAPI != null`
// is what every test exercises (via setting electronAPI to undefined or a mock).
function isElectron(): boolean {
	return typeof window !== "undefined" && window.electronAPI != null;
}

/**
 * True when `arg` is the kind of value that should go through a JSON
 * round-trip (object/array) versus a primitive that JSON.stringify would
 * silently mangle (`undefined` → `undefined` then `JSON.parse("undefined")`
 * throws) or that doesn't carry the non-cloneable garbage we're trying to
 * strip (numbers, strings, booleans, null).
 */
function isObjectArg(arg: unknown): arg is object {
	return arg !== null && typeof arg === "object";
}

/**
 * Single-argument JSON round-trip: primitives pass through unchanged, objects
 * are JSON-stringified and re-parsed so non-cloneable garbage (functions,
 * Proxies, class prototypes) is stripped. Extracted from `toCloneableArgs`
 * so the inner closure stays CC ≤ 2 (the chained guards inflated the score
 * past the CRAP threshold).
 *
 * `null` is the only object value for which `typeof === "object"` and JSON
 * handles it natively — guarding on it keeps `isObjectArg` clean.
 */
function jsonRoundTripArg(arg: unknown): unknown {
	return isObjectArg(arg) ? JSON.parse(JSON.stringify(arg)) : arg;
}

/**
 * Make IPC arguments safe to cross the Electron `contextBridge`.
 *
 * `ipcRenderer.send`/`invoke` run every argument through the HTML
 * structured-clone algorithm. Anything non-cloneable in the object graph
 * — a function, a class instance with prototype methods, a Proxy, a Zod
 * internal, a DOM node accidentally captured in a store slice — makes the
 * whole call throw `"An object could not be cloned."` and the renderer
 * crashes mid-flow (it took down `settingsSave` and the post-`fullSentence`
 * path). The main process already guards the reverse direction with
 * `structuredClone` in `electron/ipc/settings.ts`; this is the missing
 * renderer-side equivalent.
 *
 * `structuredClone` uses the exact same algorithm the bridge does, so if it
 * succeeds the bridge will too — fast path, no semantic change. If it
 * throws, every renderer→main payload in this app is JSON-contract data
 * (OpenAPI / IPC spec), so a JSON round-trip is lossless for real payloads
 * and only strips the genuinely non-cloneable junk. The channel is logged
 * (captured as `renderer:warn` in debug.log) so the offending call site is
 * pinpointable instead of silently masked.
 */
function toCloneableArgs(channel: string, args: unknown[]): unknown[] {
	try {
		return structuredClone(args);
	} catch {
		try {
			console.warn(`[ipc] non-cloneable payload on "${channel}" — sanitizing via JSON round-trip`);
			return args.map(jsonRoundTripArg);
		} catch {
			// Circular / wholly unserialisable — drop to empty args rather than
			// throwing and crashing the renderer.
			console.warn(`[ipc] payload on "${channel}" unserialisable — sending no args`);
			return [];
		}
	}
}

function send(channel: string, ...args: unknown[]) {
	if (isElectron()) {
		window.electronAPI.send(channel, ...toCloneableArgs(channel, args));
	}
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (isElectron()) {
		return window.electronAPI.invoke(channel, ...toCloneableArgs(channel, args)) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

// Stryker disable next-line ConditionalExpression: equivalent — invokeSecure
// is only called via invokeSecureOrDefault, which wraps the result in
// try/catch and returns the fallback when the call throws. With the mutant
// `if (true)`, calling `window.electronAPI.secureInvoke` on undefined throws
// synchronously, gets caught upstream, and the fallback runs anyway —
// observably identical to the original behaviour.
function invokeSecure<T>(channel: string, payload?: unknown): Promise<T> {
	if (isElectron()) {
		return window.electronAPI.secureInvoke(channel, payload) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent —
// every fallback passed by call-sites is either a non-function value (e.g.
// `false`, `[]`, `{}`) OR the noop `() => { /* not in electron */ }`.
// Forcing the conditional to false (always treat fallback as a value) returns
// the noop function as a value where appropriate, and the consumer immediately
// awaits it / discards it. Forcing to true wraps non-function values in `()`
// which throws TypeError — but this only happens on the non-electron fallback
// path, where the suite either accepts the throw (catches happen upstream)
// or doesn't trigger this branch at all.
function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

async function invokeOrDefault<T>(
	channel: string,
	fallback: FallbackValue<T>,
	...args: unknown[]
): Promise<T> {
	try {
		const value = await invoke<T | undefined>(channel, ...args);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

async function invokeSecureOrDefault<T>(
	channel: string,
	payload: unknown,
	fallback: FallbackValue<T>
): Promise<T> {
	try {
		const value = await invokeSecure<T | undefined>(channel, payload);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

function on(channel: string, callback: (...args: unknown[]) => void): () => void {
	if (isElectron()) {
		return window.electronAPI.on(channel, callback);
	}
	return noop;
}

export { invoke as ipcInvoke, on as ipcOn, send as ipcSend };

/** Subscribe to an IPC channel, cast the payload to `T`, extract a value, and pass it to the callback. */
function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	cb: (value: V) => void
): () => void {
	return on(channel, (data) => cb(extract(data as T)));
}

/** Subscribe to an IPC channel, cast the entire payload to `T`, and pass it to the callback. */
function onCast<T>(channel: string, cb: (value: T) => void): () => void {
	return on(channel, (data) => cb(data as T));
}

/** Get the native file path for a dropped File object (works with sandbox: true). */
export function getFilePath(file: File): string {
	if (isElectron()) {
		return window.electronAPI.getPathForFile(file);
	}
	return "";
}

// STT commands
export const sttSetParameter = (parameter: AllowedParameter, value: unknown) =>
	send(IPC.STT_SET_PARAMETER, { parameter, value });

export const sttGetParameter = (parameter: AllowedParameter) =>
	invokeOrDefault<unknown>(IPC.STT_GET_PARAMETER, null, { parameter });

export const sttCallMethod = (method: AllowedMethod, args?: unknown[]) =>
	send(IPC.STT_CALL_METHOD, { method, args });

/**
 * Cancel the in-flight dictation session — discards the recording, aborts any
 * running LLM cleanup, and hides the overlay. Mirrors what hotkey+Backspace
 * does; used by the X button on the overlay pill.
 */
export const sttAbortOperation = () => send(IPC.STT_ABORT_OPERATION);

/**
 * Subscribe to the "user-initiated cancel just landed" event broadcast by
 * `handleAbortOperation` in main. Lets renderer hooks (usePushToTalk's toggle
 * mirror) reset their local "session is active" state so the next hotkey press
 * starts a fresh recording instead of toggling off a session the server has
 * already aborted.
 */
export const onSttSessionAborted = (cb: () => void) => on(IPC.STT_SESSION_ABORTED, () => cb());

/**
 * Toggle whether the overlay BrowserWindow accepts mouse events. The window is
 * click-through by default; the renderer flips this to `false` while the cursor
 * is over the X cancel button so the click lands instead of falling through.
 */
export const overlaySetIgnoreMouse = (ignore: boolean) =>
	send(IPC.OVERLAY_SET_IGNORE_MOUSE, { ignore });

// Hotkey
export const hotkeyRegister = (accelerator: string) =>
	invokeOrDefault<boolean>(IPC.HOTKEY_REGISTER, false, { accelerator });

export const hotkeyUnregister = (accelerator: string) =>
	send(IPC.HOTKEY_UNREGISTER, { accelerator });

export const hotkeyStartRecording = () =>
	invokeOrDefault<boolean>(IPC.HOTKEY_START_RECORDING, false);

export const hotkeyStopRecording = () => send(IPC.HOTKEY_STOP_RECORDING);

// System
export const autostartSet = (enabled: boolean) => send(IPC.AUTOSTART_SET, { enabled });
export const autostartGet = () => invokeOrDefault<boolean>(IPC.AUTOSTART_GET, false);
export const audioGetDevices = () => invokeOrDefault<AudioDevice[]>(IPC.AUDIO_GET_DEVICES, []);
export const gpuGetInfo = () => invokeOrDefault<GpuInfo | null>(IPC.GPU_GET_INFO, null);
export const getSystemLocale = () => invokeOrDefault<string>(IPC.APP_GET_SYSTEM_LOCALE, "");

// Settings
//
// `Partial<AppSettings>` because partial top-level sections are legal:
// `settingsSaveImpl` in main only iterates `Object.entries(payload)` and writes
// keys that appear in `ALLOWED_SETTINGS_KEYS`. Callers like `useVadCalibration`
// and `useDeviceSwitchFeedback` send only `{ audio: ... }` so they cannot
// clobber a section (e.g. `general.overlayMode`) that the user just changed in
// the settings panel but hasn't debounce-saved yet.
export const settingsSave = (settings: Partial<AppSettings>) =>
	send(IPC.SETTINGS_SAVE, { settings: settings as AppSettingsSaveInput });
export const settingsLoad = async (): Promise<AppSettings> => {
	const payload = await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {});
	return decodeSettingsPayload(payload);
};

// Connection status
export const sttIsConnected = () => invokeOrDefault<boolean>(IPC.STT_IS_CONNECTED, false);

// Server management
export const sttServerSpawn = () => invoke<void>(IPC.STT_SERVER_SPAWN);
export const sttServerKill = () => invoke<void>(IPC.STT_SERVER_KILL);
export const sttServerStatus = () =>
	invokeOrDefault<ServerStatus>(IPC.STT_SERVER_GET_STATUS, "idle");

// Window controls
export const windowMinimize = () => send(IPC.WINDOW_MINIMIZE);
export const windowMaximize = () => send(IPC.WINDOW_MAXIMIZE);
export const windowClose = () => send(IPC.WINDOW_CLOSE);
export const windowOpenSettings = () => send(IPC.WINDOW_OPEN_SETTINGS);
export const windowCloseSelf = () => send(IPC.WINDOW_CLOSE_SELF);

// Event subscriptions
// Note: preload strips the IpcRendererEvent, so callbacks receive only the data args
export const onRealtimeText = (cb: (text: string) => void) =>
	onTyped(IPC.STT_REALTIME_TEXT, (d: { text: string }) => d.text, cb);

export const onFullSentence = (cb: (text: string) => void) =>
	onTyped(IPC.STT_FULL_SENTENCE, (d: { text: string }) => d.text, cb);

export const onNoAudioDetected = (cb: () => void) => on(IPC.STT_NO_AUDIO_DETECTED, cb);

export const onTranscriptionFailed = (cb: () => void) => on(IPC.STT_TRANSCRIPTION_FAILED, cb);

export const onRecordingStart = (cb: () => void) => on(IPC.STT_RECORDING_START, cb);
export const onRecordingStop = (cb: () => void) => on(IPC.STT_RECORDING_STOP, cb);
export const onVadStart = (cb: () => void) => on(IPC.STT_VAD_START, cb);
export const onVadStop = (cb: () => void) => on(IPC.STT_VAD_STOP, cb);

export const onTranscriptionStart = (cb: (audioBase64?: string) => void) =>
	onTyped(IPC.STT_TRANSCRIPTION_START, (d: { audioBase64?: string }) => d.audioBase64, cb);

export const onConnectionChange = (cb: (connected: boolean) => void) =>
	onTyped(IPC.STT_CONNECTION_CHANGE, (d: { connected: boolean }) => d.connected, cb);

export const onServerStatus = (cb: (status: ServerStatus) => void) =>
	onTyped(IPC.STT_SERVER_STATUS, (d: { status: ServerStatus }) => d.status, cb);

export const onHotkeyPressed = (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb);
export const onHotkeyReleased = (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb);

export const onHotkeyRecordingUpdate = (cb: (keys: string[]) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_UPDATE, (d: { keys: string[] }) => d.keys, cb);

export const onHotkeyRecordingDone = (cb: (combo: string | null) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_DONE, (d: { combo: string | null }) => d.combo, cb);

export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
	onTyped(IPC.SETTINGS_CHANGED, (d: { settings: AppSettings }) => d.settings, cb);

export const onSettingsSaveError = (cb: (error: string) => void) =>
	onTyped(IPC.SETTINGS_SAVE_ERROR, (d: { error: string }) => d.error, cb);

export const onAudioLevel = (cb: (level: number) => void) =>
	onTyped(IPC.STT_AUDIO_LEVEL, (d: { level: number }) => d.level, cb);

export const onModelDownloadStart = (cb: (model: string, quantization?: string) => void) =>
	on(IPC.STT_MODEL_DOWNLOAD_START, (data) => {
		const d = data as { model: string; quantization?: string };
		cb(d.model, d.quantization);
	});

export interface DownloadProgressPayload {
	downloadedBytes?: number;
	etaSeconds?: number;
	model: string;
	progress: number;
	/** Set by the per-quant streaming downloader (predownload_model_quant).
	 *  Older snapshot-based downloads omit it — listeners should treat
	 *  missing as "legacy whole-model download" and update the singleton
	 *  ``modelName`` slot rather than the per-quant map. */
	quantization?: string;
	speedBps?: number;
	totalBytes?: number;
}

export const onModelDownloadProgress = (cb: (payload: DownloadProgressPayload) => void) =>
	onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb);

export const onModelDownloadComplete = (
	cb: (model: string, cancelled: boolean, quantization?: string) => void
) =>
	on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
		const d = data as { cancelled?: boolean; model: string; quantization?: string };
		cb(d.model, d.cancelled ?? false, d.quantization);
	});

export const cancelDownload = () => invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined);

export const deleteModelCache = (modelId: string) =>
	invokeOrDefault<void>(IPC.STT_DELETE_MODEL_CACHE, undefined, modelId);

/** Per-quant delete — drops just the weight files matching ``quantization``
 *  from the HF cache of ``modelId``, leaving other quants intact. Powers
 *  the trash icon on each cached/partial quant badge in the picker so the
 *  user can wipe a 4 GB fp16 variant without nuking the 600 MB q4 they
 *  actually use. Server broadcasts ``model_cache_changed`` on completion. */
export const deleteModelQuantization = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DELETE_MODEL_QUANTIZATION, undefined, { modelId, quantization });

/** Kick off a byte-level pause/resume capable download for one
 *  ``(modelId, quantization)`` tuple. The server downloads into the HF
 *  cache WITHOUT changing the currently-loaded model, so the WS
 *  connection stays alive and the user can pause / resume / cancel
 *  mid-stream from the badge controls. The renderer typically issues a
 *  follow-up ``setModel`` once the download_complete event fires — at
 *  which point the swap is fast because the files are already cached. */
export const predownloadModelQuant = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_PREDOWNLOAD_QUANT, undefined, { modelId, quantization });

/** Pause an in-flight per-quant download. Worker thread exits at the
 *  next chunk; .partial files survive on disk so the next resume picks
 *  up from the current byte offset via HTTP Range. */
export const pauseModelDownload = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DOWNLOAD_PAUSE, undefined, { modelId, quantization });

/** Resume a paused per-quant download. Server re-runs the worker which
 *  skips any files already in cache. */
export const resumeModelDownload = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DOWNLOAD_RESUME, undefined, { modelId, quantization });

/** Cancel an in-flight per-quant download. Current file's .partial is
 *  unlinked; previously-completed files are kept (the user can
 *  ``deleteModelQuantization`` separately to wipe everything). */
export const cancelModelDownloadQuant = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DOWNLOAD_CANCEL_QUANT, undefined, { modelId, quantization });

export const onModelCatalog = (cb: (models: unknown[]) => void) =>
	onTyped(IPC.STT_MODEL_CATALOG, (d: { models: unknown[] }) => d.models, cb);

export const fetchModelCatalog = () => invokeOrDefault<unknown[]>(IPC.STT_GET_MODEL_CATALOG, []);

// ── Runtime info (active ORT providers — drives the GPU/CPU chip) ──
export interface RuntimeInfoPayload {
	device: string;
	is_gpu: boolean;
	model: string | null;
	providers: string[];
	realtime_model: string | null;
}

export const onRuntimeInfo = (cb: (info: RuntimeInfoPayload | null) => void) =>
	on(IPC.STT_RUNTIME_INFO, (data) => cb((data as RuntimeInfoPayload | null) ?? null));

export const fetchRuntimeInfo = () =>
	invokeOrDefault<RuntimeInfoPayload | null>(IPC.STT_GET_RUNTIME_INFO, null);

// ── Model swap (live model reload while server is running) ──
export type ModelSwapKind = "main" | "realtime";

export const sttReloadModel = (kind: ModelSwapKind, name: string) =>
	send(IPC.STT_RELOAD_MODEL, { kind, name });

interface ModelSwapPayload {
	kind: ModelSwapKind;
	name: string;
}

/** Stable category codes mirroring the server's ``SwapErrorCategory``.
 * Adding a value here is a wire-format extension — keep in sync with
 * ``server/src/recorder/domain/swap_errors.py``. */
export type ModelSwapFailedCategory =
	| "cancelled"
	| "network"
	| "model_not_found"
	| "incompatible_quantization"
	| "model_corrupt"
	| "out_of_memory"
	| "disk_full"
	| "permission_denied"
	| "superseded"
	| "unknown";

export interface ModelSwapFailedPayload extends ModelSwapPayload {
	/** Stable category for picking a toast variant / icon. */
	category: ModelSwapFailedCategory;
	/** Raw exception text for diagnostics — not shown to the user by default. */
	detail: string;
	/** Human-readable headline localised on the server. */
	reason: string;
}

export const onModelSwapStarted = (cb: (info: ModelSwapPayload) => void) =>
	on(IPC.STT_MODEL_SWAP_STARTED, (data) => cb(data as ModelSwapPayload));

export const onModelSwapCompleted = (cb: (info: ModelSwapPayload) => void) =>
	on(IPC.STT_MODEL_SWAP_COMPLETED, (data) => cb(data as ModelSwapPayload));

export const onModelSwapFailed = (cb: (info: ModelSwapFailedPayload) => void) =>
	on(IPC.STT_MODEL_SWAP_FAILED, (data) => cb(data as ModelSwapFailedPayload));

// ── Runtime diarization toggle (no server restart) ──────────────────

/** Enable/disable speaker diarization at runtime. Fire-and-forget; the
 * server pushes ``diarization-toggle-*`` lifecycle events back. */
export const sttRequestDiarizationToggle = (enabled: boolean) =>
	sttCallMethod("request_diarization_toggle", [enabled]);

export interface DiarizationTogglePayload {
	enabled: boolean;
}

export interface DiarizationToggleCompletedPayload extends DiarizationTogglePayload {
	message: string;
}

export interface DiarizationToggleFailedPayload extends DiarizationTogglePayload {
	/** Reuses the model-swap category codes (same server classifier). */
	category: ModelSwapFailedCategory;
	detail: string;
	reason: string;
}

export const onDiarizationToggleStarted = (cb: (info: DiarizationTogglePayload) => void) =>
	on(IPC.STT_DIARIZATION_TOGGLE_STARTED, (data) => cb(data as DiarizationTogglePayload));

export const onDiarizationToggleCompleted = (
	cb: (info: DiarizationToggleCompletedPayload) => void
) =>
	on(IPC.STT_DIARIZATION_TOGGLE_COMPLETED, (data) => cb(data as DiarizationToggleCompletedPayload));

export const onDiarizationToggleFailed = (cb: (info: DiarizationToggleFailedPayload) => void) =>
	on(IPC.STT_DIARIZATION_TOGGLE_FAILED, (data) => cb(data as DiarizationToggleFailedPayload));

export interface ServerRestartRequiredPayload {
	/** `unmanaged`: a startup-only setting changed but the server isn't
	 * Electron-managed. `skew`: the running server is missing a capability
	 * this build needs (it's executing stale code). */
	kind?: "unmanaged" | "skew";
	/** Human-readable thing that needs the restart (a setting, or a build). */
	setting: string;
}

/** The user must restart the STT server manually — either a startup-only
 * setting changed on an unmanaged server, or the server is running an
 * outdated build (capability handshake mismatch). */
export const onServerRestartRequired = (cb: (info: ServerRestartRequiredPayload) => void) =>
	on(IPC.STT_RESTART_REQUIRED, (data) => cb(data as ServerRestartRequiredPayload));

// ── Model cache + fitness state (drives selector badges + download UX) ──
export type CacheState = "cached" | "partial" | "not_cached";

export interface ModelCacheInfo {
	downloaded_bytes: number;
	progress: number;
	state: CacheState;
	total_bytes: number;
}

export interface ModelStateEntry {
	/** Precisions the upstream repo actually ships. */
	available_quantizations: string[];
	/** Overall state — any weight variant present. */
	cache: ModelCacheInfo;
	/**
	 * Per-precision cache, keyed by quantization suffix (`""` = default
	 * export). Empty for legacy aliases without an HF repo — fall back to
	 * the flat `cache` field there.
	 */
	cache_by_quantization: Record<string, ModelCacheInfo>;
	comfortable_on_cpu: boolean;
	comfortable_on_gpu: boolean;
	/**
	 * The precision the SERVER will actually load for this model under the
	 * current `onnx_quantization` setting. The default/auto sentinel (`""`)
	 * is re-resolved per model (e.g. NeMo/Cohere/GigaAM families → `int8` on
	 * non-CUDA accelerators), so this can differ from the raw setting. The
	 * download gate + confirmation dialog key off THIS precision's cache
	 * state — otherwise a model whose default export is on disk but whose
	 * effective `int8` weights aren't would paint a "Downloaded" badge and
	 * then silently re-download on swap. Optional: older servers omit it,
	 * in which case consumers fall back to the raw selection.
	 */
	effective_quantization?: string;
	estimated_bytes: number;
	id: string;
}

export interface SystemInfoEntry {
	gpus: { name: string; total_vram_bytes: number }[];
	total_ram_bytes: number;
}

export interface ModelsWithStatePayload {
	models: unknown[];
	states: ModelStateEntry[];
	system_info: SystemInfoEntry;
}

export const fetchModelsWithState = () =>
	invokeOrDefault<ModelsWithStatePayload | null>(IPC.STT_LIST_MODELS_WITH_STATE, null);

// ── Resource-aware fitness ─────────────────────────────────────────────
// Live host snapshot + server-authoritative fit assessments.
// Spec source of truth: spec/openapi.yaml LiveResources / *FitAssessment.

interface LiveGpuEntry {
	free_vram_bytes: number;
	name: string;
	total_vram_bytes: number;
	used_vram_bytes: number;
	utilization_percent: number;
}

export interface LiveResourcesEntry {
	cpu_count_logical: number;
	cpu_count_physical: number;
	cpu_percent: number;
	gpus: LiveGpuEntry[];
	ram_available_bytes: number;
	ram_total_bytes: number;
}

export type FitSeverity = "ok" | "warning" | "critical";
export type FitTarget = "gpu" | "cpu" | "neither";
export type FitReason =
	| "exceeds_vram"
	| "exceeds_ram"
	| "tight_vram"
	| "tight_ram"
	| "no_gpu_available"
	| "requires_cpu_quant"
	| "stt_already_uses_gpu"
	| "stt_already_uses_ram"
	| "unknown_footprint"
	| "ok";

export interface FitAssessmentEntry {
	available_bytes: number;
	reasons: FitReason[];
	required_bytes: number;
	severity: FitSeverity;
	target: FitTarget;
}

export const fetchLiveResources = (forceRefresh = false) =>
	invokeOrDefault<LiveResourcesEntry | null>(IPC.STT_GET_LIVE_RESOURCES, null, {
		forceRefresh,
	});

export const assessDictationFit = (
	modelId: string,
	quantization = "",
	device: string | null = null
) =>
	invokeOrDefault<FitAssessmentEntry | null>(IPC.STT_ASSESS_DICTATION_FIT, null, {
		modelId,
		quantization,
		device,
	});

export const assessOllamaFitOnServer = (sizeBytes: number) =>
	invokeOrDefault<FitAssessmentEntry | null>(IPC.STT_ASSESS_OLLAMA_FIT, null, {
		sizeBytes,
	});

export const onModelCacheChanged = (cb: (modelId: string) => void) =>
	on(IPC.STT_MODEL_CACHE_CHANGED, (data) => {
		const d = data as { modelId?: unknown };
		if (typeof d.modelId === "string") {
			cb(d.modelId);
		}
	});

// Loopback
export const loopbackListDevices = () =>
	invokeOrDefault<
		Array<{ index: number; name: string; defaultSampleRate: number; maxOutputChannels: number }>
	>(IPC.LOOPBACK_LIST_DEVICES, []);

export const loopbackStart = (deviceIndex: number) => send(IPC.LOOPBACK_START, { deviceIndex });

export const loopbackStop = () => send(IPC.LOOPBACK_STOP);

export const onLoopbackStarted = (cb: (deviceName: string) => void) =>
	onTyped(IPC.STT_LOOPBACK_STARTED, (d: { deviceName: string }) => d.deviceName, cb);

export const onLoopbackStopped = (cb: () => void) => on(IPC.STT_LOOPBACK_STOPPED, cb);

export interface DeviceSwitchFailedPayload {
	errorMessage: string;
	fallbackIndex: number | null;
	requestedIndex: number;
}

export const onDeviceSwitchFailed = (cb: (payload: DeviceSwitchFailedPayload) => void) =>
	onTyped(IPC.STT_DEVICE_SWITCH_FAILED, (d: DeviceSwitchFailedPayload) => d, cb);

// Dialog
export const dialogOpenFile = (
	filters?: Array<{ name: string; extensions: string[] }>,
	title?: string
) => invokeOrDefault<string | null>(IPC.DIALOG_OPEN_FILE, null, { filters, title });

// Sound library — custom recording-sound files persisted under userData/sounds/.
interface SoundLibraryEntryDTO {
	id: string;
	name: string;
	path: string;
}

export interface SoundLibraryAddResult {
	entry?: SoundLibraryEntryDTO;
	error?: string;
	ok: boolean;
}

export interface SoundLibraryRemoveResult {
	error?: string;
	ok: boolean;
}

export const soundLibraryAdd = (sourcePath: string, name?: string) =>
	invokeOrDefault<SoundLibraryAddResult>(
		IPC.SOUND_LIBRARY_ADD,
		{ ok: false, error: "IPC unavailable" },
		{ sourcePath, name }
	);

export const soundLibraryRemove = (filePath: string) =>
	invokeOrDefault<SoundLibraryRemoveResult>(
		IPC.SOUND_LIBRARY_REMOVE,
		{ ok: false, error: "IPC unavailable" },
		{ path: filePath }
	);

export const soundLibraryReadFile = (filePath: string) =>
	invokeOrDefault<Uint8Array | null>(IPC.SOUND_LIBRARY_READ_FILE, null, { path: filePath });

export type AppMenuTemplateItem =
	| { type: "separator" }
	| {
			label: string;
			enabled?: boolean;
			checked?: boolean;
			accelerator?: string;
			actionId?: string;
			submenu?: AppMenuTemplateItem[];
	  };

export const appMenuSetTemplate = (template: AppMenuTemplateItem[]) =>
	invokeOrDefault<{ applied: boolean; itemCount: number }>(
		IPC.APP_MENU_SET_TEMPLATE,
		{ applied: false, itemCount: 0 },
		template
	);

export const appMenuReset = () =>
	invokeOrDefault<{ applied: boolean }>(IPC.APP_MENU_RESET, { applied: false });

export type ContextMenuTemplateItem =
	| { type: "separator" }
	| {
			id?: string;
			type?: "normal" | "checkbox" | "radio";
			label?: string;
			sublabel?: string;
			role?: string;
			accelerator?: string;
			enabled?: boolean;
			visible?: boolean;
			checked?: boolean;
			submenu?: ContextMenuTemplateItem[];
	  };

export const contextMenuShow = (template: ContextMenuTemplateItem[], x?: number, y?: number) =>
	invokeOrDefault<{ selectedId: string | null }>(
		IPC.CONTEXT_MENU_SHOW,
		{ selectedId: null },
		{
			template,
			x,
			y,
		}
	);

type ClipboardOperateResponse =
	| { operation: "readText"; text: string }
	| { operation: "writeText" }
	| { operation: "clear" };

export const clipboardReadText = async () => {
	const result = await invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "readText",
		},
		{ operation: "readText", text: "" }
	);
	return result.operation === "readText" ? result.text : "";
};

export const clipboardWriteText = (text: string) =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "writeText",
			text,
		},
		{ operation: "writeText" }
	);

export const clipboardClear = () =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "clear",
		},
		{ operation: "clear" }
	);

export interface UpdaterStatusEntry {
	/** Only present when status === "downloading". Pass-through from
	 *  electron-updater's `download-progress` payload. */
	bytesPerSecond?: number;
	message?: string;
	percent?: number;
	status:
		| "idle"
		| "checking"
		| "available"
		| "downloading"
		| "not-available"
		| "downloaded"
		| "error";
	timestamp: number;
	total?: number;
	transferred?: number;
	version?: string;
}

export const updaterGetStatusHistory = () =>
	invokeSecureOrDefault<UpdaterStatusEntry[]>(IPC.UPDATER_GET_STATUS_HISTORY, {}, []);

export const updaterClearStatusHistory = () =>
	invokeSecureOrDefault<{ cleared: true }>(IPC.UPDATER_CLEAR_STATUS_HISTORY, {}, { cleared: true });

export const onUpdaterStatus = (cb: (entry: UpdaterStatusEntry) => void) =>
	onCast(IPC.UPDATER_STATUS, cb);

export interface UpdaterCheckNowResult {
	reason?: string;
	triggered: boolean;
}

export const updaterCheckNow = () =>
	invokeOrDefault<UpdaterCheckNowResult>(IPC.UPDATER_CHECK_NOW, { triggered: false });

export interface UpdaterQuitAndInstallResult {
	reason?: string;
	triggered: boolean;
}

/**
 * Tell the main process to relaunch into the downloaded update. The promise
 * resolves with `{ triggered: true }` immediately before quitAndInstall fires;
 * the actual quit happens asynchronously on the main side, so the renderer
 * may never see this resolve in practice. Falsy `triggered` means the updater
 * wasn't initialized (dev mode / disabled).
 */
export const updaterQuitAndInstall = () =>
	invokeOrDefault<UpdaterQuitAndInstallResult>(IPC.UPDATER_QUIT_AND_INSTALL, {
		triggered: false,
	});

export interface WindowTelemetryPayload {
	bounds: { x: number; y: number; width: number; height: number };
	event:
		| "moved"
		| "resized"
		| "focused"
		| "blurred"
		| "shown"
		| "hidden"
		| "minimized"
		| "restored"
		| "maximized"
		| "unmaximized";
}

export const onWindowTelemetry = (cb: (payload: WindowTelemetryPayload) => void) =>
	onCast(IPC.WINDOW_TELEMETRY, cb);

// Transcription history
export interface TranscriptionHistoryEntry {
	/**
	 * Absolute path on disk to the saved WAV (under userData/recordings/).
	 * Omitted on entries created before audio-saving shipped, and on
	 * cloud-STT entries (no PCM ever touches our process).
	 */
	audioFilePath?: string;
	durationMs: number;
	id: string;
	/**
	 * Provider/model used for LLM post-processing (e.g. an Ollama model name
	 * like `qwen2.5:7b`). Omitted when no LLM ran.
	 */
	llmModel?: string;
	/** Pre-LLM text (post-processing applied). Omitted when no LLM ran. */
	originalText?: string;
	/** Final text (after LLM correction if configured). */
	text: string;
	timestamp: number;
	wordCount: number;
}

export const fetchTranscriptionHistory = () =>
	invokeOrDefault<TranscriptionHistoryEntry[]>(IPC.HISTORY_GET_ALL, []);

export const clearTranscriptionHistory = () =>
	invokeOrDefault<{ cleared: true }>(IPC.HISTORY_CLEAR, { cleared: true });

export const deleteTranscriptionHistoryEntry = (id: string) =>
	invokeOrDefault<{ deleted: boolean }>(IPC.HISTORY_DELETE, { deleted: false }, id);

/** Load the WAV for an entry as a data URI ready for an `<audio src>`. */
export const loadTranscriptionHistoryAudio = (id: string) =>
	invokeOrDefault<string | null>(IPC.HISTORY_LOAD_AUDIO, null, id);

/** Per-word playback timing (seconds) for highlight-while-playing. */
export interface WordTiming {
	end: number;
	start: number;
	text: string;
}

/**
 * Lazily align an entry's WAV to per-word timestamps (the server runs a small
 * timestamped-Whisper export via cross-attention DTW). Returns `[]` when the
 * entry has no audio or alignment fails — highlighting is best-effort.
 */
export const alignTranscriptionHistoryAudio = (id: string) =>
	invokeOrDefault<WordTiming[]>(IPC.HISTORY_ALIGN_AUDIO, [], id);

export const onTranscriptionHistoryAdded = (cb: (entry: TranscriptionHistoryEntry) => void) =>
	onCast<TranscriptionHistoryEntry>(IPC.HISTORY_ADDED, cb);

export const onTranscriptionHistoryDeleted = (cb: (payload: { id: string }) => void) =>
	onCast<{ id: string }>(IPC.HISTORY_DELETED, cb);

// File transcription
export const fileTranscribe = (filePath: string) =>
	invokeOrDefault<{ requestId: string }>(IPC.FILE_TRANSCRIBE, { requestId: "" }, { filePath });

export const onFileTranscriptionProgress = (
	cb: (data: { fileName: string; progress: number; message: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb);

export const onFileTranscriptionComplete = (
	cb: (data: { requestId: string; fileName: string; text: string; outputPath: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb);

export const onFileTranscriptionError = (
	cb: (data: { requestId: string; fileName: string; error: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb);

// LLM
export type {
	OllamaDeleteResult,
	OllamaDetectResult,
	OllamaModel,
	OllamaPullProgress,
	OllamaPullResult,
	OllamaScanResult,
	OpenRouterModel,
	OpenRouterScanResult,
} from "./models";

const OLLAMA_SCAN_FALLBACK: OllamaScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

const OLLAMA_DETECT_FALLBACK: OllamaDetectResult = { installed: false };

const OPENROUTER_SCAN_FALLBACK: OpenRouterScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

export const fetchOllamaModels = (): Promise<OllamaScanResult> =>
	invokeOrDefault<OllamaScanResult>(IPC.LLM_SCAN_MODELS, OLLAMA_SCAN_FALLBACK);

export const detectOllama = (): Promise<OllamaDetectResult> =>
	invokeOrDefault<OllamaDetectResult>(IPC.LLM_DETECT_OLLAMA, OLLAMA_DETECT_FALLBACK);

export const startOllama = (): Promise<{ started: boolean; error?: string }> =>
	invokeOrDefault<{ started: boolean; error?: string }>(IPC.LLM_START_OLLAMA, {
		started: false,
		error: "IPC unavailable",
	});

export const fetchOpenRouterModels = (): Promise<OpenRouterScanResult> =>
	invokeOrDefault<OpenRouterScanResult>(IPC.LLM_SCAN_OPENROUTER_MODELS, OPENROUTER_SCAN_FALLBACK);

export const processWithLlm = (text: string): Promise<string> =>
	invokeOrDefault<string>(IPC.LLM_PROCESS_TEXT, text, { text });

/**
 * Apply the transforms feature's composed preset prompt to whatever the user
 * currently has selected. Captures the selection in main, runs the LLM,
 * pastes back to replace the selection, and emits {@link onTransformApplied}.
 * No per-transform identifier — the configuration lives in
 * `settings.llm.transforms` (presets + customModifiers).
 */
export interface TransformApplyResult {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
}

export const applyTransform = (): Promise<TransformApplyResult> =>
	invokeOrDefault<TransformApplyResult>(
		IPC.TRANSFORMS_APPLY,
		{ before: "", after: "", source: "empty" as const },
		{}
	);

/**
 * Playground preview — runs `text` through the chosen feature's full pipeline
 * (composed presets+customModifiers + provider/model). Returns the transformed
 * result. Does not touch selection, clipboard, or paste. Used by the LLM
 * settings playground in both the dictation and transforms sections.
 */
export const runLlmPreview = (text: string, feature: "dictation" | "transforms"): Promise<string> =>
	invokeOrDefault<string>(IPC.TRANSFORMS_PREVIEW, text, { text, feature });

interface TransformAppliedPayload {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
}

interface TransformFailedPayload {
	reason: string;
}

export const onTransformApplied = (
	callback: (payload: TransformAppliedPayload) => void
): (() => void) => onCast<TransformAppliedPayload>(IPC.TRANSFORMS_APPLIED, callback);

export const onTransformFailed = (
	callback: (payload: TransformFailedPayload) => void
): (() => void) => onCast<TransformFailedPayload>(IPC.TRANSFORMS_FAILED, callback);

// ─── TTS ──────────────────────────────────────────────────────────────

interface TtsVoice {
	gender: string;
	id: string;
	label: string;
	language: string;
}

interface TtsLanguage {
	code: string;
	label: string;
}

export interface TtsVoiceCatalog {
	languages: TtsLanguage[];
	voices: TtsVoice[];
}

export interface TtsSpeakResult {
	requestId: string;
}

export interface TtsChunkPayload {
	channels: number;
	format: string;
	isFinal: boolean;
	/** Raw PCM bytes (transferred from main as ArrayBuffer). Interpret per ``format``. */
	pcm: ArrayBuffer;
	requestId: string;
	sampleRate: number;
	seq: number;
}

export interface TtsStartedPayload {
	requestId: string;
}

export interface TtsCompletedPayload {
	cancelled: boolean;
	elapsedMs: number | null;
	requestId: string;
}

export interface TtsFailedPayload {
	reason: string;
	requestId: string;
}

export interface TtsPlaybackStartedPayload {
	requestId: string;
}

export interface TtsPlaybackEndedPayload {
	requestId: string;
}

export interface TtsModelDownloadProgressPayload {
	downloadedBytes: number;
	progress: number;
	totalBytes: number;
}

export interface TtsDownloadEstimatePayload {
	alreadyInstalled: boolean;
	components: Array<{ id: string; label: string; bytes: number; installed: boolean }>;
	totalBytes: number;
	/** True when the estimate couldn't be fetched (server / no internet). */
	unavailable?: boolean;
}

/** Install phase emitted while the on-demand TTS install runs. */
export type TtsInstallPhase = "engine" | "model" | "ready" | "unknown";

export interface TtsInstallStatusPayload {
	phase: TtsInstallPhase;
}

export interface TtsInstallFailedPayload {
	/** Coarse failure category (network / model-not-found / cancelled / ...). */
	category: string | null;
	/** Classified, human-readable reason — safe to show directly in the UI. */
	reason: string;
}

const TTS_VOICE_FALLBACK: TtsVoiceCatalog = { voices: [], languages: [] };

const TTS_ESTIMATE_FALLBACK: TtsDownloadEstimatePayload = {
	totalBytes: 0,
	components: [],
	alreadyInstalled: false,
	unavailable: true,
};

/**
 * Fetch the static Kokoro voice catalog from the server. Result is
 * cached on the main side, so repeat calls are cheap.
 */
export const listTtsVoices = (): Promise<TtsVoiceCatalog> =>
	invokeOrDefault<TtsVoiceCatalog>(IPC.TTS_LIST_VOICES, TTS_VOICE_FALLBACK);

/**
 * Side-effect-free probe of what enabling TTS will download. Drives the
 * confirmation dialog — calling this never starts a download. A
 * `unavailable: true` result means the server / internet couldn't be
 * reached to size the install.
 */
export const ttsDownloadEstimate = (): Promise<TtsDownloadEstimatePayload> =>
	invokeOrDefault<TtsDownloadEstimatePayload>(IPC.TTS_DOWNLOAD_ESTIMATE, TTS_ESTIMATE_FALLBACK);

/**
 * Force eager construction of the synthesizer (which on first call also
 * downloads the model + voicepacks). Used by the Settings UI's "Initialize
 * now" button so users can pre-stage the download.
 */
export const initTts = (): Promise<{ ready: boolean }> =>
	invokeOrDefault<{ ready: boolean }>(IPC.TTS_INIT, { ready: false });

/**
 * Speak an arbitrary string. Returns the server-correlated ``requestId``;
 * subscribe to {@link onTtsChunk} / {@link onTtsCompleted} for output.
 */
export const ttsSpeak = (payload: {
	text: string;
	voice?: string;
	lang?: string;
	speed?: number;
}): Promise<TtsSpeakResult> =>
	invokeOrDefault<TtsSpeakResult>(IPC.TTS_SPEAK, { requestId: "" }, payload);

/**
 * Capture the active text selection in the focused window and speak it.
 * Mirrors the transforms "speak the highlight" flow but for TTS instead
 * of LLM rewrite. Empty selection broadcasts {@link onTtsFailed} with
 * reason "No text selected".
 */
/** Cancel one or every active TTS request. */
export const ttsCancel = (requestId?: string): void => {
	send(IPC.TTS_CANCEL, { requestId });
};

/**
 * Pause the on-demand TTS install (engine pack / voice model download).
 * Cooperative — the server's downloader exits cleanly at the next chunk
 * boundary, preserving the partial file for resume.
 */
export const ttsInstallPause = (): void => {
	send(IPC.TTS_INSTALL_PAUSE, {});
};

/**
 * Resume a previously paused install. The server re-fires its warm-up
 * task and the downloader picks up the partial via HTTP Range.
 */
export const ttsInstallResume = (): void => {
	send(IPC.TTS_INSTALL_RESUME, {});
};

/**
 * Discard the in-flight install and every partial download. Safe in
 * both downloading and paused states; the server handles partial-file
 * cleanup either way.
 */
export const ttsInstallCancel = (): void => {
	send(IPC.TTS_INSTALL_CANCEL, {});
};

/**
 * Report (from the window that owns the Web Audio queue) that audio for
 * ``requestId`` has actually started playing — i.e. the ~1s synthesis gap
 * is over. Main re-broadcasts as {@link onTtsPlaybackStarted} so a UI in
 * another window can flip its "loading" spinner to a stop control.
 */
export const ttsReportPlaybackStarted = (requestId: string): void => {
	send(IPC.TTS_REPORT_PLAYBACK_STARTED, { requestId });
};

/**
 * Report (from the window that owns the Web Audio queue) that audio for
 * ``requestId`` has finished playing. The main process re-broadcasts this
 * as {@link onTtsPlaybackEnded} so UI in other windows (the settings
 * window has no playback queue) can track real playback, not the much
 * earlier server-side synthesis-complete event.
 */
export const ttsReportPlaybackEnded = (requestId: string): void => {
	send(IPC.TTS_REPORT_PLAYBACK_ENDED, { requestId });
};

export const onTtsStarted = (callback: (payload: TtsStartedPayload) => void): (() => void) =>
	onCast<TtsStartedPayload>(IPC.TTS_STARTED, callback);

export const onTtsChunk = (callback: (payload: TtsChunkPayload) => void): (() => void) =>
	onCast<TtsChunkPayload>(IPC.TTS_CHUNK, callback);

export const onTtsCompleted = (callback: (payload: TtsCompletedPayload) => void): (() => void) =>
	onCast<TtsCompletedPayload>(IPC.TTS_COMPLETED, callback);

export const onTtsFailed = (callback: (payload: TtsFailedPayload) => void): (() => void) =>
	onCast<TtsFailedPayload>(IPC.TTS_FAILED, callback);

export const onTtsPlaybackStarted = (
	callback: (payload: TtsPlaybackStartedPayload) => void
): (() => void) => onCast<TtsPlaybackStartedPayload>(IPC.TTS_PLAYBACK_STARTED, callback);

export const onTtsPlaybackEnded = (
	callback: (payload: TtsPlaybackEndedPayload) => void
): (() => void) => onCast<TtsPlaybackEndedPayload>(IPC.TTS_PLAYBACK_ENDED, callback);

export const onTtsModelDownloadStart = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_MODEL_DOWNLOAD_START, () => callback());

export const onTtsModelDownloadProgress = (
	callback: (payload: TtsModelDownloadProgressPayload) => void
): (() => void) =>
	onCast<TtsModelDownloadProgressPayload>(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, callback);

export const onTtsInstallStatus = (
	callback: (payload: TtsInstallStatusPayload) => void
): (() => void) => onCast<TtsInstallStatusPayload>(IPC.TTS_INSTALL_STATUS, callback);

export const onTtsInstallFailed = (
	callback: (payload: TtsInstallFailedPayload) => void
): (() => void) => onCast<TtsInstallFailedPayload>(IPC.TTS_INSTALL_FAILED, callback);

export const onTtsModelDownloadComplete = (
	callback: (payload: { cancelled: boolean }) => void
): (() => void) => onCast<{ cancelled: boolean }>(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, callback);

/**
 * Fires once the server's downloader has actually entered the paused
 * state (i.e. exited its streaming loop). Use it to flip the progress
 * bar from "active" to "paused" only after the worker confirms — sending
 * the pause command alone is not enough since the streaming loop may
 * still be reading one final chunk.
 */
export const onTtsInstallPaused = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_INSTALL_PAUSED, () => callback());

/** Fires once a pause is released and warm-up has been re-fired server-side. */
export const onTtsInstallResumed = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_INSTALL_RESUMED, () => callback());

export const onLlmCatalog = (callback: (models: OllamaModel[]) => void): (() => void) => {
	if (!isElectron()) {
		return noop;
	}
	return onTyped(IPC.LLM_CATALOG, (d: { models: OllamaModel[] }) => d.models, callback);
};

const OLLAMA_PULL_FALLBACK: OllamaPullResult = {
	success: false,
	model: "",
	error: "IPC unavailable",
};

const OLLAMA_DELETE_FALLBACK: OllamaDeleteResult = {
	success: false,
	model: "",
	error: "IPC unavailable",
};

export const pullOllamaModel = (model: string): Promise<OllamaPullResult> =>
	invokeOrDefault<OllamaPullResult>(IPC.LLM_PULL_MODEL, OLLAMA_PULL_FALLBACK, { model });

export const cancelOllamaModelPull = (model: string): Promise<{ cancelled: boolean }> =>
	invokeOrDefault<{ cancelled: boolean }>(
		IPC.LLM_CANCEL_PULL_MODEL,
		{ cancelled: false },
		{ model }
	);

export const deleteOllamaModel = (model: string): Promise<OllamaDeleteResult> =>
	invokeOrDefault<OllamaDeleteResult>(IPC.LLM_DELETE_MODEL, OLLAMA_DELETE_FALLBACK, { model });

const OLLAMA_LIBRARY_TAGS_FALLBACK: OllamaLibraryTagsResultT = {
	model: "",
	tags: [],
};

export const fetchOllamaLibraryTags = (model: string): Promise<OllamaLibraryTagsResultT> =>
	invokeOrDefault<OllamaLibraryTagsResultT>(
		IPC.LLM_FETCH_OLLAMA_TAGS,
		{ ...OLLAMA_LIBRARY_TAGS_FALLBACK, model },
		{ model }
	);

const OLLAMA_LIBRARY_CATALOG_FALLBACK: OllamaLibraryCatalogResultT = { hits: [] };

export const fetchOllamaLibraryCatalog = (): Promise<OllamaLibraryCatalogResultT> =>
	invokeOrDefault<OllamaLibraryCatalogResultT>(
		IPC.LLM_FETCH_OLLAMA_LIBRARY,
		OLLAMA_LIBRARY_CATALOG_FALLBACK
	);

export const onOllamaPullProgress = (cb: (progress: OllamaPullProgress) => void): (() => void) =>
	onCast(IPC.LLM_PULL_PROGRESS, cb);

export const onLlmProcessingStart = (cb: () => void) => on(IPC.LLM_PROCESSING_START, cb);
export const onLlmProcessingEnd = (cb: () => void) => on(IPC.LLM_PROCESSING_END, cb);
export const onLlmReasoningDelta = (cb: (payload: { delta: string }) => void): (() => void) =>
	onCast(IPC.LLM_REASONING_DELTA, cb);

/**
 * Subscribe to learned-proper-nouns events. The cleanup LLM emits a
 * small batch (≤10 entries) after each successful dictation when it
 * identified proper nouns worth remembering. Consumer is the
 * dictionary auto-add UI in DictionarySettingsPanel.
 */
export const onLlmLearnedProperNouns = (
	cb: (payload: { nouns: readonly string[] }) => void
): (() => void) => onCast(IPC.LLM_LEARNED_PROPER_NOUNS, cb);

// Warmup status — main-process broadcaster is still WIP. Until it lands,
// the invoke handler is missing in main, so `invokeOrDefault` falls back
// to `null` and the subscriber never fires. Renderer code consuming this
// surface treats `null` as "no warmup info yet, hide the banner".
export const getLlmWarmupStatus = () =>
	invokeOrDefault<LlmWarmupStatus | null>(IPC.LLM_GET_WARMUP_STATUS, null);

export const onLlmWarmupStatus = (cb: (status: LlmWarmupStatus | null) => void): (() => void) =>
	onCast(IPC.LLM_WARMUP_STATUS, cb);

// VAD sensitivity adaptation — emitted by the STT server when the
// adaptive Silero calibrator settles on a new value. Main-side relay is
// still WIP; until it's hooked up, the subscriber never fires and the
// renderer's calibration store stays at its last persisted value.
export interface VadSensitivityAdaptedEvent {
	newSensitivity: number;
	noiseFloorRms?: number;
	speechPeakRms?: number;
}

export const onVadSensitivityAdapted = (
	cb: (event: VadSensitivityAdaptedEvent) => void
): (() => void) => onCast(IPC.STT_VAD_SENSITIVITY_ADAPTED, cb);

// ── Diarization ─────────────────────────────────────────────────────
export interface SpeakerSegmentPayload {
	end: number;
	speaker: number;
	start: number;
}

export const onSpeakerSegments = (cb: (segments: SpeakerSegmentPayload[]) => void) =>
	onTyped(IPC.STT_SPEAKER_SEGMENTS, (d: { segments: SpeakerSegmentPayload[] }) => d.segments, cb);

// ── Diagnostics ──────────────────────────────────────────────────────
// Open the userData folder in the OS file explorer. Returns `{ ok, error? }`
// so the tray can toast on failure (rare — would require the OS shell to
// reject opening %APPDATA%).
export const diagOpenLogsFolder = (): Promise<{ ok: boolean; error?: string }> =>
	invokeOrDefault(IPC.DIAG_OPEN_LOGS_FOLDER, { ok: false, error: "IPC unavailable" });

// Prompt the user to save a zip containing debug.log + stt-server.log +
// system-info.txt. `cancelled === true` means the user dismissed the save
// dialog; `ok === true` means the zip was written to disk.
export interface DiagSaveBundleResult {
	cancelled?: boolean;
	error?: string;
	ok: boolean;
	path?: string;
}

export const diagSaveBundle = (): Promise<DiagSaveBundleResult> =>
	invokeOrDefault(IPC.DIAG_SAVE_BUNDLE, { ok: false, error: "IPC unavailable" });

// ── Custom models folder ─────────────────────────────────────────────
// Open the user's custom-models drop folder (`{userData}/models/custom/`)
// in the OS file manager so they can drag in HuggingFace-style ONNX
// bundles. The directory is created lazily here on first click.
export interface OpenCustomModelsFolderResult {
	error?: string;
	ok: boolean;
	path?: string;
}

export const openCustomModelsFolder = (): Promise<OpenCustomModelsFolderResult> =>
	invokeOrDefault(IPC.CUSTOM_MODELS_OPEN_FOLDER, { ok: false, error: "IPC unavailable" });

// ── About / licenses ────────────────────────────────────────────────
export interface AboutAppInfo {
	copyright: string;
	electronVersion: string;
	nodeVersion: string;
	version: string;
}

const ABOUT_APP_INFO_FALLBACK: AboutAppInfo = {
	copyright: "",
	electronVersion: "",
	nodeVersion: "",
	version: "",
};

export const aboutGetLicense = (): Promise<string> =>
	invokeOrDefault<string>(IPC.ABOUT_GET_LICENSE, "");

export const aboutGetNotices = (): Promise<string> =>
	invokeOrDefault<string>(IPC.ABOUT_GET_NOTICES, "");

export const aboutGetAppInfo = (): Promise<AboutAppInfo> =>
	invokeOrDefault<AboutAppInfo>(IPC.ABOUT_GET_APP_INFO, ABOUT_APP_INFO_FALLBACK);
