/**
 * STT adapter for the suggestion engine: catalog models + per-model state →
 * `getSuggestion(modelId)` (the prop the STT pickers thread down, same
 * pattern as `getFitAssessment`).
 *
 * The LANGUAGE RULE is folded in HERE, at the host level (plan Part 3.5):
 * STT models that cannot transcribe the user's selected source language(s)
 * are EXCLUDED (`visible: false`) — the exact rule the realtime picker's
 * prefilter already applies via `modelSupportsSelectedSourceLanguages`.
 * Multilingual / unknown (`languages: []`) always passes.
 */

import {
	type ModelInfo,
	modelSupportsSelectedSourceLanguages,
	type SourceLanguageSelection,
} from "@/entities/model-catalog";
import {
	type MemoryBudgets,
	type ModelSuggestion,
	type SuggestModelInput,
	sttQuantCandidates,
	suggestModels,
} from "@/entities/model-suggestion";
import type { ModelStateEntry } from "@/shared/api/ipc-client";

export type GetModelSuggestion = (modelId: string) => ModelSuggestion | null;

export interface SttSuggestionsInput {
	budgets: MemoryBudgets;
	/** The main-slot model backing the language fallback (see
	 * `resolveSelectedSourceLanguages`). */
	mainModel?: ModelInfo | null | undefined;
	models: readonly ModelInfo[];
	/** `settings.model` — `language` / `autoDetectLanguage` /
	 * `languageCandidates`. */
	sourceLanguageSelection?: SourceLanguageSelection | undefined;
	statesById: Record<string, ModelStateEntry>;
}

function toSuggestInput(
	model: ModelInfo,
	statesById: Record<string, ModelStateEntry>,
	budgets: MemoryBudgets,
): SuggestModelInput {
	const state = statesById[model.id];
	return {
		id: model.id,
		name: model.displayName,
		baseAccuracy: model.accuracyScore,
		baseSpeed: model.speedScore,
		quants: sttQuantCandidates({
			availableQuantizations: model.availableQuantizations,
			// Unknown footprint (no state yet) stays lenient: 0 bytes = fits.
			estimatedBytes: state?.estimated_bytes ?? 0,
			hasGpu: budgets.hasGpu,
			deviceByQuantization: state?.device_by_quantization ?? null,
		}),
	};
}

/** Build the per-model Suggested verdict lookup for an STT picker. */
export function buildSttSuggestions(
	input: SttSuggestionsInput,
): GetModelSuggestion {
	const result = suggestModels(
		input.models.map((model) =>
			toSuggestInput(model, input.statesById, input.budgets),
		),
		input.budgets,
	);
	const modelById = new Map(input.models.map((model) => [model.id, model]));
	return (modelId) => {
		const suggestion = result.byId.get(modelId) ?? null;
		if (suggestion === null) {
			return null;
		}
		const model = modelById.get(modelId);
		if (
			model !== undefined &&
			!modelSupportsSelectedSourceLanguages(
				model,
				input.sourceLanguageSelection,
				input.mainModel,
			)
		) {
			// Language exclusion hides the model but keeps the fit facts —
			// the quant badges stay meaningful should the card surface anyway
			// (e.g. the Suggested filter turned off).
			return { ...suggestion, visible: false };
		}
		return suggestion;
	};
}
