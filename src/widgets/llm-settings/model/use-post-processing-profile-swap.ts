import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { onPostProcessingProfileSwap } from "@/shared/api/ipc-client";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import {
	type LlmConfiguration,
	matchPostProcessingProfileId,
	postProcessingPatchFromConfiguration,
	useLlmConfigurationsStore,
} from "./configurations";

type LlmDictationSettings = AppSettingsOutput["llm"]["dictation"];

function configFromDictation(feature: LlmDictationSettings): LlmConfiguration {
	return {
		enabled: feature.enabled,
		maxOutputTokens: feature.maxOutputTokens,
		provider: feature.provider,
		model: feature.model,
		openrouterModel: feature.openrouterModel,
		openrouterFallbackModel: feature.openrouterFallbackModel,
		reasoningEffort: feature.reasoningEffort,
		thinkingEffort: feature.thinkingEffort,
		verbosity: feature.verbosity,
		presets: [...feature.presets],
		customModifiers: [...feature.customModifiers],
	};
}

function resolveNextProfileIndex(
	count: number,
	currentIndex: number,
	activeIndex: number,
): number {
	const start = currentIndex >= 0 ? currentIndex : activeIndex;
	return start >= 0 ? (start + 1) % count : 0;
}

/**
 * Resolve which saved post-processing preset the current dictation settings
 * correspond to, for surfacing the active preset's NAME (e.g. the tray-indicator
 * pill on a profile-swap hotkey). Reads the same configurations store + matcher
 * the swap uses, so it stays in lock-step with what `usePostProcessingProfileSwap`
 * activates. Returns `null` when nothing matches (custom/unsaved config).
 */
export function resolveActivePostProcessingPreset(
	dictation: LlmDictationSettings,
): { id: string; name: string } | null {
	const { configurations } = useLlmConfigurationsStore.getState();
	if (configurations.length === 0) {
		return null;
	}
	const id = matchPostProcessingProfileId(
		configFromDictation(dictation),
		configurations,
	);
	if (!id) {
		return null;
	}
	const match = configurations.find((c) => c.id === id);
	return match ? { id, name: match.name } : null;
}

export function usePostProcessingProfileSwap() {
	useEffect(
		() =>
			onPostProcessingProfileSwap(() => {
				const settingsStore = useSettingsStore.getState();
				const configStore = useLlmConfigurationsStore.getState();
				const { configurations } = configStore;
				if (configurations.length === 0) {
					return;
				}
				const currentConfig = configFromDictation(
					settingsStore.settings.llm.dictation,
				);
				const currentId = matchPostProcessingProfileId(
					currentConfig,
					configurations,
				);
				const currentIndex = configurations.findIndex(
					(c) => c.id === currentId,
				);
				const activeIndex = configurations.findIndex(
					(c) => c.id === configStore.activeConfigurationId,
				);
				const nextIndex = resolveNextProfileIndex(
					configurations.length,
					currentIndex,
					activeIndex,
				);
				const next = configurations[nextIndex];
				if (!next) {
					return;
				}
				settingsStore.updateLlmPostProcessing(
					postProcessingPatchFromConfiguration(next.config),
				);
				configStore.setActiveConfiguration(next.id);
			}),
		[],
	);
}
