/**
 * `@winstt/model-picker` — public API.
 *
 * Self-contained OpenRouter / Ollama / STT model picker widget. Consumed via
 * the `@picker` alias by `widgets/model-picker-window`, `widgets/llm-settings`,
 * `widgets/model-settings`, `features/swap-model`, and
 * `features/model-download`.
 */

export type {
	ReasoningEffort,
	Verbosity,
} from "./config/model-selector-options";
export {
	computeModelExclusionConfig,
	filterModelsForFallback,
	isFallbackExcluded,
	type ModelExclusionConfig,
} from "./lib/model-exclusion";
export type {
	ModelVariant,
	ModelVariantInfo,
} from "./lib/model-variant-utils";
export type {
	FilterableParameter,
	OpenRouterProvider,
	ParameterInfo,
	ProviderInfo,
	ProviderPreferences,
	ProviderSortOption,
} from "./lib/openrouter-provider-utils";
export type { OpenRouterModelSelectorProps } from "./model/openrouter-model-selector.types";
export {
	OllamaModelSelector,
	type OllamaModelSelectorProps,
} from "./ollama/ui/OllamaModelSelector";
export { resolveQuantCache } from "./stt/lib/cache-helpers";
export { STT_PICKER_WIDTH_PX } from "./stt/lib/dimensions";
export { isRealtimeViable } from "./stt/lib/realtime-viability";
export {
	type SttModelChange,
	SttModelSelector,
	type SttModelSelectorProps,
} from "./stt/ui/SttModelSelector";
export type {
	PickerLabels,
	TranslateFn,
} from "./types";
export { OpenRouterModelSelector } from "./ui/OpenRouterModelSelector";
