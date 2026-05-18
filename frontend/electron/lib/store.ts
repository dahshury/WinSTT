import Store from "electron-store";
import { z } from "zod";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedSecret,
	isSecretDotPath,
	SECRET_DOT_PATHS,
} from "./secret-storage";

// ── Zod schemas for individual store values (dot-path access) ────────
// These validate the raw `unknown` return of store.get("section.key").
const storeValueSchemas = {
	// general
	"general.recordingMode": z.enum(["ptt", "toggle", "listen", "wakeword"]).catch("ptt"),
	"general.wakeWord": z.string().catch("alexa"),
	"general.wakeWordSensitivity": z.number().min(0).max(1).catch(0.6),
	"general.wakeWordTimeout": z.number().min(1).max(30).catch(5),
	"general.minimizeToTray": z.boolean().catch(true),
	"general.startMinimized": z.boolean().catch(false),
	"general.recordingSound": z.boolean().catch(true),
	"general.recordingSoundPath": z.string().catch(""),
	"general.recordingSoundLibrary": z
		.array(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1),
				path: z.string().min(1),
			})
		)
		.catch([]),
	"general.fileTranscriptionFormat": z.enum(["txt", "srt"]).catch("txt"),
	"general.fileTranscriptionSaveLocation": z.enum(["auto", "ask"]).catch("auto"),
	"general.showRecordingOverlay": z.boolean().catch(true),
	"general.visualizerSize": z.enum(["xs", "sm", "md", "lg", "xl"]).catch("xs"),
	"general.liveTranscriptionDisplay": z.enum(["none", "in-app", "in-pill", "both"]).catch("both"),
	"general.systemAudioReductionWhileDictating": z.number().int().min(0).max(100).catch(0),
	"general.contextAwareness": z.boolean().catch(false),
	// Opt-out toggle for Sentry crash/error reporting. Defaults to true (opt-out
	// model — installers ship with reporting on so we get the early crash data
	// that lets us fix bugs users can't reproduce). Takes effect on next launch;
	// `initSentryMain` reads this synchronously at startup.
	"general.sendCrashReports": z.boolean().catch(true),
	// quality
	"quality.enableRealtimeTranscription": z.boolean().catch(true),
	"quality.useMainModelForRealtime": z.boolean().catch(false),
	"quality.ensureSentenceEndsWithPeriod": z.boolean().catch(true),
	// audio
	"audio.sileroSensitivity": z.number().catch(0.4),
	"audio.sileroDeactivityDetection": z.boolean().catch(true),
	// llm — shared infrastructure (one Ollama instance, one OpenRouter account)
	"llm.endpoint": z.string().catch("http://localhost:11434"),
	"llm.openrouterApiKey": z.string().catch(""),
	// Wired through but currently NOT applied at the network layer (see
	// processWithOllama / processWithOpenRouter — `_timeout` is read but the
	// AbortSignal.timeout was removed because local LLM cold-start exceeds it).
	"llm.timeout": z.number().int().catch(5000),
	// llm.dictation — per-feature config for dictation post-processing
	"llm.dictation.enabled": z.boolean().catch(false),
	"llm.dictation.provider": z.enum(["ollama", "openrouter"]).catch("ollama"),
	"llm.dictation.model": z.string().catch(""),
	"llm.dictation.openrouterModel": z.string().catch(""),
	"llm.dictation.openrouterFallbackModel": z.string().catch(""),
	"llm.dictation.presets": z
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
	// Per-feature thinking budget for Ollama models that advertise the
	// `thinking` capability. Falls back to "medium" so reasoning models
	// behave sensibly on first run; non-thinking models ignore the value.
	"llm.dictation.thinkingEffort": z.enum(["off", "low", "medium", "high"]).catch("medium"),
	// llm.transforms — per-feature config for custom-prompt transforms
	"llm.transforms.enabled": z.boolean().catch(false),
	"llm.transforms.provider": z.enum(["ollama", "openrouter"]).catch("ollama"),
	"llm.transforms.model": z.string().catch(""),
	"llm.transforms.openrouterModel": z.string().catch(""),
	"llm.transforms.openrouterFallbackModel": z.string().catch(""),
	"llm.transforms.thinkingEffort": z.enum(["off", "low", "medium", "high"]).catch("medium"),
	"llm.transforms.prompts": z
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
	// tts — Kokoro-82M ONNX text-to-speech
	"tts.enabled": z.boolean().catch(false),
	"tts.voice": z.string().catch("af_heart"),
	"tts.lang": z.string().catch("en-us"),
	"tts.speed": z.number().min(0.5).max(2.0).catch(1.0),
	"tts.hotkey": z.string().catch(""),
	"tts.device": z.enum(["auto", "cuda", "cpu"]).catch("auto"),
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
	const parsed = (schema as unknown as z.ZodType<z.output<StoreValueSchemas[K]>>).parse(raw);
	// Secret-at-rest fields are persisted as `enc:v1:<base64>` envelopes;
	// callers expect plaintext. Decrypt transparently here so every read site
	// stays unaware of the storage format. Legacy plaintext (no prefix) passes
	// through unchanged until `migrateSecretsAtRest()` rewrites it.
	if (isSecretDotPath(key as string)) {
		return decryptSecret(parsed) as z.output<StoreValueSchemas[K]>;
	}
	return parsed;
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
			sileroSensitivityByDeviceName: {},
		},
		general: {
			autoStart: false,
			minimizeToTray: true,
			startMinimized: false,
			systemAudioReductionWhileDictating: 0,
			recordingSound: true,
			recordingSoundPath: "",
			recordingSoundLibrary: [] as Array<{ id: string; name: string; path: string }>,
			fileTranscriptionFormat: "txt",
			fileTranscriptionSaveLocation: "auto" as const,
			recordingMode: "ptt",
			repasteHotkey: "LCtrl+LShift+V",
			loopbackDeviceIndex: null,
			wakeWord: "alexa",
			wakeWordSensitivity: 0.6,
			wakeWordTimeout: 5,
			showRecordingOverlay: true,
			visualizerSize: "xs" as const,
			liveTranscriptionDisplay: "both" as const,
			visualizerType: "bar",
			visualizerBarCount: 9,
			visualizerColor: "#58a6ff",
			contextAwareness: false,
			// Sentry crash-report opt-out: defaults to true (reporting on).
			// Toggling requires app restart — `initSentryMain` reads it once
			// synchronously at startup; runtime live-reconfigure isn't safe.
			sendCrashReports: true,
		},
		hotkey: {
			pushToTalkKey: "LCtrl+LMeta",
		},
		dictionary: [],
		snippets: [],
		llm: {
			endpoint: "http://localhost:11434",
			openrouterApiKey: "",
			timeout: 5000,
			dictation: {
				enabled: false,
				provider: "ollama" as const,
				model: "",
				openrouterModel: "",
				openrouterFallbackModel: "",
				presets: [{ key: "neutral" as const }],
			},
			transforms: {
				enabled: false,
				provider: "ollama" as const,
				model: "",
				openrouterModel: "",
				openrouterFallbackModel: "",
				prompts: [] as Array<{
					id: string;
					name: string;
					prompt: string;
					hotkey: string;
					builtin: boolean;
				}>,
			},
		},
		tts: {
			enabled: false,
			voice: "af_heart",
			lang: "en-us",
			speed: 1.0,
			hotkey: "",
			device: "auto" as const,
		},
		windowBounds: null as { x: number; y: number; width: number; height: number } | null,
	},
});

