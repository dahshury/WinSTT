import { z } from "zod";
import { COMPUTE_TYPES } from "./defaults";

const computeTypeSchema = z.enum(COMPUTE_TYPES);

export const modelSettingsSchema = z.object({
	model: z.string().default("large-v2"),
	realtimeModel: z.string().default("tiny"),
	language: z.string().default("en"),
	computeType: computeTypeSchema.default("default"),
	device: z.enum(["auto", "cpu"]).default("auto"),
	backend: z.enum(["faster_whisper", "onnx_asr"]).default("faster_whisper"),
	onnxQuantization: z.string().default(""),
	beamSize: z.number().int().min(1).default(5),
	beamSizeRealtime: z.number().int().min(1).default(3),
	initialPrompt: z.string().default(""),
	initialPromptRealtime: z.string().default(""),
});

export const qualitySettingsSchema = z.object({
	useMainModelForRealtime: z.boolean().default(false),
	realtimeProcessingPause: z.number().default(0.02),
	initRealtimeAfterSeconds: z.number().default(0.2),
	earlyTranscriptionOnSilence: z.number().default(0.2),
	batchSize: z.number().int().default(16),
	realtimeBatchSize: z.number().int().default(16),
	ensureSentenceStartingUppercase: z.boolean().default(true),
	ensureSentenceEndsWithPeriod: z.boolean().default(true),
	// ON by default: the DistilBERT sentence-completion classifier extends
	// the silence pause when the utterance is semantically incomplete, which
	// is the purpose-built defence against finalizing mid-thought. With it
	// off, the crude punctuation heuristic (unknownSentenceDetectionPause)
	// cut speakers off during natural pauses.
	smartEndpoint: z.boolean().default(true),
	// Pause multiplier: pause = (model + whisper) * smartEndpointSpeed.
	// HIGHER = longer wait = more patient. Default 2.0 matches the
	// RealtimeSTT reference (its binary-classified smart-endpoint example
	// ships 2.0); the old 1.5 committed ~25% sooner everywhere and read
	// as "pastes too eagerly" in toggle dictation.
	smartEndpointSpeed: z.number().min(0.5).max(3.0).default(2.0),
	// Sentence-pause durations driving the toggle-mode silence-timing heuristic
	// (the fallback when Smart Endpoint is off). Defaults match the server's
	// CLI argument defaults. unknownSentenceDetectionPause governs normal
	// mid-sentence speech; 0.7s cut off natural breath/think pauses, so the
	// default is 1.3s.
	endOfSentenceDetectionPause: z.number().min(0.1).max(5.0).default(0.45),
	midSentenceDetectionPause: z.number().min(0.1).max(10.0).default(2.0),
	unknownSentenceDetectionPause: z.number().min(0.1).max(5.0).default(1.3),
});

export const audioSettingsSchema = z.object({
	inputDeviceIndex: z.number().int().nullable().default(null),
	sampleRate: z.number().int().default(16_000),
	bufferSize: z.number().int().default(512),
	sileroSensitivity: z.number().min(0).max(1).default(0.4),
	sileroUseOnnx: z.boolean().default(false),
	sileroDeactivityDetection: z.boolean().default(true),
	webrtcSensitivity: z.number().int().min(0).max(3).default(3),
	postSpeechSilenceDuration: z.number().default(0.7),
	minLengthOfRecording: z.number().default(1.1),
	minGapBetweenRecordings: z.number().default(0),
	preRecordingBufferDuration: z.number().default(1.0),
	// Adaptive-VAD calibration map keyed by input-device name. The server
	// publishes `vad_sensitivity_adapted` after each successful recording
	// with the new Silero value; we store it under the currently-selected
	// device's name and re-apply on subsequent device switches so each mic
	// boots into adaptation with its own last-known sensitivity instead of
	// whatever the previously-active device drifted to. `.catch({})` keeps
	// older builds without this key from wiping the whole audio section.
	sileroSensitivityByDeviceName: z
		.record(z.string(), z.number().min(0).max(1))
		.default({})
		.catch({}),
});

