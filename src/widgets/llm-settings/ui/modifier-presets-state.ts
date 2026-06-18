import type {
	LlmFeatureDraft,
	PresetCarrier,
} from "../lib/llm-settings-panel-test-helpers";
import type { LlmConfiguration } from "../model/configurations";

export function seedDraftFromFeature(
	f: LlmFeatureDraft & PresetCarrier,
): LlmConfiguration {
	return {
		enabled: f.enabled,
		maxOutputTokens: f.maxOutputTokens,
		provider: f.provider,
		model: f.model,
		openrouterModel: f.openrouterModel,
		openrouterFallbackModel: f.openrouterFallbackModel,
		reasoningEffort: f.reasoningEffort,
		thinkingEffort: f.thinkingEffort,
		verbosity: f.verbosity,
		presets: [...f.presets],
		customModifiers: [...f.customModifiers],
	};
}
