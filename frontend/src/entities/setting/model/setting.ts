import type { components } from "@spec/schema";

export type AppSettings = components["schemas"]["AppSettings"];
export type ModelSettings = components["schemas"]["ModelSettings"];
export type QualitySettings = components["schemas"]["QualitySettings"];
export type AudioSettings = components["schemas"]["AudioSettings"];
export type GeneralSettings = components["schemas"]["GeneralSettings"];
export type HotkeySettings = components["schemas"]["HotkeySettings"];
export type DictionaryEntry = components["schemas"]["DictionaryEntry"];
export type SnippetEntry = components["schemas"]["SnippetEntry"];

export const DEFAULT_SETTINGS: Required<AppSettings> = {
	model: {
		model: "large-v2",
		realtimeModel: "tiny",
		language: "en",
		computeType: "default",
		device: "auto",
		beamSize: 5,
		beamSizeRealtime: 3,
		initialPrompt: "",
		initialPromptRealtime: "",
	},
	quality: {
		enableRealtimeTranscription: true,
		useMainModelForRealtime: false,
		realtimeProcessingPause: 0.02,
		initRealtimeAfterSeconds: 0.2,
		earlyTranscriptionOnSilence: 0.2,
		batchSize: 16,
		realtimeBatchSize: 16,
		ensureSentenceStartingUppercase: true,
		ensureSentenceEndsWithPeriod: true,
	},
	audio: {
		inputDeviceIndex: null,
		sampleRate: 16_000,
		bufferSize: 512,
		sileroSensitivity: 0.4,
		sileroUseOnnx: false,
		sileroDeactivityDetection: true,
		webrtcSensitivity: 3,
		postSpeechSilenceDuration: 0.7,
		minLengthOfRecording: 1.1,
		minGapBetweenRecordings: 0,
		preRecordingBufferDuration: 1.0,
	},
	general: {
		autoStart: false,
		minimizeToTray: true,
		startMinimized: false,
		muteSystemAudioWhileDictating: false,
	},
	hotkey: {
		pushToTalkKey: "LCtrl+LMeta",
	},
	dictionary: [],
	snippets: [],
};