// One entry in the recording-sound library. The default sound is implicit
// (never persisted); every entry here is a user-uploaded clip stored under
// `userData/sounds/`. `path` is the absolute path on disk; `name` is the
// display label (renamable independently of the on-disk filename).
export const soundLibraryEntrySchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	path: z.string().min(1),
});
export type SoundLibraryEntry = z.output<typeof soundLibraryEntrySchema>;

export const generalSettingsSchema = z.object({
	autoStart: z.boolean().default(false),
	minimizeToTray: z.boolean().default(true),
	startMinimized: z.boolean().default(false),
	// Percent reduction applied to system playback volume while dictating.
	// 0 = off (volume untouched), 100 = full mute; intermediate values duck
	// to (100 - value)% of the previous level. The UI constrains this to
	// multiples of 20; `.catch(0)` covers older builds that persisted the
	// legacy boolean (migrated in electron/lib/store.ts).
	systemAudioReductionWhileDictating: z.number().int().min(0).max(100).default(0).catch(0),
	recordingSound: z.boolean().default(true),
	// Active recording sound. Empty string = built-in default. Otherwise the
	// absolute path of an entry in `recordingSoundLibrary`.
	recordingSoundPath: z.string().default(""),
	// User-uploaded clips, copied into `userData/sounds/` by the main process
	// on add so the library survives the user moving/renaming the source file.
	// `.catch([])` keeps older builds (no key) from wiping the whole general
	// section on first read.
	recordingSoundLibrary: z.array(soundLibraryEntrySchema).default([]).catch([]),
	fileTranscriptionFormat: z.enum(["txt", "srt"]).default("txt"),
	fileTranscriptionSaveLocation: z.enum(["auto", "ask"]).default("auto"),
	recordingMode: z.enum(["ptt", "toggle", "listen", "wakeword"]).default("ptt"),
	// True manual toggle: in `toggle` mode, recording runs continuously from
	// first hotkey press to second press — silence-VAD stop and silence-timing
	// punctuation tuning are both disabled. Ignored in other modes. Off by
	// default so the documented "stops on silence, restarts on speech"
	// behaviour stays the baseline for users who haven't opted in.
	manualToggleStop: z.boolean().default(false),
	// Global shortcut that re-pastes the most recent dictation transcription
	// into the focused window on demand. Registered as an EXCLUSIVE system-
	// wide shortcut (Electron globalShortcut) — it is swallowed app-wide so
	// pressing it ONLY triggers our re-paste and never also fires the focused
	// app's native binding (e.g. paste-without-formatting). Stored in the same
	// uiohook-style accelerator format the HotkeyRecorder produces; the main
	// process converts it to an Electron accelerator at registration time.
	// Empty string = feature disabled (shortcut not registered).
	repasteHotkey: z.string().default("LCtrl+LShift+V"),
	loopbackDeviceIndex: z.number().int().nullable().default(null),
	// Wake word used when recordingMode is "wakeword". The renderer auto-
	// selects the right detector backend from this value alone (see
	// `wakeWordBackendFor` in electron/ipc/stt-process.ts): keywords supported
	// by both engines run as a composite that requires cross-engine agreement;
	// engine-specific keywords run on the single engine that knows them.
	// Defaults to "alexa" so a first switch into wakeword mode boots the
	// highest-accuracy composite detector without further configuration.
	wakeWord: z.string().default("alexa"),
	// Detection sensitivity passed to both Porcupine and openWakeWord. Lower
	// = stricter (fewer false positives, may miss soft pronunciations);
	// higher = more permissive. 0.6 is the monolith default and a sensible
	// compromise for most voices.
	wakeWordSensitivity: z.number().min(0).max(1).default(0.6),
	// Seconds the wake-word gate stays armed after a detection before
	// auto-clearing. If the user says the wake word but doesn't follow up
	// within this window, the engine returns to listening for the trigger
	// again — protects against accidental long-tail recordings triggered by
	// stray noise minutes after the user actually said the wake word.
	wakeWordTimeout: z.number().min(1).max(30).default(5),
	showRecordingOverlay: z.boolean().default(true),
	// Layout of the recording overlay.
	// `floating-bottom` keeps the historical two-piece pill near the bottom
	// of the primary display; `dynamic-island` docks a morphing capsule flush
	// against the top-center of the primary display, switching size presets
	// in OverlayPage as content changes. `.catch` keeps an older persisted
	// value (or a missing key on first read after upgrade) from wiping the
	// whole `general` section.
	overlayMode: z
		.enum(["floating-bottom", "dynamic-island"])
		.default("floating-bottom")
		.catch("floating-bottom"),
	// `.catch` covers older builds that persisted an integer pixel value;
	// without it an integer here fails the whole settings parse and the codec
	// falls back to ALL defaults, wiping unrelated settings on upgrade.
	visualizerSize: z.enum(["xs", "sm", "md", "lg", "xl"]).default("xs").catch("xs"),
	// Single multi-choice replaces the old `showLiveTranscription` (pill) and
	// `showInAppLiveTranscription` (main window) booleans. `.catch` keeps an
	// older persisted value from wiping the whole `general` section on upgrade.
	liveTranscriptionDisplay: z
		.enum(["none", "in-app", "in-pill", "both"])
		.default("both")
		.catch("both"),
	visualizerType: z.enum(["bar", "grid", "radial", "wave", "aura"]).default("bar"),
	// `.catch(9)` covers stale persisted values from an earlier slider bug that
	// emitted 22 (off the zero-anchored snap grid). Without it, a single
	// out-of-range integer fails the whole `general` parse in
	// `decodeSettingsPayload`, and other windows fall back to ALL defaults —
	// which then broadcasts back and silently resets unrelated settings.
	visualizerBarCount: z.number().int().min(3).max(21).default(9).catch(9),
	contextAwareness: z.boolean().default(false),
	/**
	 * User-managed deny-list for context capture. Each entry is either
	 * an executable basename (`"1password.exe"`) or a URL host suffix
	 * (`"bankofamerica.com"` — any subdomain matches). When the active
	 * app or URL matches an entry, the captured snapshot is stripped of
	 * focused-text / axHtml / URL fields before reaching the LLM. The
	 * window title still flows through as harmless metadata. Seed list
	 * covers common password managers — anyone hitting "remove" in the
	 * UI gets that change persisted; the seed only applies on first run.
	 */
	contextDenyList: z
		.array(z.string())
		.default([
			"1password.exe",
			"bitwarden.exe",
			"keepass.exe",
			"keepassxc.exe",
			"dashlane.exe",
			"lastpass.exe",
		])
		.catch([
			"1password.exe",
			"bitwarden.exe",
			"keepass.exe",
			"keepassxc.exe",
			"dashlane.exe",
			"lastpass.exe",
		]),
	// Speaker diarization — per-utterance, with session-wide identity tracking.
	// Toggle-mode only in the UI (long-form dictation is where multi-speaker
	// conversations actually happen); the server still runs the same pipeline
	// regardless of recording mode. First-run downloads ~32 MB of ONNX models.
	speakerDiarization: z.boolean().default(false),
	// Opt-out toggle for Sentry crash/error reporting. Defaults to `true` —
	// installers ship with reporting on so we collect the early-adopter crash
	// data we can't reproduce locally. Restart required on toggle: Sentry's
	// `init()` can't be cleanly reversed at runtime, so the renderer + main
	// SDKs both read this flag once at startup.
	sendCrashReports: z.boolean().default(true),
	// First-run onboarding gate. `false` triggers the onboarding wizard window
	// (one-time wizard that picks local vs cloud STT, tests the mic, optionally
	// collects cloud keys, and offers Ollama setup). `.catch(false)` means a
	// corrupt persisted value re-shows the wizard rather than skipping it —
	// re-running setup is cheap; silently skipping a broken first install isn't.
	onboarded: z.boolean().default(false).catch(false),
	// Epoch-ms when the user finished (or skipped) the wizard. Null until then.
	// Used for telemetry / debugging only — the gate keys off `onboarded`.
	onboardedAt: z.number().nullable().default(null).catch(null),
	// Which STT track the wizard picked: local Whisper or a cloud provider.
	// Empty until the wizard runs; settings UI doesn't read it directly (it
	// reads the active model from `model.model`), but the wizard persists it
	// so we can answer "did this user start on cloud?" in support tickets.
	onboardedTrack: z.enum(["", "local", "cloud"]).default("").catch(""),
});