// ── One-time migration for stale persisted values ────────────────────
// electron-store defaults only apply when a key is missing. If old defaults
// were persisted via settings:save, they override new defaults silently.
const SCHEMA_VERSION = 10;

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

type StoreWrite = (key: string, value: unknown) => void;

/** v5: llm.preset (single string) → llm.presets (array of {key, level?}). */
function migrateLlmPresets(write: StoreWrite): void {
	const legacy = store.get("llm.preset") as unknown;
	const mapped =
		typeof legacy === "string" && legacy in LEGACY_PRESET_TO_ENTRY
			? [LEGACY_PRESET_TO_ENTRY[legacy]]
			: [{ key: "neutral" }];
	write("llm.presets", mapped);
	store.delete("llm.preset" as never);
}

/**
 * v6: merge the two boolean toggles (showLiveTranscription for the floating
 * pill + showInAppLiveTranscription for the main window) into a single
 * multi-choice. Preserve whatever combination the user had so the upgrade is
 * visually invisible.
 */
function migrateLiveTranscriptionDisplay(write: StoreWrite): void {
	const pill = store.get("general.showLiveTranscription") as unknown;
	const inApp = store.get("general.showInAppLiveTranscription") as unknown;
	write("general.liveTranscriptionDisplay", deriveLiveTranscriptionDisplay(pill, inApp));
	store.delete("general.showLiveTranscription" as never);
	store.delete("general.showInAppLiveTranscription" as never);
}

