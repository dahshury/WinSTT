import { commands, type Result, type SpeakResult } from "@/bindings";
import type { CustomModifier, PresetEntry } from "@/shared/lib/preset-prompts";
import { IPC } from "../ipc-channels";
import {
	commandOrDefault,
	hasNativeBridge,
	invokeOrDefault,
	noop,
	on,
	onCast,
	onTyped,
	send,
} from "../ipc-transport";
import type {
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
	OpenRouterSttScanResult,
	OpenRouterTtsScanResult,
} from "../models";
import type { CacheState } from "./models";

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
	OpenRouterSttModel,
	OpenRouterSttScanResult,
	OpenRouterTtsModel,
	OpenRouterTtsScanResult,
} from "../models";

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

const OPENROUTER_STT_SCAN_FALLBACK: OpenRouterSttScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

const OPENROUTER_TTS_SCAN_FALLBACK: OpenRouterTtsScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

export const fetchOllamaModels = (): Promise<OllamaScanResult> =>
	invokeOrDefault<OllamaScanResult>(IPC.LLM_SCAN_MODELS, OLLAMA_SCAN_FALLBACK);

export const detectOllama = (): Promise<OllamaDetectResult> =>
	invokeOrDefault<OllamaDetectResult>(
		IPC.LLM_DETECT_OLLAMA,
		OLLAMA_DETECT_FALLBACK,
	);

export const startOllama = (): Promise<{ started: boolean; error?: string }> =>
	invokeOrDefault<{ started: boolean; error?: string }>(IPC.LLM_START_OLLAMA, {
		started: false,
		error: "IPC unavailable",
	});

export const fetchOpenRouterModels = (): Promise<OpenRouterScanResult> =>
	invokeOrDefault<OpenRouterScanResult>(
		IPC.LLM_SCAN_OPENROUTER_MODELS,
		OPENROUTER_SCAN_FALLBACK,
	);

/**
 * List OpenRouter transcription models (`output_modalities=transcription`) for
 * the cloud STT picker. Uses the shared OpenRouter LLM key on the main side.
 */
export const fetchOpenRouterSttModels = (): Promise<OpenRouterSttScanResult> =>
	invokeOrDefault<OpenRouterSttScanResult>(
		IPC.STT_SCAN_OPENROUTER_MODELS,
		OPENROUTER_STT_SCAN_FALLBACK,
	);

/**
 * List OpenRouter speech (TTS) models (`output_modalities=speech`) for the cloud
 * TTS picker. Uses the shared OpenRouter LLM key on the main side.
 */
export const fetchOpenRouterTtsModels = (): Promise<OpenRouterTtsScanResult> =>
	invokeOrDefault<OpenRouterTtsScanResult>(
		IPC.TTS_SCAN_OPENROUTER_MODELS,
		OPENROUTER_TTS_SCAN_FALLBACK,
	);

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
		{},
	);

/**
 * Explicit LLM config the Playground can run against, independent of the
 * feature's saved settings. Mirrors the reference main `FeatureLlmConfig`
 * shape; shared connection values (Ollama endpoint, OpenRouter API key) are
 * NOT included — main reads those from the store regardless.
 */
export interface LlmPreviewConfig {
	customModifiers: readonly CustomModifier[];
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: readonly PresetEntry[];
	provider: string;
	// `off` disables OpenRouter reasoning (→ `reasoning: { enabled: false }`),
	// sharing the same scale as `thinkingEffort`.
	reasoningEffort: "off" | "low" | "medium" | "high";
	thinkingEffort: "off" | "low" | "medium" | "high";
	verbosity: "low" | "medium" | "high";
}

/**
 * Playground preview — runs `text` through the chosen feature's full pipeline
 * (composed presets+customModifiers + provider/model). Returns the transformed
 * result. Does not touch selection, clipboard, or paste. Used by the LLM
 * Playground modal. An explicit `config` overrides the feature's saved config
 * so the user can test arbitrary tone/modifier/provider/model combinations.
 */
