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
	autoStartChanged,
	computeSilenceTiming,
	getManualToggleStop,
	getPrevManualToggleStop,
	getPrevSmartEndpoint,
	getRecordingMode,
	getSmartEndpoint,
	shouldSendInitial,
	shouldSendOnChange,
	silenceTimingNeedsUpdate,
} from "./sync-helpers";

/** Side-effect ports injected so tests can spy on them. */
export interface SyncDeps {
	autostartSet: (enabled: boolean) => void;
	sttRequestDiarizationToggle: (enabled: boolean) => void;
	sttSetParameter: <V>(param: AllowedParameter, value: V) => void;
}

/** camelCase → snake_case mapping for audio parameters sent to the STT server */
export const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {
	sileroSensitivity: "silero_sensitivity",
	postSpeechSilenceDuration: "post_speech_silence_duration",
	wakeWordActivationDelay: "wake_word_activation_delay",
	inputDeviceIndex: "input_device_index",
};

/** Whether a parameter must be pushed given the initial/incremental mode. */
export function shouldSendParam<V>(
	value: V | undefined | null,
	prevValue: V | undefined | null,
	isInitial: boolean
): boolean {
	return isInitial ? shouldSendInitial(value) : shouldSendOnChange(value, prevValue);
}

/** Send a parameter only when it changed (incremental) or is non-null (initial). */
export function sendIfChanged<V>(
	deps: SyncDeps,
	value: V | undefined | null,
	prevValue: V | undefined | null,
	param: AllowedParameter,
	isInitial: boolean
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
	isInitial: boolean
): void {
	for (const [camelKey, snakeKey] of Object.entries(AUDIO_PARAM_MAP)) {
		const key = camelKey as keyof typeof audio;
		sendIfChanged(deps, audio[key], prevAudio?.[key], snakeKey, isInitial);
	}
}

export function syncAudioParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	const audio = settings.audio;
	if (!audio) {
		return;
	}
	syncAudioEntries(deps, audio, prev?.audio, !prev);
}

export function syncModelParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	const model = settings.model;
	const prevModel = prev?.model;
	const isInitial = !prev;
	sendIfChanged(deps, model?.language, prevModel?.language, "language", isInitial);
	// Intentionally NOT syncing `model.model` via set_parameter: every model
	// change in the UI goes through `sttReloadModel` (stt:reload-model), which
	// is the canonical swap path. Mirroring it here would fire a second swap
	// — the recorder's `model.setter` spawns its own swap thread — and the two
	// races produce duplicate downloads, duplicate Loading logs, and the
	// download-cancel/revert dance we saw in production.
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
	isInitial: boolean
): void {
	for (const [camelKey, snakeKey] of Object.entries(QUALITY_PARAM_MAP)) {
		const key = camelKey as keyof NonNullable<typeof quality>;
		sendIfChanged(deps, quality?.[key], prevQuality?.[key], snakeKey, isInitial);
	}
}

/** Push the `silence_timing` flag when any input that gates it has changed. */
function maybeSyncSilenceTiming(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
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
			prevManualToggleStop
		)
	) {
		deps.sttSetParameter(
			"silence_timing",
			computeSilenceTiming(smartEndpoint, mode, manualToggleStop)
		);
	}
}

export function syncQualityParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	maybeSyncSilenceTiming(deps, settings, prev);
	syncQualityFields(deps, settings.quality, prev?.quality, !prev);
}

export function syncSystemParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	if (!prev) {
		return;
	}
	if (autoStartChanged(settings, prev)) {
		// At this point `autoStartChanged` has guaranteed the live value is
		// non-null, so the assertion is safe.
		deps.autostartSet(settings.general?.autoStart as boolean);
	}
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
export function diarizationNeedsPush(enabled: boolean, prev: AppSettings | undefined): boolean {
	return !prev || readDiarizationEnabled(prev) !== enabled;
}

export function syncDiarizationParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	const enabled = readDiarizationEnabled(settings);
	if (diarizationNeedsPush(enabled, prev)) {
		deps.sttRequestDiarizationToggle(enabled);
	}
}

/**
 * Sync settings to the STT server (and Electron system settings).
 *
 * - If `prev` is undefined → initial connect: push all non-null settings.
 * - If `prev` is provided → incremental: push only changed keys.
 */
export function syncToServer(deps: SyncDeps, settings: AppSettings, prev?: AppSettings): void {
	syncAudioParams(deps, settings, prev);
	syncModelParams(deps, settings, prev);
	syncQualityParams(deps, settings, prev);
	syncDiarizationParams(deps, settings, prev);
	syncSystemParams(deps, settings, prev);
}