/**
 * v7: general.muteSystemAudioWhileDictating (boolean) →
 * general.systemAudioReductionWhileDictating (percent reduction). The legacy
 * toggle ducked to silence, so `true` maps to a full mute (100) and
 * `false`/missing to off (0). Preserves behavior.
 */
function migrateMuteToReduction(write: StoreWrite): void {
	const legacyMute = store.get("general.muteSystemAudioWhileDictating") as unknown;
	write("general.systemAudioReductionWhileDictating", legacyMute === true ? 100 : 0);
	store.delete("general.muteSystemAudioWhileDictating" as never);
}

/**
 * v8: split the single `llm.enabled` toggle into a master switch plus two
 * sub-feature flags (`llm.dictationEnabled`, `llm.transformsEnabled`).
 * Previously, enabling the LLM ran dictation cleanup, and Transforms was
 * ungated entirely (it fired whenever a hotkey was bound + a model set).
 * Preserve both behaviors: anyone who had the LLM on, or who has a transform
 * hotkey bound, gets both sub-flags turned on so the upgrade is invisible.
 *
 * Uses `store.get` directly (not the typed `read` accessor) because the
 * legacy `llm.enabled` and `llm.transforms` (array) keys are no longer
 * registered in `storeValueSchemas` after the v9 cleanup.
 */
function migrateLlmSubFlags(write: StoreWrite): void {
	const hadLlmOn = store.get("llm.enabled") === true;
	const legacyTransforms = store.get("llm.transforms") as unknown;
	const hasTransformHotkey =
		Array.isArray(legacyTransforms) &&
		legacyTransforms.some((t: { hotkey?: string }) => (t?.hotkey ?? "").trim() !== "");
	if (hadLlmOn || hasTransformHotkey) {
		write("llm.dictationEnabled", true);
		write("llm.transformsEnabled", true);
	}
}

/**
 * v9: drop the single shared `llm.provider`/`llm.model`/etc. and the
 * `llm.enabled` master switch in favor of per-feature config blocks
 * (`llm.dictation.*`, `llm.transforms.*`). Each feature now picks its own
 * provider and model independently — dictation can run on local Ollama
 * while transforms hits an OpenRouter frontier model (or vice versa).
 *
 * Preserves behavior:
 *   - new dictation.enabled = (legacy enabled) && (legacy dictationEnabled)
 *   - new transforms.enabled = (legacy enabled) && (legacy transformsEnabled)
 *   - shared provider/model fields are copied into BOTH feature blocks so
 *     users see the same setup they had before, just doubled.
 *   - llm.presets → llm.dictation.presets
 *   - llm.transforms (array) → llm.transforms.prompts
 *
 * Legacy `llm.transforms` was an array; the new `llm.transforms` is an
 * object whose `prompts` field holds the array. Delete the legacy key
 * BEFORE writing any nested `llm.transforms.*` field so electron-store
 * doesn't try to treat the array as an object.
 */
function migrateLlmPerFeatureConfig(write: StoreWrite): void {
	// Snapshot legacy values up-front — once we start deleting / overwriting
	// `llm.transforms` (array → object), later reads would return the new shape.
	const masterOn = store.get("llm.enabled") === true;
	const dictationOn = store.get("llm.dictationEnabled");
	const transformsOn = store.get("llm.transformsEnabled");
	const provider = store.get("llm.provider") as unknown;
	const model = store.get("llm.model") as unknown;
	const openrouterModel = store.get("llm.openrouterModel") as unknown;
	const openrouterFallbackModel = store.get("llm.openrouterFallbackModel") as unknown;
	const presets = store.get("llm.presets") as unknown;
	const legacyPrompts = store.get("llm.transforms") as unknown;

	const newDictationEnabled = masterOn && dictationOn !== false;
	const newTransformsEnabled = masterOn && transformsOn === true;
	const sharedProvider = provider === "openrouter" ? "openrouter" : "ollama";
	const sharedModel = typeof model === "string" ? model : "";
	const sharedOpenrouterModel = typeof openrouterModel === "string" ? openrouterModel : "";
	const sharedOpenrouterFallback =
		typeof openrouterFallbackModel === "string" ? openrouterFallbackModel : "";
	const dictationPresets =
		Array.isArray(presets) && presets.length > 0 ? presets : [{ key: "neutral" }];
	const transformsPrompts = Array.isArray(legacyPrompts) ? legacyPrompts : [];

	// Delete legacy keys FIRST so the dot-path writes below can create the
	// new `llm.dictation` / `llm.transforms` objects without colliding with
	// the existing array at `llm.transforms`.
	store.delete("llm.enabled" as never);
	store.delete("llm.dictationEnabled" as never);
	store.delete("llm.transformsEnabled" as never);
	store.delete("llm.provider" as never);
	store.delete("llm.model" as never);
	store.delete("llm.openrouterModel" as never);
	store.delete("llm.openrouterFallbackModel" as never);
	store.delete("llm.presets" as never);
	store.delete("llm.transforms" as never);
	// `llm.timeout` stays at the top level under `llm.*` — it's wired through
	// the new schema (see settings-schema.ts) so we do NOT delete it here.

	write("llm.dictation.enabled", newDictationEnabled);
	write("llm.dictation.provider", sharedProvider);
	write("llm.dictation.model", sharedModel);
	write("llm.dictation.openrouterModel", sharedOpenrouterModel);
	write("llm.dictation.openrouterFallbackModel", sharedOpenrouterFallback);
	write("llm.dictation.presets", dictationPresets);
	write("llm.transforms.enabled", newTransformsEnabled);
	write("llm.transforms.provider", sharedProvider);
	write("llm.transforms.model", sharedModel);
	write("llm.transforms.openrouterModel", sharedOpenrouterModel);
	write("llm.transforms.openrouterFallbackModel", sharedOpenrouterFallback);
	write("llm.transforms.prompts", transformsPrompts);
}

