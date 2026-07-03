export type DictationCleanupAutoAction = "none";

export interface DictationCleanupAutoInputs {
	dictationEnabled: boolean;
	needsCleanup: boolean;
	ollamaModel: string;
	openrouterApiKey: string;
	provider: string;
	wordByWordPasting: boolean;
}

export interface ModelAssistanceAutoEnableOptions {
	enabled?: boolean;
	onOpenOllamaPicker?: () => void;
}

export function resolveDictationCleanupAutoAction(
	_inputs: DictationCleanupAutoInputs,
): DictationCleanupAutoAction {
	return "none";
}

export function useModelAssistanceAutoEnable(
	_options: ModelAssistanceAutoEnableOptions = {},
): void {
	// Intentionally inert. Model-specific cleanup guidance is shown in
	// ProcessingExtrasPanel, but switching the STT model must never mutate the
	// Ollama/OpenRouter dictation post-processing toggle.
}