export const hotkeySettingsSchema = z.object({
	pushToTalkKey: z.string().min(1).default("LCtrl+LMeta"),
});

// Dictionary entries are dual-purpose, matching Wispr Flow's two-mode model:
//
//  - VOCAB words (`replacement` absent) — names, jargon, proper nouns the
//    model should bias TOWARD. Folded into the LLM system prompt via
//    withVocabPrefix and (when LLM is off) fuzzy-matched by the algorithmic
//    post-processor in text-processing.ts.
//
//  - REPLACEMENT PAIRS (`replacement` present) — `term` is a common
//    mis-transcription that should always become `replacement`. Applied as a
//    case-insensitive whole-word string replace AFTER the LLM cleanup pass,
//    so the rule fires deterministically regardless of what the model did.
//    The LLM is also told about the pair in its prompt so it can apply the
//    correction with context awareness; the post-pass is the safety net.
export const dictionaryEntrySchema = z.object({
	id: z.string().min(1),
	term: z.string().min(1, "Required"),
	replacement: z.string().optional(),
});
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;

export const addDictionaryEntrySchema = z.object({
	term: z.string().trim().min(1, "Required"),
	replacement: z.string().trim().optional(),
});
export type AddDictionaryEntry = z.infer<typeof addDictionaryEntrySchema>;

