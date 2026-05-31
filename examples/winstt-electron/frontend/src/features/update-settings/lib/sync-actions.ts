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
	// Hot-swappable via WebRTCVAD.set_sensitivity on the server (used to
	// force a full server restart through STARTUP_ONLY_KEYS).
	webrtcSensitivity: "webrtc_sensitivity",
	// Config-only on the server today (no runtime consumer); pushed so
	// the persisted value follows the renderer without needing a kill.
	sileroDeactivityDetection: "silero_deactivity_detection",
};

/**
 * Consolidated mic-release picker → three PyAudioSource knobs.
 *
 * The renderer stores a single ``audio.microphoneRelease`` enum (so the
 * settings UI is one picker, not a checkbox + dependent dropdown), but
 * the server's PyAudioSource takes them as three independent booleans/
 * floats. We push all three on every change so the server-side state
 * machine stays coherent regardless of which transition we picked:
 *
 *   "always"    → always_on=true,  lazy=false, timeout=0
 *   "immediate" → always_on=false, lazy=false, timeout=0
 *   "sec30"     → always_on=false, lazy=true,  timeout=30
 *   "min1"      → always_on=false, lazy=true,  timeout=60
 *   "min5"      → always_on=false, lazy=true,  timeout=300
 *
 * Unknown / corrupt values fall through to "immediate" (matches the
 * schema's `.catch("immediate")` normalization).
 */
interface MicReleasePolicy {
	alwaysOn: boolean;
	lazyClose: boolean;
	timeoutSeconds: number;
}

const IMMEDIATE_POLICY: MicReleasePolicy = {
	alwaysOn: false,
	lazyClose: false,
	timeoutSeconds: 0,
};

const MIC_RELEASE_POLICIES: Record<string, MicReleasePolicy> = {
	always: { alwaysOn: true, lazyClose: false, timeoutSeconds: 0 },
	immediate: IMMEDIATE_POLICY,
	sec30: { alwaysOn: false, lazyClose: true, timeoutSeconds: 30 },
	min1: { alwaysOn: false, lazyClose: true, timeoutSeconds: 60 },
	min5: { alwaysOn: false, lazyClose: true, timeoutSeconds: 300 },
};

export function resolveMicReleasePolicy(value: unknown): MicReleasePolicy {
	const key = typeof value === "string" ? value : "immediate";
	return MIC_RELEASE_POLICIES[key] ?? IMMEDIATE_POLICY;
}

/**
 * ``model.modelUnloadTimeout`` enum → server seconds. ``-1`` is the
 * "never unload" sentinel (server normalises to None internally).
 * Mirrors the table in ``electron/ipc/stt-process.ts`` so the CLI-arg
 * boot and the runtime hot-swap pick the same value for the same enum.
 */
const MODEL_UNLOAD_TIMEOUT_SECONDS: Record<string, number> = {
	immediately: 0,
	never: -1,
	min2: 120,
	min5: 300,
	min10: 600,
	min15: 900,
	hour1: 3600,
};

const DEFAULT_MODEL_UNLOAD_SECONDS = 300;

export function resolveModelUnloadTimeoutSeconds(value: unknown): number {
	const raw = typeof value === "string" ? value : "min5";
	return MODEL_UNLOAD_TIMEOUT_SECONDS[raw] ?? DEFAULT_MODEL_UNLOAD_SECONDS;
}

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
	const isInitial = !prev;
	syncAudioEntries(deps, audio, prev?.audio, isInitial);
	syncMicrophoneRelease(deps, audio, prev?.audio, isInitial);
}

/**
 * Push the three PyAudioSource mic-release knobs whenever the
 * consolidated picker value changes (or on initial connect). All three
 * are pushed atomically so a server that only got two of the three
 * updates can't sit in a half-applied state.
 */
export function micReleaseNeedsPush(
	current: unknown,
	previous: unknown,
	isInitial: boolean
): boolean {
	if (current == null) {
		return false;
	}
	return isInitial || current !== previous;
}

function syncMicrophoneRelease(
	deps: SyncDeps,
	audio: NonNullable<AppSettings["audio"]>,
	prevAudio: AppSettings["audio"] | undefined,
	isInitial: boolean
): void {
	const current = audio.microphoneRelease;
	if (!micReleaseNeedsPush(current, prevAudio?.microphoneRelease, isInitial)) {
		return;
	}
	const policy = resolveMicReleasePolicy(current);
	deps.sttSetParameter("always_on_microphone", policy.alwaysOn);
	deps.sttSetParameter("lazy_stream_close", policy.lazyClose);
	deps.sttSetParameter("lazy_close_timeout_seconds", policy.timeoutSeconds);
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
		isInitial
	);
	sendIfChanged(
		deps,
		model?.translateToEnglish,
		prevModel?.translateToEnglish,
		"translate_to_english",
		isInitial
	);
	syncInitialPromptStatics(deps, model, prevModel, isInitial);
	syncModelUnloadTimeout(deps, model, prevModel, isInitial);
}

