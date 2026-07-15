import {
	buildOllamaSuggestions,
	type OllamaSuggestions,
} from "../lib/ollama-suggestions";
import { useSuggestionBudgets } from "./use-suggestion-budgets";

/**
 * The `suggestions` prop for an Ollama picker host: cross-modality budgets
 * (the LLM slot excluded — swapping replaces, not stacks) → either-pool
 * per-tag fit + the bang-for-buck proxy ranking.
 *
 * Returns `undefined` until the server's system info has arrived — the picker
 * treats that as "no verdict" (Suggested chip hidden, flag inert), never as a
 * zero budget that would hide everything.
 */
export function useOllamaSuggestions(): OllamaSuggestions | undefined {
	const budgets = useSuggestionBudgets("llm");
	if (budgets === null) {
		return undefined;
	}
	return buildOllamaSuggestions(budgets);
}
