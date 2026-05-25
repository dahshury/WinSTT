/**
 * `@winstt/model-picker` — public API.
 *
 * Self-contained OpenRouter / Ollama / STT model picker widget. Consumed via
 * the `@picker` alias by `widgets/model-picker-window`, `widgets/llm-settings`,
 * `widgets/model-settings`, `features/swap-model`, and
 * `features/model-download`.
 */

export {
	computeModelExclusionConfig,
	filterModelsForFallback,
	isFallbackExcluded,
} from "./lib/model-exclusion";
export {
	OllamaModelSelector,
	type OllamaModelSelectorProps,
} from "./ollama/ui/OllamaModelSelector";
export { resolveQuantCache } from "./stt/lib/cache-helpers";
export { STT_PICKER_WIDTH_PX } from "./stt/lib/dimensions";
export { isRealtimeViable } from "./stt/lib/realtime-viability";
export { SttModelSelector } from "./stt/ui/SttModelSelector";
export { OpenRouterModelSelector } from "./ui/OpenRouterModelSelector";
