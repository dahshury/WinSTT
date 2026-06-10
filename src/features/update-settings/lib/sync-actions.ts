/**
 * Pure (well — IPC-side-effecting) sync actions extracted from
 * use-sync-settings.ts so they can be unit-tested in isolation.
 *
 * The dependencies are passed in as a `Deps` interface rather than imported
 * statically: that lets the tests inject in-memory spies without
 * `mock.module()` polluting the shared bun:test registry.
 */

import type { AllowedParameter } from "@/shared/api/models";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	computeSilenceEndpointEnabled,
	computeSilenceTiming,
	getManualToggleStop,
	getPrevManualToggleStop,
	getPrevSmartEndpoint,
	getRecordingMode,
	getSmartEndpoint,
	shouldSendInitial,
	shouldSendOnChange,
	silenceEndpointNeedsUpdate,
	silenceTimingNeedsUpdate,
} from "./sync-helpers";

/** Side-effect ports injected so tests can spy on them. */
export interface SyncDeps {
	sttRequestDiarizationToggle: (enabled: boolean) => void;
	sttSetParameter: <V>(param: AllowedParameter, value: V) => void;
}

/**
 * Audio settings are applied through `settingsSave` and backend-owned readers/bridges.
 * Keep this empty until a Rust `winstt_set_parameter` branch actually consumes a key.
 */
export const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {};

// NOTE: `global.modelUnloadTimeout` is NOT pushed here via `set_parameter`. It is
// persisted canonically via `winstt_set_settings` (the `settingsSave` debounced write);
// the backend's on-save handler (`apply_model_runtime_settings` →
// `sync_core_model_unload_timeout`) mirrors it into the `AppSettings` shadow AND
// warms/reloads the model. The former `set_parameter("model_unload_timeout_seconds")`
// push was a second write path into the same shadow field — removed so each setting has
// exactly one writer.

/** Whether a parameter must be pushed given the initial/incremental mode. */
export function shouldSendParam<V>(
	value: V | undefined | null,
	prevValue: V | undefined | null,
	isInitial: boolean,
): boolean {
	return isInitial
		? shouldSendInitial(value)
		: shouldSendOnChange(value, prevValue);
}

/** Send a parameter only when it changed (incremental) or is non-null (initial). */
export function sendIfChanged<V>(
	deps: SyncDeps,
	value: V | undefined | null,
	prevValue: V | undefined | null,
	param: AllowedParameter,
	isInitial: boolean,
): void {
	if (shouldSendParam(value, prevValue, isInitial)) {
		deps.sttSetParameter(param, value);
	}
}

/** Push every (camelKey, snakeKey) pair from the audio map onto the server. */
export function syncAudioEntries(
	deps: SyncDeps,
	audio: NonNullable<AppSettings["audio"]>,
	prevAudio: AppSettings["audio"] | undefined,
	isInitial: boolean,
): void {
	for (const [camelKey, snakeKey] of Object.entries(AUDIO_PARAM_MAP)) {
		const key = camelKey as keyof typeof audio;
		sendIfChanged(deps, audio[key], prevAudio?.[key], snakeKey, isInitial);
	}
}

export function syncAudioParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const audio = settings.audio;
	if (!audio) {
		return;
	}
	const isInitial = !prev;
	syncAudioEntries(deps, audio, prev?.audio, isInitial);
}

export function syncModelParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const model = settings.model;
	const prevModel = prev?.model;
	const isInitial = !prev;
	sendIfChanged(
		deps,
		model?.language,
		prevModel?.language,
		"language",
		isInitial,
	);
	// Intentionally NOT syncing `model.model` via set_parameter: every model
	// change in the UI goes through `sttReloadModel` (stt:reload-model), which
	// is the canonical swap path. Mirroring it here would fire a second swap
	// — the recorder's `model.setter` spawns its own swap thread — and the two
	// races produce duplicate downloads, duplicate Loading logs, and the
	// download-cancel/revert dance we saw in production.
	//
	// The four knobs below used to live in STARTUP_ONLY_KEYS_LIST and force
	// a process kill on every flip. The facade now exposes matching setters
	// (recorder/__init__.py) that update config and trigger an in-place
	// model reload via request_model_swap. The reload reuses the swap
	// worker's daemon-thread + GC + lock-protected install pattern, so the
	// WS, audio source, VAD, and pipeline state are all preserved.
	sendIfChanged(
		deps,
		model?.onnxQuantization,
		prevModel?.onnxQuantization,
		"onnx_quantization",
		isInitial,
	);
	// `model.translateToEnglish` is persisted canonically via `winstt_set_settings`
	// (the STT pipeline reads `WinsttSettings.model.translate_to_english`). No legacy
	// `set_parameter` push: that fed an AppSettings-shadow write nothing read.
	syncInitialPromptStatics(deps, model, prevModel, isInitial);
}

/**
 * Push the static (non-context, non-dictionary) initial prompt prefixes
 * to the server. The composed prompt that includes the dictionary +
 * volatile context tail is pushed separately by the reference's
 * ``installInitialPromptSync`` whenever those upstream inputs change;
 * this handler only fires on edits to the user-typed static prefix in
 * the Settings UI. Both produce ``set_parameter("initial_prompt", ...)``
 * frames the server's facade treats identically.
 */
function syncInitialPromptStatics(
	deps: SyncDeps,
	model: AppSettings["model"] | undefined,
	prevModel: AppSettings["model"] | undefined,
	isInitial: boolean,
): void {
	sendIfChanged(
		deps,
		model?.initialPrompt,
		prevModel?.initialPrompt,
		"initial_prompt",
		isInitial,
	);
	sendIfChanged(
		deps,
		model?.initialPromptRealtime,
		prevModel?.initialPromptRealtime,
		"initial_prompt_realtime",
		isInitial,
	);
}

