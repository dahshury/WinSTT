/**
 * TTS adapter for the suggestion engine: catalog voices + per-model state →
 * `getSuggestion(modelId)` (the prop the TTS pickers thread down, same
 * host-adapter pattern as `stt-suggestions.ts`).
 *
 * The LANGUAGE RULE is folded in HERE, at the host level (plan Part 3.5):
 * unlike STT (exclusion), a TTS model whose languages miss the user's
 * preferred set is DE-RANKED (`score × LANGUAGE_MISMATCH_FACTOR`), never
 * hidden — read-aloud output may legitimately differ from the dictation
 * language, but mismatches must not outrank matches. Multilingual / unknown
 * (`languages: []`) always counts as a match, as does an empty preferred set.
 *
 * Per-quant fit (plan Part 3.3): bytes = `sizeBytesByQuantization[quant]` ×
 * `TTS_RUNTIME_HEADROOM` (disk ≈ resident for ONNX), falling back to the
 * state store's `estimatedBytes` when the catalog ships no size for a quant;
 * device = the GLOBAL accelerator (TTS follows it — see `ttsSection` in
 * runtime-model-breakdown). Unknown sizes stay lenient (0 bytes = fits).
 */

import { normalizeSttLanguageCode } from "@/entities/model-catalog";
import {
	LANGUAGE_MISMATCH_FACTOR,
	type MemoryBudgets,
	type ModelSuggestion,
	type SuggestModelInput,
	suggestModels,
	ttsQuantCandidates,
} from "@/entities/model-suggestion";
import type { TtsModelStateEntry } from "@/shared/api/ipc-client";

export type GetTtsModelSuggestion = (modelId: string) => ModelSuggestion | null;

/** The catalog fields the adapter needs — a structural subset of
 * `TtsModelInfo` (same trick as `TtsCatalogSizeInfo` in committed-models),
 * so tests feed plain fixtures without the full catalog shape. */
export interface TtsSuggestionCatalogModel {
	id: string;
	displayName: string;
	qualityScore: number;
	speedScore: number;
	languages: readonly string[];
	availableQuantizations: readonly string[];
	sizeBytesByQuantization: Record<string, number>;
}

export interface TtsSuggestionsInput {
	budgets: MemoryBudgets;
	/** The global accelerator's pool — "gpu" when the runtime accelerator is a
	 * GPU EP (TTS follows it; matches `ttsSection` in the breakdown). */
	device: "gpu" | "cpu";
	models: readonly TtsSuggestionCatalogModel[];
	/** The user's preferred language set (normalized ISO-639-1 codes) —
	 * `resolveSelectedSourceLanguages(settings.model, mainModel)`. Empty =
	 * no language rule. */
	preferredLanguages: readonly string[];
	statesById: Record<string, TtsModelStateEntry>;
}

/** Whether the model's languages intersect the preferred set. Lenient on
 * missing data: an empty preferred set or an unreported language list
 * (`languages: []`) never de-ranks. */
export function ttsModelMatchesPreferredLanguages(
	modelLanguages: readonly string[],
	preferredLanguages: readonly string[],
): boolean {
	if (preferredLanguages.length === 0 || modelLanguages.length === 0) {
		return true;
	}
	const preferred = new Set<string>();
	for (const language of preferredLanguages) {
		const normalized = normalizeSttLanguageCode(language);
		if (normalized.length > 0) {
			preferred.add(normalized);
		}
	}
	if (preferred.size === 0) {
		return true;
	}
	// TTS catalogs publish region-tagged codes ("en-us") — normalize to the
	// same base-language space the preferred set lives in.
	return modelLanguages.some((language) =>
		preferred.has(normalizeSttLanguageCode(language)),
	);
}

/** Per-quant byte sizes with the state store's `estimatedBytes` backfilling
 * quants the catalog ships no size for (still lenient when both are unknown). */
function sizesWithEstimateFallback(
	model: TtsSuggestionCatalogModel,
	state: TtsModelStateEntry | undefined,
): Record<string, number> {
	const estimated = state?.estimatedBytes ?? 0;
	const sizes: Record<string, number> = {};
	for (const quant of model.availableQuantizations) {
		const published = model.sizeBytesByQuantization[quant] ?? 0;
		sizes[quant] = published > 0 ? published : estimated;
	}
	return sizes;
}

function toSuggestInput(
	model: TtsSuggestionCatalogModel,
	input: TtsSuggestionsInput,
): SuggestModelInput {
	const matchesLanguage = ttsModelMatchesPreferredLanguages(
		model.languages,
		input.preferredLanguages,
	);
	return {
		id: model.id,
		name: model.displayName,
		baseAccuracy: model.qualityScore,
		baseSpeed: model.speedScore,
		quants: ttsQuantCandidates({
			availableQuantizations: model.availableQuantizations,
			sizeBytesByQuantization: sizesWithEstimateFallback(
				model,
				input.statesById[model.id],
			),
			device: input.device,
		}),
		// DE-RANK, not exclude (plan Part 3.5): visibility stays fit-driven.
		scoreFactor: matchesLanguage ? 1 : LANGUAGE_MISMATCH_FACTOR,
	};
}

/** Build the per-model Suggested verdict lookup for a TTS picker. */
export function buildTtsSuggestions(
	input: TtsSuggestionsInput,
): GetTtsModelSuggestion {
	const result = suggestModels(
		input.models.map((model) => toSuggestInput(model, input)),
		input.budgets,
	);
	return (modelId) => result.byId.get(modelId) ?? null;
}
