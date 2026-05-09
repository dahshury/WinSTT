import Store from "electron-store";
import { z } from "zod";

// ── Zod schemas for individual store values (dot-path access) ────────
// These validate the raw `unknown` return of store.get("section.key").
const storeValueSchemas = {
	// general
	"general.recordingMode": z.enum(["ptt", "toggle", "listen"]).catch("ptt"),
	"general.minimizeToTray": z.boolean().catch(true),
	"general.startMinimized": z.boolean().catch(false),
	"general.recordingSound": z.boolean().catch(true),
	"general.recordingSoundPath": z.string().catch(""),
	"general.fileTranscriptionFormat": z.enum(["txt", "srt"]).catch("txt"),
	"general.showRecordingOverlay": z.boolean().catch(true),
	"general.visualizerSize": z.enum(["xs", "sm", "md", "lg", "xl"]).catch("xs"),
	"general.showLiveTranscription": z.boolean().catch(true),
	"general.showInAppLiveTranscription": z.boolean().catch(true),
	"general.muteSystemAudioWhileDictating": z.boolean().catch(false),
	// quality
	"quality.enableRealtimeTranscription": z.boolean().catch(true),
	"quality.useMainModelForRealtime": z.boolean().catch(false),
	"quality.ensureSentenceEndsWithPeriod": z.boolean().catch(true),
	// audio
	"audio.sileroSensitivity": z.number().catch(0.4),
	"audio.sileroDeactivityDetection": z.boolean().catch(true),
	// llm
	"llm.enabled": z.boolean().catch(false),
	"llm.provider": z.enum(["ollama", "openrouter"]).catch("ollama"),
	"llm.model": z.string().catch(""),
	"llm.preset": z
		.enum(["neutral", "formal", "friendly", "technical", "casual", "concise"])
		.catch("neutral"),
	"llm.endpoint": z.string().catch("http://localhost:11434"),
	"llm.openrouterApiKey": z.string().catch(""),
	"llm.openrouterModel": z.string().catch(""),
	"llm.openrouterFallbackModel": z.string().catch(""),
	"llm.timeout": z.number().int().catch(5000),
	// schema version (internal)
	_schemaVersion: z.number().optional().catch(undefined),
} as const;

type StoreValueSchemas = typeof storeValueSchemas;

/**
 * Type-safe, Zod-validated accessor for electron-store dot-path keys.
 * Returns the parsed value or the schema's `.catch()` fallback on failure.
 */
export function getStoreValue<K extends keyof StoreValueSchemas>(
	key: K
): z.output<StoreValueSchemas[K]> {
	// electron-store v11 narrowed `get`'s key type to `DotNotationKeyOf<T>` and
	// disallows arbitrary string keys at the type level. Our dot-path keys
	// (e.g. "general.recordingMode") and the internal "_schemaVersion" key
	// don't live under the typed defaults shape, so cast to `string` to fall
	// through to the runtime get-by-path implementation.
	const raw = store.get(key as string);
	const schema = storeValueSchemas[key];
	return (schema as unknown as z.ZodType<z.output<StoreValueSchemas[K]>>).parse(raw);
}

/**
 * Type-safe accessor for CLI arg building — returns the raw value with a
 * narrow type union so callers don't need `as` casts. Returns `undefined`
 * when the key is missing from the store.
 */
export function getStoreRaw(key: string): string | number | boolean | undefined {
	const raw = store.get(key);
	if (raw == null) {
		return;
	}
	if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
		return raw;
	}
	return;
}

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
			showRecordingOverlay: true,
			visualizerSize: "xs" as const,
			showLiveTranscription: true,
			showInAppLiveTranscription: true,
			visualizerType: "bar",
			visualizerBarCount: 9,
			visualizerColor: "#58a6ff",
		},
		hotkey: {
			pushToTalkKey: "LCtrl+LMeta",
		},
		dictionary: [],
		snippets: [],
		llm: {
			enabled: false,
			provider: "ollama" as const,
			endpoint: "http://localhost:11434",
			model: "",
			openrouterApiKey: "",
			openrouterModel: "",
			openrouterFallbackModel: "",
			preset: "neutral" as const,
			timeout: 5000,
		},
		windowBounds: null as { x: number; y: number; width: number; height: number } | null,
	},
});

// ── One-time migration for stale persisted values ────────────────────
// electron-store defaults only apply when a key is missing. If old defaults
// were persisted via settings:save, they override new defaults silently.
const SCHEMA_VERSION = 4;
const currentVersion = getStoreValue("_schemaVersion") ?? 1;

if (currentVersion < SCHEMA_VERSION) {
	// Ensure realtime transcription is enabled with separate tiny model.
	// Use !value to catch both `false` and `undefined` (missing key in persisted JSON).
	if (!getStoreValue("quality.enableRealtimeTranscription")) {
		store.set("quality.enableRealtimeTranscription", true);
	}
	if (getStoreValue("quality.useMainModelForRealtime") !== false) {
		store.set("quality.useMainModelForRealtime", false);
	}
	// Fix silero sensitivity that was incorrectly defaulting to 0.05
	const silero = getStoreValue("audio.sileroSensitivity");
	if (silero === 0.05) {
		store.set("audio.sileroSensitivity", 0.4);
	}
	if (currentVersion < 4) {
		// v4: stale audio.inputDeviceIndex carried a Windows MMDevice index, but
		// the recorder uses PyAudio's index space. The two don't line up, so
		// any persisted index points at the wrong device (or none). Reset to
		// system default; users will re-pick from the now-correct list.
		store.set("audio.inputDeviceIndex", null);
	}
	console.log("[store] Migration applied: _schemaVersion", currentVersion, "→", SCHEMA_VERSION);
	store.set("_schemaVersion", SCHEMA_VERSION);
}
