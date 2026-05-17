/**
 * `@winstt/model-picker` — public API.
 *
 * Self-contained OpenRouter model picker widget. The package owns all the UI
 * components (combobox, provider rail, filters menu, virtualized list,
 * reasoning controls, etc.), the lib helpers (filtering, search, variant
 * parsing, provider tables), and the type contract.
 *
 * Currently uses `@/shared/*` runtime primitives (Badge, Button, Spinner,
 * InfoTooltip, surface helpers, cn) inside its UI files. The package works
 * fully inside WinSTT today; lifting it to a different monorepo is a
 * follow-up "vendor the primitives" pass.
 */

// Reasoning / verbosity / max-tokens option lists — also used by callers
// to construct settings UI outside the picker (e.g. surface the same labels
// on a summary card).
export {
	REASONING_EFFORT_OPTIONS,
	type ReasoningEffort,
	VERBOSITY_OPTIONS,
	type Verbosity,
} from "./config/model-selector-options";
// Fallback-exclusion helpers (used by callers wiring a primary + fallback
// pair, e.g. dictation+transforms with one OpenRouter account).
export {
	computeModelExclusionConfig,
	filterModelsForFallback,
	isAutoModel,
	isEndpointExcluded,
	isFallbackExcluded,
	type ModelExclusionConfig,
	OPENROUTER_AUTO_MODEL_ID,
} from "./lib/model-exclusion";
// Lib helpers — pure functions exposed for callers that want to share the
// picker's variant table, provider table, or filter logic outside the picker.
export {
	filterByVariant,
	getAvailableVariants,
	getBaseModelId,
	getModelVariant,
	hasAnyVariant,
	hasVariant,
	MODEL_VARIANT_INFO,
	MODEL_VARIANTS,
	type ModelVariant,
	type ModelVariantInfo,
	parseModelVariant,
	setModelVariant,
} from "./lib/model-variant-utils";
export {
	FILTERABLE_PARAMETERS,
	type FilterableParameter,
	formatProviderName,
	isKnownProvider,
	OPENROUTER_PROVIDERS,
	type OpenRouterProvider,
	PARAMETER_INFO,
	type ParameterInfo,
	PROVIDER_INFO,
	PROVIDER_SORT_OPTIONS,
	type ProviderInfo,
	type ProviderPreferences,
	type ProviderSortOption,
} from "./lib/openrouter-provider-utils";
export type { OpenRouterModelSelectorProps } from "./model/openrouter-model-selector.types";
export {
	formatFamily as formatOllamaFamily,
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
	groupOllamaModelsByFamily,
	groupOllamaModelsByPublisher,
} from "./ollama/lib/family-helpers";

// Ollama picker — same visual language as the OpenRouter and STT pickers,
// specialized for Ollama's `/api/tags` shape. Replaces the prior
// `SearchableSelect`-based one-liner; groups installed models by family and
// surfaces parameter count + quantization level chips.
export {
	OllamaModelSelector,
	type OllamaModelSelectorProps,
} from "./ollama/ui/OllamaModelSelector";
// STT helpers exposed for the settings panel's quantization label + realtime
// viability check (used outside the picker for download progress UI etc.).
export { resolveQuantCache } from "./stt/lib/cache-helpers";
export { isRealtimeViable } from "./stt/lib/realtime-viability";
// Whisper / NeMo / GigaAM / Kaldi / Lite-Whisper / T-One STT picker.
export {
	type SttModelChange,
	SttModelSelector,
	type SttModelSelectorProps,
} from "./stt/ui/SttModelSelector";
// Type contract (consumer-provided translate function + label keys).
export {
	DEFAULT_LABELS,
	identityTranslate,
	type PickerLabels,
	resolveLabel,
	type TranslateFn,
} from "./types";
// Public components — the pickers themselves. The package exposes one picker
// per model-type family; they share primitives (Tooltip wrappers, search
// affordances, badge styling) and visual language but each is specialized
// for its own data shape so no feature is dropped.
export { OpenRouterModelSelector } from "./ui/OpenRouterModelSelector";