export const snippetEntrySchema = z.object({
	id: z.string().min(1),
	trigger: z.string().min(1, "Required"),
	expansion: z.string().min(1, "Required"),
});

export const addSnippetEntrySchema = z.object({
	trigger: z.string().trim().min(1, "Required"),
	expansion: z.string().trim().min(1, "Required"),
});
export type AddSnippetEntry = z.infer<typeof addSnippetEntrySchema>;

export const presetKeySchema = z.enum([
	"neutral",
	"formal",
	"friendly",
	"technical",
	"casual",
	"concise",
	"summarize",
	"reorder",
	"restructure",
	"rewordForClarity",
	"translate",
]);

export const presetLevelSchema = z.enum(["light", "medium", "high"]);

const KEYS_WITH_LEVELS = new Set(["summarize", "concise"]);
const TONE_KEYS = new Set(["neutral", "formal", "friendly", "technical", "casual"]);

export const presetEntrySchema = z
	.object({
		key: presetKeySchema,
		level: presetLevelSchema.optional(),
		// English name of the target language; only meaningful for `translate`.
		// Mirrors how `level` parameterizes summarize/concise.
		targetLang: z.string().optional(),
	})
	.refine((entry) => entry.level === undefined || KEYS_WITH_LEVELS.has(entry.key), {
		message: "level is only allowed for summarize or concise",
		path: ["level"],
	})
	.refine((entry) => entry.targetLang === undefined || entry.key === "translate", {
		message: "targetLang is only allowed for the translate preset",
		path: ["targetLang"],
	});

export const presetsSchema = z
	.array(presetEntrySchema)
	.default([{ key: "neutral" }])
	.refine(
		(entries) => {
			const seen = new Set<string>();
			for (const entry of entries) {
				if (seen.has(entry.key)) {
					return false;
				}
				seen.add(entry.key);
			}
			return true;
		},
		{ message: "duplicate preset keys are not allowed" }
	)
	.refine(
		(entries) => {
			const toneCount = entries.filter((e) => TONE_KEYS.has(e.key)).length;
			return toneCount <= 1;
		},
		{ message: "only one tone preset (neutral/formal/friendly/technical/casual) may be active" }
	);

