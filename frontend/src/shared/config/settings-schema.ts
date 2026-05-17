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
	enableRealtimeTranscription: z.boolean().default(true),
	useMainModelForRealtime: z.boolean().default(false),
	realtimeProcessingPause: z.number().default(0.02),
	initRealtimeAfterSeconds: z.number().default(0.2),
	earlyTranscriptionOnSilence: z.number().default(0.2),
	batchSize: z.number().int().default(16),
	realtimeBatchSize: z.number().int().default(16),
	ensureSentenceStartingUppercase: z.boolean().default(true),
	ensureSentenceEndsWithPeriod: z.boolean().default(true),
	smartEndpoint: z.boolean().default(false),
	smartEndpointSpeed: z.number().min(0.5).max(3.0).default(1.5),
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
	recordingSoundPath: z.string().default(""),
	fileTranscriptionFormat: z.enum(["txt", "srt"]).default("txt"),
	fileTranscriptionSaveLocation: z.enum(["auto", "ask"]).default("auto"),
	recordingMode: z.enum(["ptt", "toggle", "listen", "wakeword"]).default("ptt"),
	loopbackDeviceIndex: z.number().int().nullable().default(null),
	// Wake word used when recordingMode is "wakeword". Only Porcupine's
	// free built-in keywords work without an access key, so the UI
	// constrains the picker to that list. Empty when no word selected.
	wakeWord: z.string().default(""),
	showRecordingOverlay: z.boolean().default(true),
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
	visualizerBarCount: z.number().int().min(3).max(21).default(9),
	contextAwareness: z.boolean().default(false),
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
});

export const hotkeySettingsSchema = z.object({
	pushToTalkKey: z.string().min(1).default("LCtrl+LMeta"),
});

export const dictionaryEntrySchema = z.object({
	id: z.string().min(1),
	find: z.string().min(1, "Required"),
	replace: z.string().min(1, "Required"),
	caseSensitive: z.boolean().default(false),
	wholeWord: z.boolean().default(false),
});

export const addDictionaryEntrySchema = z.object({
	find: z.string().trim().min(1, "Required"),
	replace: z.string().trim().min(1, "Required"),
	caseSensitive: z.boolean(),
	wholeWord: z.boolean(),
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
]);

export const presetLevelSchema = z.enum(["light", "medium", "high"]);

const KEYS_WITH_LEVELS = new Set(["summarize", "concise"]);
const TONE_KEYS = new Set(["neutral", "formal", "friendly", "technical", "casual"]);

export const presetEntrySchema = z
	.object({
		key: presetKeySchema,
		level: presetLevelSchema.optional(),
	})
	.refine((entry) => entry.level === undefined || KEYS_WITH_LEVELS.has(entry.key), {
		message: "level is only allowed for summarize or concise",
		path: ["level"],
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

export const transformSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	prompt: z.string().default(""),
	hotkey: z.string().default(""),
	builtin: z.boolean().default(false),
});

// Built-in transforms seeded on first run. Kept terse and instructive — the
// model is told to return ONLY the transformed text so the paste-replace flow
// doesn't accidentally inject commentary.
export const BUILTIN_TRANSFORMS: readonly z.output<typeof transformSchema>[] = [
	{
		id: "polish",
		name: "Polish",
		prompt:
			"You are polishing the user's selected text. Fix grammar, punctuation, capitalization, and any awkward phrasing. Preserve the user's voice and intent — do not add new content, do not summarize, do not rewrite for a different audience. Return ONLY the polished text with no commentary, no quotation marks, and no markdown fences.",
		hotkey: "",
		builtin: true,
	},
	{
		id: "prompt-engineer",
		name: "Prompt Engineer",
		prompt:
			"You are rewriting the user's selected text as a clear, well-structured prompt for an LLM. Make the role explicit, state the task plainly, list constraints as a short bulleted block when relevant, and specify the desired output format. Keep the user's intent. Return ONLY the rewritten prompt with no commentary, no quotation marks, and no markdown fences.",
		hotkey: "",
		builtin: true,
	},
];

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
};

export const llmDictationSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	presets: presetsSchema,
});

export const llmTransformsSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	// User-authored custom prompts triggered by hotkey / UI. The array is
	// seeded with BUILTIN_TRANSFORMS on first run; transformSchema's own
	// per-field defaults fill in any partial entries persisted in older builds.
	prompts: z.array(transformSchema).default([...BUILTIN_TRANSFORMS]),
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

export const appSettingsSchema = z.object({
	model: modelSettingsSchema.prefault({}),
	quality: qualitySettingsSchema.prefault({}),
	audio: audioSettingsSchema.prefault({}),
	general: generalSettingsSchema.prefault({}),
	hotkey: hotkeySettingsSchema.prefault({}),
	dictionary: z.array(dictionaryEntrySchema).default([]),
	snippets: z.array(snippetEntrySchema).default([]),
	llm: llmSettingsSchema.prefault({}),
});

export type AppSettingsInput = z.input<typeof appSettingsSchema>;
export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
