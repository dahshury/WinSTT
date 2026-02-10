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
			recordingSound: true,
			recordingSoundPath: "",
			fileTranscriptionFormat: "txt",
			recordingMode: "ptt",
			loopbackDeviceIndex: null,
		},
		hotkey: {
			pushToTalkKey: "LCtrl+LMeta",
		},
		dictionary: [],
		snippets: [],
		windowBounds: null as { x: number; y: number; width: number; height: number } | null,
	},
});

// ── One-time migration for stale persisted values ────────────────────
// electron-store defaults only apply when a key is missing. If old defaults
// were persisted via settings:save, they override new defaults silently.
const SCHEMA_VERSION = 2;
const currentVersion = (store.get("_schemaVersion") as number | undefined) ?? 1;

if (currentVersion < SCHEMA_VERSION) {
	// v1→v2: enable realtime transcription with separate tiny model
	if (store.get("quality.enableRealtimeTranscription") === false) {
		store.set("quality.enableRealtimeTranscription", true);
	}
	if (store.get("quality.useMainModelForRealtime") === true) {
		store.set("quality.useMainModelForRealtime", false);
	}
	// v1→v2: fix silero sensitivity that was incorrectly defaulting to 0.05
	if (store.get("audio.sileroSensitivity") === 0.05) {
		store.set("audio.sileroSensitivity", 0.4);
	}
	store.set("_schemaVersion", SCHEMA_VERSION);
}