// User-authored cleanup modifiers layered on top of the built-in tone /
// independent presets. Unlike `presetsSchema` (which holds only *active*
// built-in keys), this array persists the full definition even while
// `enabled` is false so the name/prompt the user wrote survives a toggle.
// `level` is always allowed here — for a custom modifier the Low/Medium/High
// switcher tunes intensity of the single authored prompt rather than
// selecting between distinct texts (see `CUSTOM_LEVEL_HINT`).
export const customModifierSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	prompt: z.string().default(""),
	enabled: z.boolean().default(false),
	// When false the prompt is applied verbatim; when true the Low/Medium/High
	// switcher appears on the row and `level` tunes the intensity hint.
	levelsEnabled: z.boolean().default(false),
	level: presetLevelSchema.optional(),
});

// Per-feature provider config. Dictation and transforms each pick their own
// provider (Ollama or OpenRouter) and own model selection independently — so
// e.g. dictation can run a fast local Ollama while transforms hits an
// OpenRouter frontier model. Infra-level fields (Ollama endpoint URL,
// OpenRouter API key) stay shared on `llmSettingsSchema` — one Ollama
// instance, one OpenRouter account.
const llmFeatureBaseShape = {
	provider: z.enum(["ollama", "openrouter"]).default("ollama"),
	model: z.string().default(""),
	openrouterModel: z.string().default(""),
	openrouterFallbackModel: z.string().default(""),
	// OpenRouter request-tuning parameters. Only sent on the wire when the
	// selected model's `supported_parameters` advertises support, but the
	// defaults persist so the picker's ReasoningControls renders consistent
	// initial values regardless of the previously-selected model.
	reasoningEffort: z.enum(["low", "medium", "high"]).default("medium"),
	verbosity: z.enum(["low", "medium", "high"]).default("medium"),
	maxOutputTokens: z.number().int().min(1).nullable().default(null),
	// Thinking budget for Ollama models that advertise the `thinking`
	// capability via `/api/show`. Mirrors Ollama's `ThinkValue`:
	//   - `"off"` → `think: false` (force-disable for thinking models)
	//   - `"low" | "medium" | "high"` → passed verbatim as the request field
	// Non-thinking models always send `think: false` regardless of this
	// setting; the chat-body builder gates on the capability check.
	thinkingEffort: z.enum(["off", "low", "medium", "high"]).default("medium"),
};

export const llmDictationSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	presets: presetsSchema,
	// Empty by default; rows are appended from the Modifiers UI. Folded into
	// the runtime presets array at processing time via
	// `mergePresetsWithCustomModifiers` — never persisted into `presets`.
	customModifiers: z.array(customModifierSchema).default([]),
});

// Single user-configurable text transform. Mirrors the OpenAPI `Transform`
// schema (see `spec/openapi.yaml`). Built-in entries flag `builtin: true`
// so the UI can show a Reset action instead of Delete.
export const transformSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	prompt: z.string().default(""),
	hotkey: z.string().default(""),
	builtin: z.boolean().default(false),
});
export type TransformEntry = z.infer<typeof transformSchema>;

// Built-in transforms seeded into `settings.llm.transforms.prompts` on first
// run. Currently empty — the catalog will be filled out as the Transforms
// feature lands more presets. Exported so the renderer can offer a Reset
// action that restores a built-in's prompt without wiping user-authored
// entries.
export const BUILTIN_TRANSFORMS: readonly TransformEntry[] = [];

export const llmTransformsSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	// Same composition shape as dictation: ordered preset list + custom modifiers.
	// At runtime, mergePresetsWithCustomModifiers folds them into a single prompt
	// applied to the currently-selected text.
	presets: presetsSchema,
	customModifiers: z.array(customModifierSchema).default([]),
	// uiohook-style accelerator (e.g. "LCtrl+LShift+T") that captures the
	// active selection and runs the composed transform. Empty disables the
	// global hotkey; the transform can still be invoked from the UI.
	hotkey: z.string().default(""),
	// User-configurable text transforms. Each entry carries its own prompt
	// and optional hotkey. Built-in entries (see `BUILTIN_TRANSFORMS`) carry
	// `builtin: true` so the UI can show a Reset action instead of Delete.
	prompts: z.array(transformSchema).default([]),
});