export const runLlmPreview = (
	text: string,
	feature: "dictation" | "transforms",
	config?: LlmPreviewConfig,
): Promise<string> =>
	invokeOrDefault<string>(IPC.TRANSFORMS_PREVIEW, text, {
		text,
		feature,
		config,
	});

// ── Preview-before-pasting ──
// The finalized transcript is held back from auto-paste; the overlay shows the
// editable preview pill. `onPreviewReady` carries the raw `original` (re-process
// source) + the auto-processed `text` (what the pill shows). `confirmPaste`
// restores the captured target window + pastes the user-confirmed preview text;
// `cancelPreview` dismisses without pasting.
export const onPreviewReady = (
	cb: (payload: { original: string; text: string }) => void,
) => onCast(IPC.STT_PREVIEW_READY, cb);

export const confirmPaste = (text: string): Promise<void> =>
	invokeOrDefault<void>(IPC.PREVIEW_CONFIRM_PASTE, undefined, { text });

export const cancelPreview = (): Promise<void> =>
	invokeOrDefault<void>(IPC.PREVIEW_CANCEL, undefined);

interface TransformAppliedPayload {
	after: string;
	before: string;
	source: "uia" | "clipboard" | "empty";
}

interface TransformFailedPayload {
	reason: string;
}

export const onTransformApplied = (
	callback: (payload: TransformAppliedPayload) => void,
): (() => void) =>
	onCast<TransformAppliedPayload>(IPC.TRANSFORMS_APPLIED, callback);

export const onTransformFailed = (
	callback: (payload: TransformFailedPayload) => void,
): (() => void) =>
	onCast<TransformFailedPayload>(IPC.TRANSFORMS_FAILED, callback);

export const onTransformProcessingStart = (cb: () => void) =>
	on(IPC.TRANSFORMS_PROCESSING_START, cb);
export const onTransformProcessingEnd = (cb: () => void) =>
	on(IPC.TRANSFORMS_PROCESSING_END, cb);

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

