import Store from "electron-store";

export const store = new Store({
	name: "winstt-settings",
	defaults: {
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
			sileroSensitivity: 0.05,
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
			pushToTalkKey: "Space",
		},
		dictionary: [],
		snippets: [],
	},
});
