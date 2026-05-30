import { create } from "zustand";
import { useSettingsStore } from "@/entities/setting";

type LlmPickerFeature = "dictation" | "transforms";

interface LlmModelPickerState {
	close: () => void;
	/**
	 * A model finished installing (or an already-installed one was selected) in
	 * the picker. Write it to the pending feature, enabling that feature ONLY
	 * when the open was a turn-on request. This is the single commit point that
	 * upholds the invariant "LLM cleanup is never enabled without a real model":
	 * the toggle opens the picker but never flips `enabled` itself — only a
	 * landed model does, here.
	 */
	commitInstalled: (model: string) => void;
	/** When true, a model that installs/selects commits `enabled: true` for the
	 *  pending feature — the toggle-driven "turn this on" path. When false the
	 *  picker only writes the model (a plain "change my model" browse), leaving
	 *  `enabled` untouched. */
	enableOnInstall: boolean;
	/** Which LLM feature opened the picker (null when closed). */
	feature: LlmPickerFeature | null;
	open: boolean;
	openFor: (feature: LlmPickerFeature, enableOnInstall: boolean) => void;
}

/**
 * Coordinates the Ollama model-picker modal for the two LLM features
 * (dictation cleanup / text transforms). The modal itself
 * (`OllamaModelManagerDialog`) is a widget, so — per the FSD widget→widget ban
 * — it is rendered at the VIEW layer (SettingsPage, OnboardingPage) while this
 * feature store is the shared coordination point both the settings widget and
 * the onboarding widget drive. One store, identical behavior in both surfaces.
 */
export const useLlmModelPickerStore = create<LlmModelPickerState>((set, get) => ({
	enableOnInstall: false,
	feature: null,
	open: false,
	openFor: (feature, enableOnInstall) => set({ open: true, feature, enableOnInstall }),
	close: () => set({ open: false, feature: null, enableOnInstall: false }),
	commitInstalled: (model) => {
		const { feature, enableOnInstall } = get();
		if (feature === null) {
			return;
		}
		const settings = useSettingsStore.getState();
		const patch = enableOnInstall
			? { model, provider: "ollama" as const, enabled: true }
			: { model, provider: "ollama" as const };
		if (feature === "dictation") {
			settings.updateLlmDictation(patch);
			if (enableOnInstall) {
				// Mutual exclusion with Smart Endpoint — mirrors the panel's
				// `disableSmartEndpoint`: turning dictation cleanup on turns the
				// Smart Endpoint heuristic off.
				settings.updateQualitySettings({ smartEndpoint: false });
			}
			return;
		}
		settings.updateLlmTransforms(patch);
	},
}));