function unwrapResult<T>(result: Result<T, string>): T {
	if (result.status === "ok") {
		return result.data;
	}
	throw result.error;
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

export interface CloudTtsVoice {
	category: string;
	id: string;
	language: string | null;
	name: string;
	previewUrl: string | null;
}

export interface CloudTtsVoiceCatalog {
	error: string | null;
	voices: CloudTtsVoice[];
}

const TTS_VOICE_FALLBACK: TtsVoiceCatalog = { voices: [], languages: [] };

const TTS_CLOUD_VOICE_FALLBACK: CloudTtsVoiceCatalog = {
	voices: [],
	error: null,
};

/**
 * Fetch the static Kokoro voice catalog from the server. Result is
 * cached on the main side, so repeat calls are cheap.
 */
export const listTtsVoices = (modelId?: string): Promise<TtsVoiceCatalog> =>
	invokeOrDefault<TtsVoiceCatalog>(IPC.TTS_LIST_VOICES, TTS_VOICE_FALLBACK, {
		modelId,
	});

/**
 * Fetch the live ElevenLabs voice catalog for cloud TTS (GET /v2/voices,
 * including cloned voices on the account). Requires a verified ElevenLabs
 * key; returns `{ voices: [], error }` when the key is missing/invalid.
 */
export const ttsCloudListVoices = (): Promise<CloudTtsVoiceCatalog> =>
	invokeOrDefault<CloudTtsVoiceCatalog>(
		IPC.TTS_CLOUD_LIST_VOICES,
		TTS_CLOUD_VOICE_FALLBACK,
	);

/**
 * Play a cloud voice's FREE pre-generated sample (`previewUrl` from the voice
 * catalog) through the playback pipeline. Main fetches the CDN mp3 (the renderer
 * can't — CSP blocks external hosts) and streams it back via {@link onTtsChunk},
 * so previewing voices costs no ElevenLabs character credits. Returns the
 * server-correlated ``requestId`` like {@link ttsSpeak}.
 */
export const ttsCloudPreview = (payload: {
	previewUrl: string;
}): Promise<TtsSpeakResult> =>
	invokeOrDefault<TtsSpeakResult>(
		IPC.TTS_CLOUD_PREVIEW,
		{ requestId: "" },
		payload,
	);

/**
 * Play a selected OpenRouter model voice preview through the TTS playback
 * pipeline. The backend performs a short live `/audio/speech` synthesis for
 * the selected model/voice/speed.
 */
export const ttsOpenRouterPreview = (payload: {
	model: string;
	speed?: number;
	voice: string;
}): Promise<TtsSpeakResult> =>
	commandOrDefault(
		"tts_preview_openrouter",
		async () =>
			unwrapResult<SpeakResult>(
				await commands.ttsPreviewOpenrouter(
					payload.model,
					payload.voice,
					payload.speed ?? null,
				),
			),
		{ requestId: "" },
	);

/**
 * Read the ElevenLabs key's subscription: plan `tier` (`"free"`, `"starter"`, …
 * or null when undeterminable — key lacks user-read scope / request failed) and
 * `creditsExhausted` (monthly character quota spent, free OR paid). The TTS
 * picker locks premium voices unless a paid tier is confirmed, and disables
 * cloud entirely when credits are exhausted.
 */
export const ttsCloudSubscription = (): Promise<{
	creditsExhausted: boolean;
	tier: string | null;
}> =>
	invokeOrDefault<{ creditsExhausted: boolean; tier: string | null }>(
		IPC.TTS_CLOUD_SUBSCRIPTION,
		{
			tier: null,
			creditsExhausted: false,
		},
	);

// ── Multi-provider TTS catalog (model-aware picker) ───────────────────

/** Per-quantization cache state for one TTS model (mirrors STT `ModelCacheInfo`). */
export interface TtsModelCacheInfo {
	downloadedBytes: number;
	progress: number;
	state: CacheState;
	totalBytes: number;
}

export interface TtsModelStateEntry {
	cacheByQuantization: Record<string, TtsModelCacheInfo>;
	effectiveQuantization: string;
	estimatedBytes: number;
	id: string;
}

export interface TtsModelsWithStatePayload {
	models: unknown[];
	states: TtsModelStateEntry[];
}

/** Fetch the TTS catalog plus per-model cache state in one round-trip. */
export const fetchTtsModelsWithState =
	(): Promise<TtsModelsWithStatePayload | null> =>
		invokeOrDefault<TtsModelsWithStatePayload | null>(
			IPC.TTS_LIST_MODELS_WITH_STATE,
			null,
		);

/** Kick off a per-quant download for one `(modelId, quantization)` TTS model. */
export const ttsPredownloadModel = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.TTS_PREDOWNLOAD, undefined, {
		modelId,
		quantization,
	});

/** Pause an in-flight TTS model download (partial file survives for resume). */
export const ttsDownloadPause = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.TTS_DOWNLOAD_PAUSE, undefined, {
		modelId,
		quantization,
	});

/** Resume a paused TTS model download. */
export const ttsDownloadResume = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.TTS_DOWNLOAD_RESUME, undefined, {
		modelId,
		quantization,
	});

/** Cancel an in-flight TTS model download. */
export const ttsDownloadCancel = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.TTS_DOWNLOAD_CANCEL, undefined, {
		modelId,
		quantization,
	});

/** Delete one cached TTS model from disk. */
export const ttsDeleteModel = (modelId: string, quantization: string) =>
	invokeOrDefault<void>(IPC.TTS_DELETE_MODEL, undefined, {
		modelId,
		quantization,
	});

export interface TtsCatalogDownloadProgressPayload {
	downloadedBytes: number;
	model: string;
	progress: number;
	quantization: string;
	totalBytes: number;
}

/** Subscribe to per-quant TTS catalog download progress. */
export const onTtsModelDownloadProgressCatalog = (
	cb: (payload: TtsCatalogDownloadProgressPayload) => void,
): (() => void) => onCast(IPC.TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS, cb);

