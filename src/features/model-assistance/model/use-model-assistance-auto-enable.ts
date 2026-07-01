import { useEffect, useRef } from "react";
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

	// The STT model id we last evaluated. Starts `undefined` so the FIRST effect
	// pass (app boot / Settings mount / re-mount) is treated as "observe only" —
	// it never auto-toggles anything. The suggestion fires ONLY on a genuine
	// model SWITCH (the user picks a different STT model), which is the one moment
	// the nudge is wanted. This is the core guarantee: mounting, reopening
	// Settings, restarting the app, or toggling the dictation switch can NEVER
	// re-assert cleanup the user turned off — the long-standing "it always boots
	// with post-processing back on / disabling never sticks" bug.
	const lastEvaluatedModelRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!enabled || !selectedModelId) {
			return;
		}
		const previousModelId = lastEvaluatedModelRef.current;
		lastEvaluatedModelRef.current = selectedModelId;

		// Boot/mount (no prior model) or the same model as before → do nothing.
		// Only a real switch to a new model is a suggestion opportunity.
		if (previousModelId === undefined || previousModelId === selectedModelId) {
			return;
		}

		// Belt-and-suspenders persisted guard: never nudge the same model twice
		// across sessions either. `selectedModel` (async catalog object) is needed
		// only to evaluate the cleanup-need; if it hasn't loaded, skip this pass —
		// a later pass re-runs once it resolves, still gated by the switch check.
		const assistance = useModelAssistanceStore.getState();
		if (assistance.hasAutoApplied(selectedModelId) || !selectedModel) {
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
