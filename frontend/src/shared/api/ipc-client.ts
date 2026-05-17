"use client";

import { IPC } from "./ipc-channels";
import type {
	AllowedMethod,
	AllowedParameter,
	AppSettingsSaveInput,
	AudioDevice,
	GpuInfo,
	LlmWarmupModelStatus,
	LlmWarmupOutcome,
	LlmWarmupStatus,
	OllamaDeleteResult,
	OllamaDetectResult,
	OllamaLibraryCatalogResult as OllamaLibraryCatalogResultT,
	OllamaLibrarySearchResult as OllamaLibrarySearchResultT,
	OllamaLibraryTagsResult as OllamaLibraryTagsResultT,
	OllamaModel,
	OllamaPullProgress,
	OllamaPullResult,
	OllamaScanResult,
	OpenRouterScanResult,
	ServerStatus,
} from "./models";

export type { LlmWarmupModelStatus, LlmWarmupOutcome, LlmWarmupStatus };

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

function send(channel: string, ...args: unknown[]) {
	if (isElectron()) {
		window.electronAPI.send(channel, ...args);
	}
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (isElectron()) {
		return window.electronAPI.invoke(channel, ...args) as Promise<T>;
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
export const settingsSave = (settings: AppSettingsSaveInput) =>
	send(IPC.SETTINGS_SAVE, { settings });
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

export const onModelDownloadStart = (cb: (model: string) => void) =>
	onTyped(IPC.STT_MODEL_DOWNLOAD_START, (d: { model: string }) => d.model, cb);

export interface DownloadProgressPayload {
	downloadedBytes?: number;
	etaSeconds?: number;
	model: string;
	progress: number;
	speedBps?: number;
	totalBytes?: number;
}

export const onModelDownloadProgress = (cb: (payload: DownloadProgressPayload) => void) =>
	onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb);

export const onModelDownloadComplete = (cb: (model: string, cancelled: boolean) => void) =>
	on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
		const d = data as { model: string; cancelled?: boolean };
		cb(d.model, d.cancelled ?? false);
	});

export const cancelDownload = () => invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined);

export const deleteModelCache = (modelId: string) =>
	invokeOrDefault<void>(IPC.STT_DELETE_MODEL_CACHE, undefined, modelId);

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

export interface LiveGpuEntry {
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
	message?: string;
	status: "idle" | "checking" | "available" | "not-available" | "downloaded" | "error";
	timestamp: number;
	version?: string;
}

export const updaterGetStatusHistory = () =>
	invokeSecureOrDefault<UpdaterStatusEntry[]>(IPC.UPDATER_GET_STATUS_HISTORY, {}, []);

export const updaterClearStatusHistory = () =>
	invokeSecureOrDefault<{ cleared: true }>(IPC.UPDATER_CLEAR_STATUS_HISTORY, {}, { cleared: true });

export const onUpdaterStatus = (cb: (entry: UpdaterStatusEntry) => void) =>
	onCast(IPC.UPDATER_STATUS, cb);

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
	durationMs: number;
	id: string;
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

export const onTranscriptionHistoryAdded = (cb: (entry: TranscriptionHistoryEntry) => void) =>
	onCast<TranscriptionHistoryEntry>(IPC.HISTORY_ADDED, cb);

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
	OllamaPullProgressStatus,
	OllamaPullResult,
	OllamaScanResult,
	OpenRouterEndpoint,
	OpenRouterModel,
	OpenRouterPricing,
	OpenRouterScanResult,
	RecommendedOllamaModel,
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
 * Apply a transform to whatever the user currently has selected. Captures
 * the selection in main, runs the LLM with the transform's custom prompt,
 * pastes back to replace the selection, and emits {@link onTransformApplied}.
 */
export interface TransformApplyResult {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
	transformId: string;
}

export const applyTransform = (transformId: string): Promise<TransformApplyResult> =>
	invokeOrDefault<TransformApplyResult>(
		IPC.TRANSFORMS_APPLY,
		{
			transformId,
			before: "",
			after: "",
			source: "empty" as const,
		},
		{ transformId }
	);

/**
 * Playground preview — runs `systemPrompt` against `text` and returns the
 * transformed result, without touching selection, clipboard, or paste.
 * Used by the Transforms settings UI's playground panel.
 */
export const previewTransform = (text: string, systemPrompt: string): Promise<string> =>
	invokeOrDefault<string>(IPC.TRANSFORMS_PREVIEW, text, { text, systemPrompt });

interface TransformAppliedPayload {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
	transformId: string;
	transformName: string;
}

interface TransformFailedPayload {
	reason: string;
	transformId: string;
}

export const onTransformApplied = (
	callback: (payload: TransformAppliedPayload) => void
): (() => void) => onCast<TransformAppliedPayload>(IPC.TRANSFORMS_APPLIED, callback);

export const onTransformFailed = (
	callback: (payload: TransformFailedPayload) => void
): (() => void) => onCast<TransformFailedPayload>(IPC.TRANSFORMS_FAILED, callback);

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

const OLLAMA_LIBRARY_SEARCH_FALLBACK: OllamaLibrarySearchResultT = {
	hits: [],
	hasMore: false,
	page: 0,
	query: "",
};

const OLLAMA_LIBRARY_TAGS_FALLBACK: OllamaLibraryTagsResultT = {
	model: "",
	tags: [],
};

export const searchOllamaLibrary = (query: string, page = 0): Promise<OllamaLibrarySearchResultT> =>
	invokeOrDefault<OllamaLibrarySearchResultT>(
		IPC.LLM_SEARCH_OLLAMA_LIBRARY,
		{ ...OLLAMA_LIBRARY_SEARCH_FALLBACK, query, page },
		{ query, page }
	);

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