/** Subscribe to per-quant TTS catalog download completion. */
export const onTtsModelDownloadCompleteCatalog = (
	cb: (model: string, cancelled: boolean, quantization: string) => void,
): (() => void) =>
	on(IPC.TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE, (data) => {
		const d = data as {
			cancelled?: boolean;
			model: string;
			quantization: string;
		};
		cb(d.model, d.cancelled ?? false, d.quantization);
	});

/** Subscribe to TTS model cache invalidations (download finished / deleted). */
export const onTtsModelCacheChanged = (
	cb: (modelId: string) => void,
): (() => void) =>
	on(IPC.TTS_CATALOG_MODEL_CACHE_CHANGED, (data) => {
		const d = data as { modelId?: unknown };
		if (typeof d.modelId === "string") {
			cb(d.modelId);
		}
	});

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
 * Set the read-aloud speed (from the pill's speed control). Applies to the
 * active read's upcoming sentences (next-sentence, natural pitch) and persists
 * to the active source's speed setting.
 */
export const ttsSetSpeed = (speed: number): void => {
	send(IPC.TTS_SET_SPEED, { speed });
};

export const ttsRequestPlaybackPause = (reason = "media-session"): void => {
	send(IPC.TTS_REQUEST_PLAYBACK_PAUSE, { reason });
};

export const ttsRequestPlaybackResume = (reason = "media-session"): void => {
	send(IPC.TTS_REQUEST_PLAYBACK_RESUME, { reason });
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

export const onTtsStarted = (
	callback: (payload: TtsStartedPayload) => void,
): (() => void) => onCast<TtsStartedPayload>(IPC.TTS_STARTED, callback);

export const onTtsChunk = (
	callback: (payload: TtsChunkPayload) => void,
): (() => void) => onCast<TtsChunkPayload>(IPC.TTS_CHUNK, callback);

export const onTtsCompleted = (
	callback: (payload: TtsCompletedPayload) => void,
): (() => void) => onCast<TtsCompletedPayload>(IPC.TTS_COMPLETED, callback);

export const onTtsFailed = (
	callback: (payload: TtsFailedPayload) => void,
): (() => void) => onCast<TtsFailedPayload>(IPC.TTS_FAILED, callback);

export const onTtsPlaybackStarted = (
	callback: (payload: TtsPlaybackStartedPayload) => void,
): (() => void) =>
	onCast<TtsPlaybackStartedPayload>(IPC.TTS_PLAYBACK_STARTED, callback);

export const onTtsPlaybackEnded = (
	callback: (payload: TtsPlaybackEndedPayload) => void,
): (() => void) =>
	onCast<TtsPlaybackEndedPayload>(IPC.TTS_PLAYBACK_ENDED, callback);

export const onTtsPausePlayback = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_PAUSE_PLAYBACK, () => callback());

export const onTtsResumePlayback = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_RESUME_PLAYBACK, () => callback());

export const onTtsDiscardPlayback = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_DISCARD_PLAYBACK, () => callback());

export const onTtsModelDownloadStart = (callback: () => void): (() => void) =>
	onCast<Record<string, never>>(IPC.TTS_MODEL_DOWNLOAD_START, () => callback());

export const onTtsModelDownloadProgress = (
	callback: (payload: TtsModelDownloadProgressPayload) => void,
): (() => void) =>
	onCast<TtsModelDownloadProgressPayload>(
		IPC.TTS_MODEL_DOWNLOAD_PROGRESS,
		callback,
	);

export const onTtsInstallStatus = (
	callback: (payload: TtsInstallStatusPayload) => void,
): (() => void) =>
	onCast<TtsInstallStatusPayload>(IPC.TTS_INSTALL_STATUS, callback);

export const onTtsInstallFailed = (
	callback: (payload: TtsInstallFailedPayload) => void,
): (() => void) =>
	onCast<TtsInstallFailedPayload>(IPC.TTS_INSTALL_FAILED, callback);

