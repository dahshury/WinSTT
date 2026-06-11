import { IPC } from "../ipc-channels";
import { invokeOrDefault, on, onCast, onTyped, send } from "../ipc-transport";
import { sttCallMethod } from "./stt-audio";

export const onModelDownloadStart = (
	cb: (model: string, quantization?: string) => void,
) =>
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

export const onModelDownloadProgress = (
	cb: (payload: DownloadProgressPayload) => void,
) => onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb);

export const onModelDownloadComplete = (
	cb: (model: string, cancelled: boolean, quantization?: string) => void,
) =>
	on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
		const d = data as {
			cancelled?: boolean;
			model: string;
			quantization?: string;
		};
		cb(d.model, d.cancelled ?? false, d.quantization);
	});

/** Per-quant download PAUSED — broadcast to EVERY window so each one flips its
 *  badge + selector trigger out of the "downloading" state, including the
 *  windows that didn't issue the pause. A paused worker emits no further
 *  progress, so without this signal a window that only watched the download
 *  (e.g. the settings trigger while the pause happened in the detached picker)
 *  would stay stuck on "Downloading X%". Resume is signalled by the inverse
 *  ``stt:model-download-start`` re-emit. */
export const onModelDownloadPaused = (
	cb: (model: string, quantization?: string) => void,
) =>
	on(IPC.STT_MODEL_DOWNLOAD_PAUSED, (data) => {
		const d = data as { model: string; quantization?: string };
		cb(d.model, d.quantization);
	});

export const cancelDownload = () =>
	invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined);

export const deleteModelCache = (modelId: string) =>
	invokeOrDefault<void>(IPC.STT_DELETE_MODEL_CACHE, undefined, modelId);

/** Per-quant delete — drops just the weight files matching ``quantization``
 *  from the HF cache of ``modelId``, leaving other quants intact. Powers
 *  the trash icon on each cached/partial quant badge in the picker so the
 *  user can wipe a 4 GB fp16 variant without nuking the 600 MB q4 they
 *  actually use. Server broadcasts ``model_cache_changed`` on completion. */
export const deleteModelQuantization = (
	modelId: string,
	quantization: string,
) =>
	invokeOrDefault<void>(IPC.STT_DELETE_MODEL_QUANTIZATION, undefined, {
		modelId,
		quantization,
	});

/** Kick off a byte-level pause/resume capable download for one
 *  ``(modelId, quantization)`` tuple. The server downloads into the HF
 *  cache WITHOUT changing the currently-loaded model, so the WS
 *  connection stays alive and the user can pause / resume / cancel
 *  mid-stream from the badge controls. The renderer typically issues a
 *  follow-up ``setModel`` once the download_complete event fires — at
 *  which point the swap is fast because the files are already cached. */
export const predownloadModelQuant = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_PREDOWNLOAD_QUANT, undefined, {
		modelId,
		quantization,
	});

/** Pause an in-flight per-quant download. Worker thread exits at the
 *  next chunk; .partial files survive on disk so the next resume picks
 *  up from the current byte offset via HTTP Range. */
export const pauseModelDownload = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DOWNLOAD_PAUSE, undefined, {
		modelId,
		quantization,
	});

/** Resume a paused per-quant download. Server re-runs the worker which
 *  skips any files already in cache. */
export const resumeModelDownload = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.STT_DOWNLOAD_RESUME, undefined, {
		modelId,
		quantization,
	});

export const onModelCatalog = (cb: (models: unknown[]) => void) =>
	onTyped(IPC.STT_MODEL_CATALOG, (d: { models: unknown[] }) => d.models, cb);

export const fetchModelCatalog = () =>
	invokeOrDefault<unknown[]>(IPC.STT_GET_MODEL_CATALOG, []);

// ── Runtime info (active ORT providers — drives the GPU/CPU chip) ──
export interface RuntimeInfoPayload {
	device: string;
	is_gpu: boolean;
	model: string | null;
	providers: string[];
	realtime_model: string | null;
}

export const onRuntimeInfo = (cb: (info: RuntimeInfoPayload | null) => void) =>
	on(IPC.STT_RUNTIME_INFO, (data) =>
		cb((data as RuntimeInfoPayload | null) ?? null),
	);

export const fetchRuntimeInfo = () =>
	invokeOrDefault<RuntimeInfoPayload | null>(IPC.STT_GET_RUNTIME_INFO, null);

// ── Model swap (live model reload while server is running) ──
export type ModelSwapKind = "main" | "realtime";

export const sttReloadModel = (
	kind: ModelSwapKind,
	name: string,
	quantization?: string,
) =>
	send(IPC.STT_RELOAD_MODEL, {
		kind,
		name,
		quantization: quantization ?? null,
	});

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

export interface DiarizationToggleCompletedPayload
	extends DiarizationTogglePayload {
	message: string;
}

export interface DiarizationToggleFailedPayload
	extends DiarizationTogglePayload {
	/** Reuses the model-swap category codes (same server classifier). */
	category: ModelSwapFailedCategory;
	detail: string;
	reason: string;
}

export const onDiarizationToggleStarted = (
	cb: (info: DiarizationTogglePayload) => void,
) =>
	on(IPC.STT_DIARIZATION_TOGGLE_STARTED, (data) =>
		cb(data as DiarizationTogglePayload),
	);

export const onDiarizationToggleCompleted = (
	cb: (info: DiarizationToggleCompletedPayload) => void,
) =>
	on(IPC.STT_DIARIZATION_TOGGLE_COMPLETED, (data) =>
		cb(data as DiarizationToggleCompletedPayload),
	);

export const onDiarizationToggleFailed = (
	cb: (info: DiarizationToggleFailedPayload) => void,
) =>
	on(IPC.STT_DIARIZATION_TOGGLE_FAILED, (data) =>
		cb(data as DiarizationToggleFailedPayload),
	);

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
	invokeOrDefault<ModelsWithStatePayload | null>(
		IPC.STT_LIST_MODELS_WITH_STATE,
		null,
	);

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
	device: string | null = null,
) =>
	invokeOrDefault<FitAssessmentEntry | null>(
		IPC.STT_ASSESS_DICTATION_FIT,
		null,
		{
			modelId,
			quantization,
			device,
		},
	);

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
		Array<{
			id?: string;
			index: number;
			name: string;
			defaultSampleRate: number;
			maxOutputChannels: number;
			isDefault?: boolean;
		}>
	>(IPC.LOOPBACK_LIST_DEVICES, []);

export const loopbackStart = (deviceIndex: number, modelId: string) =>
	send(IPC.LOOPBACK_START, { deviceIndex, modelId });

export const loopbackStop = () => send(IPC.LOOPBACK_STOP);

export const onLoopbackStarted = (cb: (deviceName: string) => void) =>
	onTyped(
		IPC.STT_LOOPBACK_STARTED,
		(d: { deviceName: string }) => d.deviceName,
		cb,
	);

export const onLoopbackStopped = (cb: () => void) =>
	on(IPC.STT_LOOPBACK_STOPPED, cb);

export interface DeviceSwitchFailedPayload {
	errorMessage: string;
	fallbackIndex: number | null;
	requestedIndex: number;
}

export const onDeviceSwitchFailed = (
	cb: (payload: DeviceSwitchFailedPayload) => void,
) =>
	onTyped(
		IPC.STT_DEVICE_SWITCH_FAILED,
		(d: DeviceSwitchFailedPayload) => d,
		cb,
	);