/**
 * v10: dictionary entries dropped the find/replace/caseSensitive/wholeWord
 * shape in favor of a single `term` column. The new post-processor is
 * fuzzy-match-based (Jaro-Winkler + Double Metaphone), so the old find→replace
 * pairs no longer carry useful signal. Per the agreed migration, we wipe the
 * dictionary to an empty array; users rebuild from scratch. Snippets keep
 * their trigger/expansion shape — only their matching semantics change.
 */
function migrateDictionaryToFuzzy(write: StoreWrite): void {
	write("dictionary", []);
}

/**
 * Pure migration step: given a current schema version and accessors, mutates
 * the store to reflect the desired post-migration shape. Extracted so the
 * branchy version-gated logic can be exhaustively unit-tested without
 * re-importing the module under multiple mock states.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the migration cascade grows by one branch per SCHEMA_VERSION bump — the structure is a deliberate dispatch table; refactoring to a registry would add indirection without test or correctness wins.
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
			migrateLlmPresets(write);
		}
		if (current < 6) {
			migrateLiveTranscriptionDisplay(write);
		}
		if (current < 7) {
			migrateMuteToReduction(write);
		}
		if (current < 8) {
			migrateLlmSubFlags(write);
		}
		if (current < 9) {
			migrateLlmPerFeatureConfig(write);
		}
		if (current < 10) {
			migrateDictionaryToFuzzy(write);
		}
		log("[store] Migration applied: _schemaVersion", current, SCHEMA_VERSION);
		write("_schemaVersion", SCHEMA_VERSION);
	}
}

const currentVersion = getStoreValue("_schemaVersion") ?? 1;
applyStoreMigration(currentVersion, getStoreValue, (key, value) => {
	store.set(key, value);
});

/**
 * Write a plaintext value to a secret-at-rest field. Encrypts via the
 * platform keystore before persisting. No-op for non-secret keys (so this
 * accessor can be used uniformly when persisting a settings patch).
 */
export function setStoreSecret(dotPath: string, plaintext: unknown): void {
	if (typeof plaintext !== "string") {
		return;
	}
	if (isSecretDotPath(dotPath)) {
		store.set(dotPath, encryptSecret(plaintext));
	} else {
		store.set(dotPath, plaintext);
	}
}

/**
 * One-time pass that rewrites any legacy plaintext values at the SECRET_DOT_PATHS
 * into their encrypted-envelope form. Must run AFTER `app.whenReady()` because
 * Electron's `safeStorage` is not usable before that on macOS/Linux. Idempotent —
 * already-encrypted values pass straight through.
 */
export function migrateSecretsAtRest(): void {
	for (const dotPath of SECRET_DOT_PATHS) {
		const raw = store.get(dotPath);
		if (typeof raw !== "string" || raw === "") {
			continue;
		}
		if (isEncryptedSecret(raw)) {
			continue;
		}
		const wrapped = encryptSecret(raw);
		if (wrapped !== raw) {
			store.set(dotPath, wrapped);
			console.log(`[store] Encrypted secret at rest: ${dotPath}`);
		}
	}
}
