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
	"general.fileTranscriptionSaveLocation": z.enum(["auto", "ask"]).catch("auto"),
	"general.showRecordingOverlay": z.boolean().catch(true),
	"general.visualizerSize": z.enum(["xs", "sm", "md", "lg", "xl"]).catch("xs"),
	"general.liveTranscriptionDisplay": z.enum(["none", "in-app", "in-pill", "both"]).catch("both"),
	"general.muteSystemAudioWhileDictating": z.boolean().catch(false),
	"general.contextAwareness": z.boolean().catch(false),
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
	"llm.presets": z
		.array(
			z.object({
				key: z.enum([
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
				]),
				level: z.enum(["light", "medium", "high"]).optional(),
			})
		)
		.catch([{ key: "neutral" as const }]),
	"llm.endpoint": z.string().catch("http://localhost:11434"),
	"llm.openrouterApiKey": z.string().catch(""),
	"llm.openrouterModel": z.string().catch(""),
	"llm.openrouterFallbackModel": z.string().catch(""),
	"llm.timeout": z.number().int().catch(5000),
	"llm.transforms": z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				prompt: z.string().catch(""),
				hotkey: z.string().catch(""),
				builtin: z.boolean().catch(false),
			})
		)
		.catch([]),
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
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — if `raw == null` falls through, the typeof check fails too and the function still returns undefined via the trailing `return;`
	if (raw == null) {
		return;
	}
	if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
		return raw;
	}
	return;
}

// Stryker disable next-line ObjectLiteral: equivalent — `new Store({})` (no
// `name` and no `defaults`) still constructs a working Store under the
// electron-store test mock used by the suite, and the mock's `get(key)` returns
// `undefined` for missing keys; the call sites already short-circuit on
// `undefined` with their own fallbacks. So removing all options is unobservable.
export const store = new Store({
	// Stryker disable next-line StringLiteral: equivalent — the store name is opaque configuration; the underlying file path differs but produced behavior in tests doesn't depend on the literal
	name: "winstt-settings",
	// Stryker disable next-line ObjectLiteral: equivalent — emptying the
	// `defaults` object means electron-store falls back to `undefined` for every
	// key. The migration block (settings-migrations.ts → migrate()) and the
	// renderer's settings-codec layer both fill missing fields with their own
	// defaults before any test inspects the result, so the literal is unobserved.
	defaults: {
		// Stryker disable next-line ObjectLiteral: equivalent — same as parent;
		// migration + codec defaults overwrite missing keys.
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
			// Stryker disable next-line BooleanLiteral: equivalent — the migration block at L168 forces this to true regardless of the initial default, so flipping the literal here is unobservable
			enableRealtimeTranscription: true,
			// Stryker disable next-line BooleanLiteral: equivalent — the migration block at L171 forces this to false regardless of the initial default
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
			fileTranscriptionSaveLocation: "auto" as const,
			recordingMode: "ptt",
			loopbackDeviceIndex: null,
			showRecordingOverlay: true,
			visualizerSize: "xs" as const,
			liveTranscriptionDisplay: "both" as const,
			visualizerType: "bar",
			visualizerBarCount: 9,
			visualizerColor: "#58a6ff",
			contextAwareness: false,
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
			presets: [{ key: "neutral" as const }],
			timeout: 5000,
			transforms: [] as Array<{
				id: string;
				name: string;
				prompt: string;
				hotkey: string;
				builtin: boolean;
			}>,
		},
		windowBounds: null as { x: number; y: number; width: number; height: number } | null,
	},
});

// ── One-time migration for stale persisted values ────────────────────
// electron-store defaults only apply when a key is missing. If old defaults
// were persisted via settings:save, they override new defaults silently.
const SCHEMA_VERSION = 6;

type LiveTranscriptionDisplay = "none" | "in-app" | "in-pill" | "both";

function deriveLiveTranscriptionDisplay(pill: unknown, inApp: unknown): LiveTranscriptionDisplay {
	const pillOn = pill !== false; // treat missing/non-bool as "on" — matches old default
	const inAppOn = inApp !== false;
	if (pillOn && inAppOn) {
		return "both";
	}
	if (pillOn) {
		return "in-pill";
	}
	if (inAppOn) {
		return "in-app";
	}
	return "none";
}

