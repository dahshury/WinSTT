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
});

export const generalSettingsSchema = z.object({
	autoStart: z.boolean().default(false),
	minimizeToTray: z.boolean().default(true),
	startMinimized: z.boolean().default(false),
	muteSystemAudioWhileDictating: z.boolean().default(false),
	recordingSound: z.boolean().default(true),
	recordingSoundPath: z.string().default(""),
	fileTranscriptionFormat: z.enum(["txt", "srt"]).default("txt"),
	fileTranscriptionSaveLocation: z.enum(["auto", "ask"]).default("auto"),
	recordingMode: z.enum(["ptt", "toggle", "listen"]).default("ptt"),
	loopbackDeviceIndex: z.number().int().nullable().default(null),
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
	visualizerColor: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.default("#58a6ff"),
	contextAwareness: z.boolean().default(false),
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
export const BUILTIN_TRANSFORMS: readonly z.input<typeof transformSchema>[] = [
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

export const llmSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	provider: z.enum(["ollama", "openrouter"]).default("ollama"),
	endpoint: z.string().url().default("http://localhost:11434"),
	model: z.string().default(""),
	openrouterApiKey: z.string().default(""),
	openrouterModel: z.string().default(""),
	openrouterFallbackModel: z.string().default(""),
	presets: presetsSchema,
	timeout: z.number().int().min(1000).max(30_000).default(5000),
	transforms: z.array(transformSchema).default(() =>
		BUILTIN_TRANSFORMS.map((t) => ({
			id: t.id,
			name: t.name,
			prompt: t.prompt ?? "",
			hotkey: t.hotkey ?? "",
			builtin: t.builtin ?? false,
		}))
	),
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
