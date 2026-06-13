import { useEffect } from "react";
import {
	modelNeedsDictationCleanup,
	useCatalogStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useModelAssistanceStore } from "./model-assistance-store";

export type DictationCleanupAutoAction = "enable" | "none" | "openOllamaPicker";

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

export function useModelAssistanceAutoEnable({
	enabled = true,
	onOpenOllamaPicker,
}: ModelAssistanceAutoEnableOptions = {}): void {
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

	useEffect(() => {
		if (!enabled || !selectedModelId || !selectedModel) {
			return;
		}
		// PERSISTED guard (not a per-mount ref): once we've auto-evaluated a
		// model we never auto-toggle dictation for it again, so reopening
		// Settings or restarting the app can't silently re-enable cleanup that
		// the user turned off. Reading/writing imperatively keeps the effect's
		// deps identical to the value-driven inputs below.
		const assistance = useModelAssistanceStore.getState();
		if (assistance.hasAutoApplied(selectedModelId)) {
			return;
		}
		assistance.markAutoApplied(selectedModelId);

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
			onOpenOllamaPicker?.();
		}
	}, [
		dictation.enabled,
		dictation.model,
		dictation.provider,
		enabled,
		onOpenOllamaPicker,
		openrouterApiKey,
		selectedModel,
		selectedModelId,
		updateLlmDictation,
		updateQualitySettings,
		wordByWordPasting,
	]);
}
