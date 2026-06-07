import { useEffect, useRef } from "react";
import {
	modelNeedsDictationCleanup,
	useCatalogStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";

export type DictationCleanupAutoAction = "enable" | "none" | "openOllamaPicker";

export interface DictationCleanupAutoInputs {
	dictationEnabled: boolean;
	needsCleanup: boolean;
	ollamaModel: string;
	openrouterApiKey: string;
	provider: string;
	wordByWordPasting: boolean;
}

export function resolveDictationCleanupAutoAction(
	inputs: DictationCleanupAutoInputs,
): DictationCleanupAutoAction {
	if (
		!inputs.needsCleanup ||
		inputs.dictationEnabled ||
		inputs.wordByWordPasting
	) {
		return "none";
	}
	if (inputs.provider === "ollama") {
		return inputs.ollamaModel.trim() ? "enable" : "openOllamaPicker";
	}
	if (inputs.provider === "openrouter") {
		return inputs.openrouterApiKey.trim() ? "enable" : "none";
	}
	if (inputs.provider === "apple-intelligence") {
		return "enable";
	}
	return "none";
}

export function useModelAssistanceAutoEnable(enabled = true): void {
	const selectedModelId = useSettingsStore(
		(s) => s.settings.model?.model ?? "",
	);
	const selectedModel = useCatalogStore((s) => s.getModel(selectedModelId));
	const dictation = useSettingsStore((s) => s.settings.llm.dictation);
	const openrouterApiKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general.wordByWordPasting,
	);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const updateQualitySettings = useSettingsStore(
		(s) => s.updateQualitySettings,
	);
	const openLlmModelPicker = useLlmModelPickerStore((s) => s.openFor);
	const processedModelRef = useRef<string | null>(null);

	useEffect(() => {
		if (!enabled || !selectedModelId || !selectedModel) {
			return;
		}
		if (processedModelRef.current === selectedModelId) {
			return;
		}
		processedModelRef.current = selectedModelId;

		const action = resolveDictationCleanupAutoAction({
			needsCleanup: modelNeedsDictationCleanup(selectedModel),
			dictationEnabled: dictation.enabled,
			ollamaModel: dictation.model,
			openrouterApiKey,
			provider: dictation.provider,
			wordByWordPasting,
		});

		if (action === "enable") {
			updateLlmDictation({ enabled: true });
			updateQualitySettings({ smartEndpoint: false });
			return;
		}
		if (action === "openOllamaPicker") {
			openLlmModelPicker("dictation", true);
		}
	}, [
		dictation.enabled,
		dictation.model,
		dictation.provider,
		enabled,
		openLlmModelPicker,
		openrouterApiKey,
		selectedModel,
		selectedModelId,
		updateLlmDictation,
		updateQualitySettings,
		wordByWordPasting,
	]);
}
