/**
 * `@winstt/model-picker` — public API.
 *
 * Self-contained OpenRouter / Ollama / STT model picker widget. Consumed via
 * the `@picker` alias by `widgets/model-picker-window`, `widgets/llm-settings`,
 * `widgets/model-settings`, `widgets/status-bar`, `features/swap-model`, and
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
export { resolveEffectiveQuant, resolveQuantCache } from "./stt/lib/cache-helpers";
export { STT_PICKER_WIDTH_PX } from "./stt/lib/dimensions";
export { getFamilyConfig, variantDisplayName } from "./stt/lib/family-helpers";
export { isRealtimeViable } from "./stt/lib/realtime-viability";
export { SttModelSelector } from "./stt/ui/SttModelSelector";
export { SttModelSelectorTriggerButton } from "./stt/ui/SttModelSelectorTrigger";
export { TtsModelCard, type TtsModelCardProps } from "./tts/ui/TtsModelCard";
export { TtsModelSelector, type TtsModelSelectorProps } from "./tts/ui/TtsModelSelector";
export { OpenRouterModelSelector } from "./ui/OpenRouterModelSelector";
export {
	ReasoningEffortDropdown,
	type ReasoningEffortDropdownProps,
} from "./ui/ReasoningEffortDropdown";
export type { ReasoningEffort } from "./config/model-selector-options";