export const onTtsModelDownloadComplete = (
	callback: (payload: { cancelled: boolean }) => void,
): (() => void) =>
	onCast<{ cancelled: boolean }>(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, callback);

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

export const onLlmCatalog = (
	callback: (models: OllamaModel[]) => void,
): (() => void) => {
	if (!hasNativeBridge()) {
		return noop;
	}
	return onTyped(
		IPC.LLM_CATALOG,
		(d: { models: OllamaModel[] }) => d.models,
		callback,
	);
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
	invokeOrDefault<OllamaPullResult>(IPC.LLM_PULL_MODEL, OLLAMA_PULL_FALLBACK, {
		model,
	});

export const cancelOllamaModelPull = (
	model: string,
): Promise<{ cancelled: boolean }> =>
	invokeOrDefault<{ cancelled: boolean }>(
		IPC.LLM_CANCEL_PULL_MODEL,
		{ cancelled: false },
		{ model },
	);

export const deleteOllamaModel = (model: string): Promise<OllamaDeleteResult> =>
	invokeOrDefault<OllamaDeleteResult>(
		IPC.LLM_DELETE_MODEL,
		OLLAMA_DELETE_FALLBACK,
		{ model },
	);

const OLLAMA_LIBRARY_TAGS_FALLBACK: OllamaLibraryTagsResultT = {
	model: "",
	tags: [],
};

export const fetchOllamaLibraryTags = (
	model: string,
): Promise<OllamaLibraryTagsResultT> =>
	invokeOrDefault<OllamaLibraryTagsResultT>(
		IPC.LLM_FETCH_OLLAMA_TAGS,
		{ ...OLLAMA_LIBRARY_TAGS_FALLBACK, model },
		{ model },
	);

const OLLAMA_LIBRARY_CATALOG_FALLBACK: OllamaLibraryCatalogResultT = {
	hits: [],
};

export const fetchOllamaLibraryCatalog =
	(): Promise<OllamaLibraryCatalogResultT> =>
		invokeOrDefault<OllamaLibraryCatalogResultT>(
			IPC.LLM_FETCH_OLLAMA_LIBRARY,
			OLLAMA_LIBRARY_CATALOG_FALLBACK,
		);

export const onOllamaPullProgress = (
	cb: (progress: OllamaPullProgress) => void,
): (() => void) => onCast(IPC.LLM_PULL_PROGRESS, cb);

export const onLlmProcessingStart = (cb: () => void) =>
	on(IPC.LLM_PROCESSING_START, cb);
export const onLlmProcessingEnd = (cb: () => void) =>
	on(IPC.LLM_PROCESSING_END, cb);
export const onLlmReasoningDelta = (
	cb: (payload: { delta: string }) => void,
): (() => void) => onCast(IPC.LLM_REASONING_DELTA, cb);

/**
 * Subscribe to learned-proper-nouns events. The cleanup LLM emits a
 * small batch (≤10 entries) after each successful dictation when it
 * identified proper nouns worth remembering. Consumer is the
 * dictionary auto-add UI in DictionarySettingsPanel.
 */
export const onLlmLearnedProperNouns = (
	cb: (payload: { nouns: readonly string[] }) => void,
): (() => void) => onCast(IPC.LLM_LEARNED_PROPER_NOUNS, cb);

// Warmup status is cached by the backend. Renderer code treats `null` as
// "no active warmup info, hide the banner".
export const getLlmWarmupStatus = () =>
	invokeOrDefault<LlmWarmupStatus | null>(IPC.LLM_GET_WARMUP_STATUS, null);

export const retryLlmWarmup = (): Promise<LlmWarmupStatus | null> =>
	commandOrDefault(
		"llm_retry_warmup",
		async () => unwrapResult(await commands.llmRetryWarmup()),
		null,
	);

export const onLlmWarmupStatus = (
	cb: (status: LlmWarmupStatus | null) => void,
): (() => void) => onCast(IPC.LLM_WARMUP_STATUS, cb);
