import type {
	ModelInfo,
	SourceLanguageSelection,
} from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	buildSttSuggestions,
	type GetModelSuggestion,
} from "../lib/stt-suggestions";
import { useSuggestionBudgets } from "./use-suggestion-budgets";

export interface UseSttSuggestionsArgs {
	mainModel?: ModelInfo | null | undefined;
	models: readonly ModelInfo[];
	sourceLanguageSelection?: SourceLanguageSelection | undefined;
	statesById: Record<string, ModelStateEntry>;
}

/**
 * The `getSuggestion` prop for an STT picker host: cross-modality budgets
 * (STT's own slot excluded — swapping replaces, not stacks) → per-quant fit →
 * bang-for-buck score, with the language exclusion folded in.
 *
 * Returns `undefined` until the server's system info has arrived — the picker
 * treats that as "no verdict" (Suggested chip hidden, flag inert), never as a
 * zero budget that would hide everything.
 */
export function useSttSuggestions(
	args: UseSttSuggestionsArgs,
): GetModelSuggestion | undefined {
	const budgets = useSuggestionBudgets("stt");
	if (budgets === null) {
		return undefined;
	}
	return buildSttSuggestions({
		budgets,
		mainModel: args.mainModel,
		models: args.models,
		sourceLanguageSelection: args.sourceLanguageSelection,
		statesById: args.statesById,
	});
}
