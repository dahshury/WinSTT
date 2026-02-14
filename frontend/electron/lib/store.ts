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
			backend: "faster_whisper",
			onnxQuantization: "",
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
			smartEndpoint: false,
			smartEndpointSpeed: 1.5,
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
		llm: {
			enabled: false,
			endpoint: "http://localhost:11434",
			model: "",
			preset: "neutral" as const,
			timeout: 5000,
		},
		windowBounds: null as { x: number; y: number; width: number; height: number } | null,
	},
});

// ── One-time migration for stale persisted values ────────────────────
// electron-store defaults only apply when a key is missing. If old defaults
// were persisted via settings:save, they override new defaults silently.
const SCHEMA_VERSION = 3;
const currentVersion = (store.get("_schemaVersion") as number | undefined) ?? 1;

if (currentVersion < SCHEMA_VERSION) {
	// Ensure realtime transcription is enabled with separate tiny model.
	// Use !value to catch both `false` and `undefined` (missing key in persisted JSON).
	if (!store.get("quality.enableRealtimeTranscription")) {
		store.set("quality.enableRealtimeTranscription", true);
	}
	if (store.get("quality.useMainModelForRealtime") !== false) {
		store.set("quality.useMainModelForRealtime", false);
	}
	// Fix silero sensitivity that was incorrectly defaulting to 0.05
	const silero = store.get("audio.sileroSensitivity") as number | undefined;
	if (silero == null || silero === 0.05) {
		store.set("audio.sileroSensitivity", 0.4);
	}
	console.log("[store] Migration applied: _schemaVersion", currentVersion, "→", SCHEMA_VERSION);
	store.set("_schemaVersion", SCHEMA_VERSION);
}