/** Mapping of quality keys → AllowedParameter names. */
const QUALITY_PARAM_MAP: Record<string, AllowedParameter> = {
	smartEndpoint: "smart_endpoint_enabled",
	smartEndpointSpeed: "detection_speed",
	endOfSentenceDetectionPause: "end_of_sentence_detection_pause",
	midSentenceDetectionPause: "mid_sentence_detection_pause",
	unknownSentenceDetectionPause: "unknown_sentence_detection_pause",
};

/** Push the per-field quality params (smart endpoint, detection pauses, …). */
function syncQualityFields(
	deps: SyncDeps,
	quality: AppSettings["quality"] | undefined,
	prevQuality: AppSettings["quality"] | undefined,
	isInitial: boolean,
): void {
	for (const [camelKey, snakeKey] of Object.entries(QUALITY_PARAM_MAP)) {
		const key = camelKey as keyof NonNullable<typeof quality>;
		sendIfChanged(
			deps,
			quality?.[key],
			prevQuality?.[key],
			snakeKey,
			isInitial,
		);
	}
}

/** Push the `silence_timing` flag when any input that gates it has changed. */
function maybeSyncSilenceTiming(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const smartEndpoint = getSmartEndpoint(settings);
	const prevSmartEndpoint = getPrevSmartEndpoint(prev);
	const mode = getRecordingMode(settings);
	const manualToggleStop = getManualToggleStop(settings);
	const prevManualToggleStop = getPrevManualToggleStop(prev);
	const isInitial = !prev;

	if (
		silenceTimingNeedsUpdate(
			smartEndpoint,
			prevSmartEndpoint,
			settings.general?.recordingMode,
			prev?.general?.recordingMode,
			isInitial,
			manualToggleStop,
			prevManualToggleStop,
		)
	) {
		deps.sttSetParameter(
			"silence_timing",
			computeSilenceTiming(smartEndpoint, mode, manualToggleStop),
		);
	}
}

/**
 * Push the `silence_endpoint_enabled` flag when the recording mode or the
 * manual-toggle-stop flag changed (or on initial connect).
 *
 * This is the CANONICAL, server-ready-gated push for the flag. The
 * `usePushToTalk` mount effect also pushes it, but that effect fires once at
 * mount and races the WS handshake + recorder-ready gate — on a cold start the
 * server isn't ready yet, so the push is dropped (reference main drops it as
 * "not connected", or the Python control handler drops it as "not pre-ready")
 * and is never retried (its deps are [recordingMode, manualToggleStop], neither
 * of which changes after connect). Without this canonical push the server keeps
 * its default `silence_endpoint_enabled = True`, and PTT recordings auto-stop on
 * silence (VAD silence-end + noise-break) BEFORE the user releases the key — the
 * "pastes early sometimes" bug. `syncToServer` runs on every `shouldSyncOnConnect`
 * (server ready) and on every settings change, so routing the flag through here
 * guarantees the server gets the right value once it can actually accept it.
 */
function maybeSyncSilenceEndpoint(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const mode = getRecordingMode(settings);
	const manualToggleStop = getManualToggleStop(settings);
	const prevManualToggleStop = getPrevManualToggleStop(prev);
	const isInitial = !prev;

	if (
		silenceEndpointNeedsUpdate(
			settings.general?.recordingMode,
			prev?.general?.recordingMode,
			isInitial,
			manualToggleStop,
			prevManualToggleStop,
		)
	) {
		deps.sttSetParameter(
			"silence_endpoint_enabled",
			computeSilenceEndpointEnabled(mode, manualToggleStop),
		);
	}
}

export function syncQualityParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	maybeSyncSilenceTiming(deps, settings, prev);
	maybeSyncSilenceEndpoint(deps, settings, prev);
	syncQualityFields(deps, settings.quality, prev?.quality, !prev);
}

/** Extract the diarization flag from settings, defaulting to false (CC 1). */
export function readDiarizationEnabled(s: AppSettings): boolean {
	return s.general?.speakerDiarization ?? false;
}

/**
 * True when the diarization toggle command should be sent: always on initial
 * connect (so a server started without the diarizer builds it now) or on an
 * actual flip of the persisted value (CC 1 — single boolean expression).
 */
export function diarizationNeedsPush(
	enabled: boolean,
	prev: AppSettings | undefined,
): boolean {
	return !prev || readDiarizationEnabled(prev) !== enabled;
}

export function syncDiarizationParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const enabled = readDiarizationEnabled(settings);
	if (diarizationNeedsPush(enabled, prev)) {
		deps.sttRequestDiarizationToggle(enabled);
	}
}

// NOTE: the Dictionary (custom words) and `general.wordCorrectionThreshold` are NOT
// synced here. They are persisted canonically via `winstt_set_settings` (the
// `settingsSave` debounced write), and the STT pipeline reads them straight from
// `WinsttSettings` at transcription time (`ws.dictionary` /
// `ws.general.word_correction_threshold` in `winstt/stt/backend.rs`). The former
// `update_custom_words` / `change_word_correction_threshold_setting` push was a second
// write path into the AppSettings shadow that nothing read — removed so each setting
// has exactly one writer.

export function syncToServer(
	deps: SyncDeps,
	settings: AppSettings,
	prev?: AppSettings,
): void {
	syncAudioParams(deps, settings, prev);
	syncModelParams(deps, settings, prev);
	syncQualityParams(deps, settings, prev);
	syncDiarizationParams(deps, settings, prev);
}
