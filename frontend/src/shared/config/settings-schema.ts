import { z } from "zod";

export const modelSettingsSchema = z.object({
	model: z.string().default("large-v2"),
	realtimeModel: z.string().default("tiny"),
	language: z.string().default("en"),
	computeType: z.string().default("default"),
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
	recordingMode: z.enum(["ptt", "toggle", "listen"]).default("ptt"),
	loopbackDeviceIndex: z.number().int().nullable().default(null),
});

export const hotkeySettingsSchema = z.object({
	pushToTalkKey: z.string().default("LCtrl+LMeta"),
});

export const dictionaryEntrySchema = z.object({
	id: z.string(),
	find: z.string().min(1, "Required"),
	replace: z.string().min(1, "Required"),
	caseSensitive: z.boolean().default(false),
	wholeWord: z.boolean().default(false),
});

export const addDictionaryEntrySchema = z.object({
	find: z.string().min(1, "Required"),
	replace: z.string().min(1, "Required"),
	caseSensitive: z.boolean(),
	wholeWord: z.boolean(),
});
export type AddDictionaryEntry = z.infer<typeof addDictionaryEntrySchema>;

export const snippetEntrySchema = z.object({
	id: z.string(),
	trigger: z.string().min(1, "Required"),
	expansion: z.string().min(1, "Required"),
});

export const addSnippetEntrySchema = snippetEntrySchema.omit({ id: true });
export type AddSnippetEntry = z.infer<typeof addSnippetEntrySchema>;

export const appSettingsSchema = z.object({
	model: modelSettingsSchema.default({}),
	quality: qualitySettingsSchema.default({}),
	audio: audioSettingsSchema.default({}),
	general: generalSettingsSchema.default({}),
	hotkey: hotkeySettingsSchema.default({}),
	dictionary: z.array(dictionaryEntrySchema).default([]),
	snippets: z.array(snippetEntrySchema).default([]),
});

export type AppSettingsInput = z.input<typeof appSettingsSchema>;
export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