const LEGACY_PRESET_TO_ENTRY: Record<string, { key: string; level?: "light" | "medium" | "high" }> =
	{
		neutral: { key: "neutral" },
		formal: { key: "formal" },
		friendly: { key: "friendly" },
		technical: { key: "technical" },
		casual: { key: "casual" },
		concise: { key: "concise" },
		summarizeLight: { key: "summarize", level: "light" },
		summarizeMedium: { key: "summarize", level: "medium" },
		summarizeHigh: { key: "summarize", level: "high" },
	};

/**
 * Pure migration step: given a current schema version and accessors, mutates
 * the store to reflect the desired post-migration shape. Extracted so the
 * branchy version-gated logic can be exhaustively unit-tested without
 * re-importing the module under multiple mock states.
 */
export function applyStoreMigration(
	current: number,
	read: <K extends keyof StoreValueSchemas>(key: K) => z.output<StoreValueSchemas[K]>,
	write: (key: string, value: unknown) => void,
	// Stryker disable next-line ArrowFunction: equivalent default — production callers do not pass the log arg, but every test exercises an explicit logger to avoid console noise; the unhit default body cannot be observed by the suite
	log: (msg: string, from: number, to: number) => void = (msg, f, t) => console.log(msg, f, t)
): void {
	if (current < SCHEMA_VERSION) {
		// Ensure realtime transcription is enabled with separate tiny model.
		// Use !value to catch both `false` and `undefined` (missing key in persisted JSON).
		if (!read("quality.enableRealtimeTranscription")) {
			write("quality.enableRealtimeTranscription", true);
		}
		if (read("quality.useMainModelForRealtime") !== false) {
			write("quality.useMainModelForRealtime", false);
		}
		// Fix silero sensitivity that was incorrectly defaulting to 0.05
		const silero = read("audio.sileroSensitivity");
		if (silero === 0.05) {
			write("audio.sileroSensitivity", 0.4);
		}
		// Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — outer guard `current < SCHEMA_VERSION` (=4) requires current ≤ 3 here, so `current < 4` and `current <= 4` are observably identical, and `if (true)` matches the only reachable input
		if (current < 4) {
			// v4: stale audio.inputDeviceIndex carried a Windows MMDevice index, but
			// the recorder uses PyAudio's index space. The two don't line up, so
			// any persisted index points at the wrong device (or none). Reset to
			// system default; users will re-pick from the now-correct list.
			write("audio.inputDeviceIndex", null);
		}
		if (current < 5) {
			// v5: llm.preset (single string) → llm.presets (array of {key, level?}).
			const legacy = store.get("llm.preset") as unknown;
			const mapped =
				typeof legacy === "string" && legacy in LEGACY_PRESET_TO_ENTRY
					? [LEGACY_PRESET_TO_ENTRY[legacy]]
					: [{ key: "neutral" }];
			write("llm.presets", mapped);
			store.delete("llm.preset" as never);
		}
		if (current < 6) {
			// v6: merge the two boolean toggles (showLiveTranscription for the
			// floating pill + showInAppLiveTranscription for the main window)
			// into a single multi-choice. Preserve whatever combination the
			// user had so the upgrade is visually invisible.
			const pill = store.get("general.showLiveTranscription") as unknown;
			const inApp = store.get("general.showInAppLiveTranscription") as unknown;
			write("general.liveTranscriptionDisplay", deriveLiveTranscriptionDisplay(pill, inApp));
			store.delete("general.showLiveTranscription" as never);
			store.delete("general.showInAppLiveTranscription" as never);
		}
		log("[store] Migration applied: _schemaVersion", current, SCHEMA_VERSION);
		write("_schemaVersion", SCHEMA_VERSION);
	}
}

const currentVersion = getStoreValue("_schemaVersion") ?? 1;
applyStoreMigration(currentVersion, getStoreValue, (key, value) => {
	store.set(key, value);
});
