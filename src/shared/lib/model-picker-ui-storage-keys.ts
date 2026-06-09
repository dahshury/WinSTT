export type LlmModelPickerFeature = "dictation" | "transforms";
export type LlmOpenRouterPickerTarget = "fallback" | "primary";

export function ollamaLlmSelectorUiStorageKey(
	feature: LlmModelPickerFeature,
): string {
	return `winstt:model-picker:llm-ollama:${feature}:ui`;
}

export function openRouterLlmSelectorUiStorageKey(
	feature: LlmModelPickerFeature,
	target: LlmOpenRouterPickerTarget,
): string {
	return `winstt:model-picker:llm-openrouter:${feature}:${target}:ui`;
}