/**
 * Push the static (non-context, non-dictionary) initial prompt prefixes
 * to the server. The composed prompt that includes the dictionary +
 * volatile context tail is pushed separately by Electron's
 * ``installInitialPromptSync`` whenever those upstream inputs change;
 * this handler only fires on edits to the user-typed static prefix in
 * the Settings UI. Both produce ``set_parameter("initial_prompt", ...)``
 * frames the server's facade treats identically.
 */
function syncInitialPromptStatics(
	deps: SyncDeps,
	model: AppSettings["model"] | undefined,
	prevModel: AppSettings["model"] | undefined,
	isInitial: boolean
): void {
	sendIfChanged(deps, model?.initialPrompt, prevModel?.initialPrompt, "initial_prompt", isInitial);
	sendIfChanged(
		deps,
		model?.initialPromptRealtime,
		prevModel?.initialPromptRealtime,
		"initial_prompt_realtime",
		isInitial
	);
}

/**
 * Translate the enum-valued ``model.modelUnloadTimeout`` setting to the
 * seconds the server CLI expects, then push only on actual changes.
 * Unlike the static-prefix sync above, this one converts the enum to a
 * number before the equality check — the renderer stores the enum, but
 * we want the comparison to operate on the seconds the server actually
 * sees so a no-op enum migration doesn't churn a hot-swap.
 */
export function modelUnloadTimeoutNeedsPush(
	current: unknown,
	previous: unknown,
	isInitial: boolean
): boolean {
	if (current == null) {
		return false;
	}
	return isInitial || current !== previous;
}

function syncModelUnloadTimeout(
	deps: SyncDeps,
	model: AppSettings["model"] | undefined,
	prevModel: AppSettings["model"] | undefined,
	isInitial: boolean
): void {
	const current = model?.modelUnloadTimeout;
	if (!modelUnloadTimeoutNeedsPush(current, prevModel?.modelUnloadTimeout, isInitial)) {
		return;
	}
	deps.sttSetParameter("model_unload_timeout_seconds", resolveModelUnloadTimeoutSeconds(current));
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

/**
 * Push the `silence_endpoint_enabled` flag when the recording mode or the
 * manual-toggle-stop flag changed (or on initial connect).
 *
 * This is the CANONICAL, server-ready-gated push for the flag. The
 * `usePushToTalk` mount effect also pushes it, but that effect fires once at
 * mount and races the WS handshake + recorder-ready gate — on a cold start the
 * server isn't ready yet, so the push is dropped (electron-main drops it as
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
	prev: AppSettings | undefined
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
			prevManualToggleStop
		)
	) {
		deps.sttSetParameter(
			"silence_endpoint_enabled",
			computeSilenceEndpointEnabled(mode, manualToggleStop)
		);
	}
}

export function syncQualityParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	maybeSyncSilenceTiming(deps, settings, prev);
	maybeSyncSilenceEndpoint(deps, settings, prev);
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
/**
 * Push deterministic text-correction toggles that live under `general.*` but
 * are consumed by the recorder's post-decode pipeline.
 *
 * `filter_fillers` is routed HERE (renderer → sttSetParameter, reading the live
 * settings store) rather than through electron-main's `custom-words-sync`. That
 * path reads the persisted electron-store and was delivering a STALE value in
 * the long-running main process (it pushed `filter_fillers=true` while disk
 * held `false`), so toggling "Remove Filler Words" never reached the recorder.
 * The renderer always holds the value the user just toggled, and this fires on
 * every change AND on connect (`shouldSyncOnConnect`), so the recorder gets the
 * right value with no restart.
 */
export function syncTextCorrectionParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined
): void {
	const general = settings.general;
	if (!general) {
		return;
	}
	sendIfChanged(deps, general.filterFillers, prev?.general?.filterFillers, "filter_fillers", !prev);
}

export function syncToServer(deps: SyncDeps, settings: AppSettings, prev?: AppSettings): void {
	syncAudioParams(deps, settings, prev);
	syncModelParams(deps, settings, prev);
	syncQualityParams(deps, settings, prev);
	syncDiarizationParams(deps, settings, prev);
	syncSystemParams(deps, settings, prev);
	syncTextCorrectionParams(deps, settings, prev);
}
