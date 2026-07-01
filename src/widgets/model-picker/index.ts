/**
 * model-picker widget — public API.
 *
 * OpenRouter / Ollama / STT model picker. Imported from `@/widgets/model-picker`
 * by `widgets/model-picker-window`, `widgets/llm-settings`, `widgets/model-settings`,
 * `widgets/status-bar`, `features/swap-model`, and `features/model-download`.
 */

export {
	computeModelExclusionConfig,
	filterModelsForFallback,
} from "./lib/model-exclusion";
export {
	resolveEffectiveQuant,
	resolveQuantCache,
} from "@/entities/model-catalog";
export { OllamaModelSelector } from "./ollama/ui/OllamaModelSelector";
export type { OllamaModelSelectorProps } from "./ollama/ui/ollama-selector-types";
export { STT_PICKER_WIDTH_PX } from "./stt/lib/dimensions";
export { getFamilyConfig, variantDisplayName } from "./stt/lib/family-helpers";
export { isRealtimeViable } from "./stt/lib/realtime-viability";
export { SttModelSelector } from "./stt/ui/SttModelSelector";
export { SttModelSelectorTriggerButton } from "./stt/ui/SttModelSelectorTrigger";
export { TtsModelCard, type TtsModelCardProps } from "./tts/ui/TtsModelCard";
export {
	TtsModelSelector,
	type TtsModelSelectorProps,
} from "./tts/ui/TtsModelSelector";
export { OpenRouterModelSelector } from "./ui/OpenRouterModelSelector";
export {
	ReasoningEffortDropdown,
	type ReasoningEffortDropdownProps,
} from "./ui/ReasoningEffortDropdown";
export type { ReasoningEffort } from "./config/model-selector-options";
