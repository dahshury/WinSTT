import { z } from "zod";

const presetKeySchema = z.enum([
	"neutral",
	"formal",
	"friendly",
	"technical",
	"concise",
	"summarize",
	"reorder",
	"restructure",
	"rewordForClarity",
	"translate",
]);

const presetLevelSchema = z.enum(["light", "medium", "high"]);

const KEYS_WITH_LEVELS = new Set(["summarize", "concise"]);
const TONE_KEYS = new Set(["neutral", "formal", "friendly", "technical"]);

const presetEntrySchema = z
	.object({
		key: presetKeySchema,
		level: presetLevelSchema.optional(),
		// English name of the target language; only meaningful for `translate`.
		// Mirrors how `level` parameterizes summarize/concise.
		targetLang: z.string().optional(),
	})
	.refine(
		(entry) => entry.level === undefined || KEYS_WITH_LEVELS.has(entry.key),
		{
			message: "level is only allowed for summarize or concise",
			path: ["level"],
		},
	)
	.refine(
		(entry) => entry.targetLang === undefined || entry.key === "translate",
		{
			message: "targetLang is only allowed for the translate preset",
			path: ["targetLang"],
		},
	);

const presetsSchema = z
	.array(presetEntrySchema)
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
		{ message: "duplicate preset keys are not allowed" },
	)
	.refine(
		(entries) => {
			const toneCount = entries.filter((e) => TONE_KEYS.has(e.key)).length;
			return toneCount <= 1;
		},
		{
			message:
				"only one tone preset (neutral/formal/friendly/technical) may be active",
		},
	);

function defaultNeutralPresets() {
	return [{ key: "neutral" as const }];
}

function defaultDictationPresets() {
	return [
		{ key: "neutral" as const },
		{ key: "reorder" as const },
		{ key: "restructure" as const },
		{ key: "rewordForClarity" as const },
	];
}

// User-authored cleanup modifiers layered on top of the built-in tone /
// independent presets. Unlike `presetsSchema` (which holds only *active*
// built-in keys), this array persists the full definition even while
// `enabled` is false so the name/prompt the user wrote survives a toggle.
// `level` is always allowed here — for a custom modifier the Low/Medium/High
// switcher tunes intensity of the single authored prompt rather than
// selecting between distinct texts (see `CUSTOM_LEVEL_HINT`).
const customModifierSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	prompt: z.string().default(""),
	enabled: z.boolean().default(false),
	// When false the prompt is applied verbatim; when true the Low/Medium/High
	// switcher appears on the row and `level` tunes the intensity hint.
	levelsEnabled: z.boolean().default(false),
	level: presetLevelSchema.optional(),
});

// Per-feature provider config. Dictation and transforms each pick their own
// provider (Ollama, OpenRouter, or Apple Intelligence) and own model
// selection independently — so e.g. dictation can run a fast local Ollama
// while transforms hits an OpenRouter frontier model. Infra-level fields
// (Ollama endpoint URL, OpenRouter API key) stay shared on
// `llmSettingsSchema` — one Ollama instance, one OpenRouter account.
// `apple-intelligence` is a no-config provider that runs Apple's on-device
// FoundationModels through a bundled Swift CLI; it has no endpoint/key/
// model field of its own (the platform decides). The UI hides this option
// on non-darwin / non-arm64 hosts; settings will round-trip the value if
// it was persisted on a different machine.
const llmFeatureBaseShape = {
	provider: z
		.enum(["ollama", "openrouter", "apple-intelligence"])
		.default("ollama"),
	model: z.string().default(""),
	openrouterModel: z.string().default(""),
	openrouterFallbackModel: z.string().default(""),
	// OpenRouter request-tuning parameters. Only sent on the wire when the
	// selected model's `supported_parameters` advertises support, but the
	// defaults persist so the picker's ReasoningControls renders consistent
	// initial values regardless of the previously-selected model.
	// `"off"` disables reasoning entirely → `reasoning: { enabled: false }`
	// (the same off/low/medium/high scale as Ollama's `thinkingEffort`).
	reasoningEffort: z.enum(["off", "low", "medium", "high"]).default("medium"),
	verbosity: z.enum(["low", "medium", "high"]).default("medium"),
	maxOutputTokens: z.number().int().min(1).nullable().default(null),
	// Thinking budget for Ollama models that advertise the `thinking`
	// capability via `/api/show`. Mirrors Ollama's `ThinkValue`:
	//   - `"off"` → `think: false` (force-disable for thinking models)
	//   - `"low" | "medium" | "high"` → passed verbatim as the request field
	// Non-thinking models always send `think: false` regardless of this
	// setting; the chat-body builder gates on the capability check.
	thinkingEffort: z.enum(["off", "low", "medium", "high"]).default("off"),
};

const llmDictationSchema = z.object({
	enabled: z.boolean().default(false),
	dictionaryAutoAddEnabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	presets: presetsSchema.default(defaultDictationPresets),
	// Empty by default; rows are appended from the Modifiers UI. Folded into
	// the runtime presets array at processing time via
	// `mergePresetsWithCustomModifiers` — never persisted into `presets`.
	customModifiers: z.array(customModifierSchema).default([]),
});

// Single user-configurable text transform. Mirrors the OpenAPI `Transform`
// schema (see `spec/openapi.yaml`). Built-in entries flag `builtin: true`
// so the UI can show a Reset action instead of Delete.
const transformSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	prompt: z.string().default(""),
	hotkey: z.string().default(""),
	builtin: z.boolean().default(false),
});

const llmTransformsSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	// Same composition shape as dictation: ordered preset list + custom modifiers.
	// At runtime, mergePresetsWithCustomModifiers folds them into a single prompt
	// applied to the currently-selected text.
	presets: presetsSchema.default(defaultNeutralPresets),
	customModifiers: z.array(customModifierSchema).default([]),
	// Always non-empty: transforms the feature stays gated by `enabled`, but the
	// hotkey itself must always carry a valid combo (Ctrl+Shift+T) so the
	// conflict checker can compare against it and the recorder UI never renders
	// an empty chip. The transform can still be invoked from the UI.
	hotkey: z.string().min(1).default("LCtrl+LShift+T").catch("LCtrl+LShift+T"),
	// User-configurable text transforms. Each entry carries its own prompt
	// and optional hotkey. Built-in entries (see `BUILTIN_TRANSFORMS`) carry
	// `builtin: true` so the UI can show a Reset action instead of Delete.
	prompts: z.array(transformSchema).default([]),
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