export const llmSettingsSchema = z.object({
	// Shared infrastructure (one Ollama instance, one OpenRouter account).
	endpoint: z.string().url().default("http://localhost:11434"),
	openrouterApiKey: z.string().default(""),
	// Per-feature config — each independently picks provider + model.
	// The feature runs iff its own `enabled` is true AND a model is configured;
	// there is no master switch (the IPC layer treats "no model" as off).
	dictation: llmDictationSchema.prefault({}),
	transforms: llmTransformsSchema.prefault({}),
	// Client-side request timeout (ms). Wired through but currently NOT applied
	// at the network layer — local LLMs (Ollama cold start) routinely exceed any
	// finite cap, and a silent abort + un-processed-text paste is misleading.
	// Kept here so the persisted setting / IPC plumbing / tests stay stable.
	timeout: z.number().int().min(1000).max(30_000).default(5000),
});

// Per-provider integration record. `apiKey` is encrypted at rest via
// Electron `safeStorage` (DPAPI on Windows) — the wire/in-memory shape
// is plaintext but the persisted JSON contains `enc:v1:<base64>`; the
// secret-storage layer transparently encrypts on save and decrypts on
// read (see `electron/lib/secret-storage.ts`). `verified` is the result
// of the last successful probe (null = never probed); `lastVerifiedAt`
// is epoch-ms. Matches the existing `llm.openrouterApiKey` pattern so
// the UI can use `PasswordField` directly against the store value.
export const providerIntegrationStatusSchema = z.object({
	apiKey: z.string().default(""),
	verified: z.boolean().nullable().default(null),
	lastVerifiedAt: z.number().nullable().default(null),
});

export const integrationsSchema = z.object({
	openai: providerIntegrationStatusSchema.prefault({}),
	elevenlabs: providerIntegrationStatusSchema.prefault({}),
});

// Kokoro-82M ONNX text-to-speech. Opt-in feature — `enabled` defaults to
// false; the engine only loads on first synthesis request. `voice` and
// `lang` mirror the Kokoro voice catalog (see
// ``server/src/synthesizer/infrastructure/voice_catalog.py``); `speed` is
// a multiplier clamped 0.5..2.0. `hotkey` is the global combo that
// captures the active selection and reads it aloud; empty = bound from
// the in-app UI only. `device` mirrors the STT side's "auto / cuda / cpu".
export const ttsSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	voice: z.string().default("af_heart"),
	lang: z.string().default("en-us"),
	speed: z.number().min(0.5).max(2.0).default(1.0),
	hotkey: z.string().default(""),
	device: z.enum(["auto", "cuda", "cpu"]).default("auto"),
});

export const appSettingsSchema = z.object({
	model: modelSettingsSchema.prefault({}),
	quality: qualitySettingsSchema.prefault({}),
	audio: audioSettingsSchema.prefault({}),
	general: generalSettingsSchema.prefault({}),
	hotkey: hotkeySettingsSchema.prefault({}),
	// `.catch([])` is the migration safety net: any persisted entry from the
	// pre-v10 shape (find/replace/caseSensitive/wholeWord) will fail the new
	// `term`-only parser and bring the whole array with it. The catch maps
	// the failure to an empty array, matching the agreed-upon wipe semantics.
	dictionary: z.array(dictionaryEntrySchema).default([]).catch([]),
	snippets: z.array(snippetEntrySchema).default([]),
	llm: llmSettingsSchema.prefault({}),
	tts: ttsSettingsSchema.prefault({}),
	integrations: integrationsSchema.prefault({}),
});

export type AppSettingsInput = z.input<typeof appSettingsSchema>;
export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
