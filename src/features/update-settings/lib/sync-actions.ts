/**
 * Pure (well — IPC-side-effecting) sync actions extracted from
 * use-sync-settings.ts so they can be unit-tested in isolation.
 *
 * The dependencies are passed in as a `Deps` interface rather than imported
 * statically: that lets the tests inject in-memory spies without
 * `mock.module()` polluting the shared bun:test registry.
 */

import type { AllowedParameter } from "@/shared/api/models";
import type {
	AppSettingsOutput as AppSettings,
	DictionaryEntry,
} from "@/shared/config/settings-schema";
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
	/**
	 * Push the server-side custom-word (vocab-biasing) list. Backed by the
	 * `update_custom_words` Tauri command (`commands.updateCustomWords`), which
	 * writes `settings.custom_words`; the recorder reads that field at
	 * transcription time (`apply_custom_words` in `managers/transcription.rs`).
	 * Optional so the existing test harness (and any non-Tauri host) can omit it.
	 */
	updateCustomWords?: (words: string[]) => void;
	/**
	 * Push the deterministic fuzzy-corrector threshold. Backed by the
	 * `change_word_correction_threshold_setting` Tauri command
	 * (`commands.changeWordCorrectionThresholdSetting`), which writes
	 * `settings.word_correction_threshold`.
	 */
	changeWordCorrectionThreshold?: (threshold: number) => void;
}

/**
 * Audio settings are applied through `settingsSave` and backend-owned readers/bridges.
 * Keep this empty until a Rust `winstt_set_parameter` branch actually consumes a key.
 */
export const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {};

/**
 * ``global.modelUnloadTimeout`` enum → server seconds. ``-1`` is the
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

const DEFAULT_MODEL_UNLOAD_SECONDS = 900;

export function resolveModelUnloadTimeoutSeconds(value: unknown): number {
	const raw = typeof value === "string" ? value : "min15";
	return MODEL_UNLOAD_TIMEOUT_SECONDS[raw] ?? DEFAULT_MODEL_UNLOAD_SECONDS;
}

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
	sendIfChanged(
		deps,
		model?.translateToEnglish,
		prevModel?.translateToEnglish,
		"translate_to_english",
		isInitial,
	);
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

/**
 * Translate the enum-valued ``global.modelUnloadTimeout`` setting to the
 * seconds the server CLI expects, then push only on actual changes.
 * Unlike the static-prefix sync above, this one converts the enum to a
 * number before the equality check — the renderer stores the enum, but
 * we want the comparison to operate on the seconds the server actually
 * sees so a no-op enum migration doesn't churn a hot-swap.
 */
export function modelUnloadTimeoutNeedsPush(
	current: unknown,
	previous: unknown,
	isInitial: boolean,
): boolean {
	if (current == null) {
		return false;
	}
	return isInitial || current !== previous;
}

function syncModelUnloadTimeout(
	deps: SyncDeps,
	global: AppSettings["global"] | undefined,
	prevGlobal: AppSettings["global"] | undefined,
	isInitial: boolean,
): void {
	const current = global?.modelUnloadTimeout;
	if (
		!modelUnloadTimeoutNeedsPush(
			current,
			prevGlobal?.modelUnloadTimeout,
			isInitial,
		)
	) {
		return;
	}
	deps.sttSetParameter(
		"model_unload_timeout_seconds",
		resolveModelUnloadTimeoutSeconds(current),
	);
}

function syncGlobalParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const isInitial = !prev;
	syncModelUnloadTimeout(deps, settings.global, prev?.global, isInitial);
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

/**
 * Default fuzzy-corrector threshold. Mirrors the server's
 * ``TextCorrectionConfig`` default (and the renderer schema's
 * ``general.wordCorrectionThreshold`` default) so a settings tree missing the
 * field pushes the same value the matcher would use if it were never sent.
 */
const DEFAULT_WORD_CORRECTION_THRESHOLD = 0.18;

/**
 * Derive the server-side custom-words list from the persisted dictionary.
 *
 * Only entries WITHOUT a ``replacement`` are considered — those are the
 * "vocab-biasing" terms the fuzzy matcher should bias toward. Entries WITH a
 * ``replacement`` are deterministic find-and-replace pairs handled separately
 * by the post-processor; feeding them to the server-side matcher would
 * double-correct them. Mirrors ``readCurrentCustomWords`` in the reference's
 * ``custom-words-sync.ts``. Returns trimmed, de-duplicated terms in insertion
 * order.
 */
function deriveCustomWords(
	dictionary: readonly DictionaryEntry[] | undefined,
): string[] {
	if (!dictionary?.length) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of dictionary) {
		const term = typeof entry.term === "string" ? entry.term.trim() : "";
		const replacement =
			typeof entry.replacement === "string" ? entry.replacement.trim() : "";
		if (!term || replacement || seen.has(term)) {
			continue;
		}
		seen.add(term);
		out.push(term);
	}
	return out;
}

/** Resolve ``general.wordCorrectionThreshold`` to a number, defaulting safely. */
function resolveWordCorrectionThreshold(value: unknown): number {
	return typeof value === "number" ? value : DEFAULT_WORD_CORRECTION_THRESHOLD;
}

/** Order-insensitive value equality for the derived string lists. */
function listsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * Push the Dictionary (custom words) + threshold to the backend so they take
 * effect.
 *
 * Unlike the `set_parameter`-routed knobs above, these settings are NOT
 * `AllowedParameter`s — the Tauri backend persists them into its settings store
 * and reads them straight off disk at transcription time (`apply_custom_words`
 * in `managers/transcription.rs`). So "taking effect" just means writing the
 * value via the dedicated command. Mirrors the reference's
 * `installCustomWordsSync`:
 *
 *   - `dictionary` (entries without `replacement`) → `update_custom_words`
 *   - `general.wordCorrectionThreshold` → `change_word_correction_threshold_setting`
 *
 * Pushed on initial connect (`prev` undefined) and whenever the derived value
 * actually changes — so unrelated settings edits don't churn a disk write. Each
 * dep is optional + guarded; a host that didn't wire it silently skips that push.
 *
 * NOTE: `settings.snippets` is deliberately NOT pushed here. Snippet expansion
 * is a post-transcription text-processing concern (mirrors the reference's
 * `text-processing.ts replaceWithSnippets`), not an STT-engine input — the
 * reference never sends snippets to the recorder, so neither do we.
 */
function syncDictionaryParams(
	deps: SyncDeps,
	settings: AppSettings,
	prev: AppSettings | undefined,
): void {
	const isInitial = !prev;

	const words = deriveCustomWords(settings.dictionary);
	const prevWords = deriveCustomWords(prev?.dictionary);
	if (deps.updateCustomWords && (isInitial || !listsEqual(words, prevWords))) {
		deps.updateCustomWords(words);
	}

	const threshold = resolveWordCorrectionThreshold(
		settings.general?.wordCorrectionThreshold,
	);
	const prevThreshold = resolveWordCorrectionThreshold(
		prev?.general?.wordCorrectionThreshold,
	);
	if (
		deps.changeWordCorrectionThreshold &&
		(isInitial || threshold !== prevThreshold)
	) {
		deps.changeWordCorrectionThreshold(threshold);
	}
}

export function syncToServer(
	deps: SyncDeps,
	settings: AppSettings,
	prev?: AppSettings,
): void {
	syncGlobalParams(deps, settings, prev);
	syncAudioParams(deps, settings, prev);
	syncModelParams(deps, settings, prev);
	syncQualityParams(deps, settings, prev);
	syncDiarizationParams(deps, settings, prev);
	syncDictionaryParams(deps, settings, prev);
}
