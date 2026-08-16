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

const presetLevelSchema = z.enum(["light", "medium", "high", "caveman"]);
const standardPresetLevelSchema = z.enum(["light", "medium", "high"]);

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
	.refine((entry) => entry.level !== "caveman" || entry.key === "concise", {
		message: "caveman level is only allowed for concise",
		path: ["level"],
	})
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

// User-authored cleanup modifiers layered on top of the built-in tone /
// independent presets. Unlike `presetsSchema` (which holds only *active*
// built-in keys), this array persists the full definition even while
// `enabled` is false so the name/prompt the user wrote survives a toggle.
// `level` is always allowed here — for a custom modifier the Low/Medium/High
// switcher tunes intensity of the single authored prompt rather than
// selecting between distinct texts (see `CUSTOM_LEVEL_HINT`). Caveman is
// concise-only, so custom modifiers intentionally keep the standard levels.
const customModifierSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	prompt: z.string().default(""),
	enabled: z.boolean().default(false),
	// When false the prompt is applied verbatim; when true the Low/Medium/High
	// switcher appears on the row and `level` tunes the intensity hint.
	levelsEnabled: z.boolean().default(false),
	level: standardPresetLevelSchema.optional(),
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
	maxOutputTokens: z
		.number()
		.int()
		.min(1)
		.max(200_000)
		.nullable()
		.default(null),
	// Thinking budget for Ollama models that advertise the `thinking`
	// capability via `/api/show`. Mirrors Ollama's `ThinkValue`:
	//   - `"off"` → `think: false` (force-disable for thinking models)
	//   - `"low" | "medium" | "high"` → passed verbatim as the request field
	// Non-thinking models always send `think: false` regardless of this
	// setting; the chat-body builder gates on the capability check.
	thinkingEffort: z.enum(["off", "low", "medium", "high"]).default("off"),
};

// Id of the saved CONFIGURATION a feature is assigned to, or "" when its stack
// was hand-edited away from every saved one. The resolved provider/model/tone/
// modifiers still live on the feature itself: the backend reads those verbatim
// and knows nothing about configurations, so assignment stays a renderer concern
// (the same denormalized shape `llm.appProfiles.rules[].config` already uses).
//
// Defaults to the shipped "Default" configuration (`DEFAULT_CONFIGURATION_ID`)
// because a feature must not be enableable without one — there would be no
// prompt to run. That configuration is the plainest possible stack: base cleanup,
// neutral tone, no modifiers.
const configurationIdSchema = z.string().default("builtin:default");

const llmDictationSchema = z.object({
	enabled: z.boolean().default(false),
	dictionaryAutoAddEnabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	configurationId: configurationIdSchema,
	presets: presetsSchema.default(defaultNeutralPresets),
	// Empty by default; rows are appended from the Modifiers UI. Folded into
	// the runtime presets array at processing time via
	// `mergePresetsWithCustomModifiers` — never persisted into `presets`.
	customModifiers: z.array(customModifierSchema).default([]),
});

// Post-processing applied to text on its way to the SYNTHESIZER (read-aloud),
// as opposed to `llmDictationSchema`, which post-processes text on its way to
// the KEYBOARD. Its own preset/modifier set on purpose: "summarize what I just
// dictated" and "summarize what you are about to read to me" are different
// intents that happen to share one prompt vocabulary.
//
// Carries its own provider/model like the other two consumers: a configuration
// chooses its PROVIDER, and a cloud read-aloud pass alongside a local dictation
// pass is a supported (and cheap) combination. The one thing it cannot choose
// freely is the LOCAL model — see `localModel` below. Mirrors the Rust
// `LlmReadAloud` defaults for the parity gate.
const llmReadAloudSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	configurationId: configurationIdSchema,
	presets: presetsSchema.default(defaultNeutralPresets),
	customModifiers: z.array(customModifierSchema).default([]),
});

const llmTransformsSchema = z.object({
	enabled: z.boolean().default(false),
	...llmFeatureBaseShape,
	configurationId: configurationIdSchema,
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
});

const appProfileConfigSchema = z.object({
	...llmFeatureBaseShape,
	presets: presetsSchema.default(defaultNeutralPresets),
	customModifiers: z.array(customModifierSchema).default([]),
});

const appProfileRuleSchema = z.object({
	id: z.string().min(1),
	enabled: z.boolean().default(true),
	appExe: z.string().default(""),
	titlePattern: z.string().default(""),
	urlPattern: z.string().default(""),
	configurationId: z.string().default(""),
	configurationName: z.string().default(""),
	config: appProfileConfigSchema.prefault({}),
});

const appProfilesSchema = z.object({
	rules: z.array(appProfileRuleSchema).default([]).catch([]),
});

export const llmSettingsSchema = z.object({
	// Shared infrastructure (one Ollama instance, one OpenRouter account).
	// `.catch(...)` is load-bearing: `z.url()` REJECTS a malformed/empty string
	// (a hand-edit, a sync conflict, or a UI field momentarily holding an
	// invalid URL), and without the catch that failure nukes the WHOLE `llm`
	// section back to defaults on the next decode — silently wiping the user's
	// provider/model/preset config. The catch rehydrates to the canonical
	// Ollama default so a bad endpoint can only reset the endpoint field.
	endpoint: z
		.url()
		.default("http://localhost:11434")
		.catch("http://localhost:11434"),
	openrouterApiKey: z.string().default(""),
	// Global combo that cycles through the user-ordered post-processing profiles.
	profileSwapHotkey: z
		.string()
		.min(1)
		.default("LCtrl+LShift+P")
		.catch("LCtrl+LShift+P"),
	// THE local Ollama model, shared by every feature whose assigned
	// configuration runs locally.
	//
	// Why one: local models are VRAM-resident. Ollama accepts several
	// (`OLLAMA_MAX_LOADED_MODELS` defaults to 3), but when they don't all fit it
	// does NOT fail — it queues the request and evicts an idle model, so every
	// switch between features silently pays a full reload. One model by default
	// makes that impossible. Cloud configurations are unconstrained: they carry
	// their own `openrouterModel` and cost no memory here.
	localModel: z.string().default(""),
	// Power-user escape hatch: let each configuration pick its own LOCAL model
	// instead of sharing `localModel`. Off by default — on a machine that can't
	// hold them all it turns every feature switch into an Ollama evict-and-reload,
	// which reads as random multi-second stalls rather than as an error.
	allowMultipleLocalModels: z.boolean().default(false),
	// Per-feature config — each independently picks provider + model.
	// The feature runs iff its own `enabled` is true AND a model is configured;
	// there is no master switch (the IPC layer treats "no model" as off).
	dictation: llmDictationSchema.prefault({}),
	// Modifiers applied to read-aloud text before synthesis (see above).
	readAloud: llmReadAloudSchema.prefault({}),
	transforms: llmTransformsSchema.prefault({}),
	appProfiles: appProfilesSchema.prefault({}),
	// Cloud LLM request timeout (ms). Applied to every OpenRouter LLM attempt:
	// dictation cleanup, transforms/hotkeys, app profiles, and playground
	// previews. Local Ollama inference is intentionally outside this deadline.
	// `.catch(5000)`: a persisted out-of-range value (for example, a hand edit)
	// would otherwise reject and drag the whole `llm` section to defaults.
	timeout: z.number().int().min(1000).max(30_000).default(5000).catch(5000),
});
