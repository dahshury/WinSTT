import { useConnectionStore } from "@/entities/connection";
import {
	resolveSelectedSourceLanguages,
	useCatalogStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import type { TtsModelStateEntry } from "@/shared/api/ipc-client";
import {
	buildTtsSuggestions,
	type GetTtsModelSuggestion,
	type TtsSuggestionCatalogModel,
} from "../lib/tts-suggestions";
import { useSuggestionBudgets } from "./use-suggestion-budgets";

export interface UseTtsSuggestionsArgs {
	models: readonly TtsSuggestionCatalogModel[];
	statesById: Record<string, TtsModelStateEntry>;
}

/**
 * The `getSuggestion` prop for a TTS picker host: cross-modality budgets
 * (TTS's own slot excluded — swapping replaces, not stacks) → per-quant fit
 * (bytes × headroom against the GLOBAL accelerator's pool) → bang-for-buck
 * score, with the language DE-RANK (never exclusion) folded in against the
 * resolved dictation-language set.
 *
 * Returns `undefined` until the server's system info has arrived — the picker
 * treats that as "no verdict" (Suggested chip hidden, flag inert), never as a
 * zero budget that would hide everything.
 */
export function useTtsSuggestions(
	args: UseTtsSuggestionsArgs,
): GetTtsModelSuggestion | undefined {
	const budgets = useSuggestionBudgets("tts");
	// TTS follows the runtime accelerator (`runtime_info.is_gpu`), falling back
	// to GPU presence when unknown — the same rule as `ttsCommitted`.
	const isGpuAccelerator = useConnectionStore(
		(s) => s.runtimeInfo?.is_gpu ?? null,
	);
	// The preferred language set is the dictation-language resolution the STT
	// pickers use (`languageCandidates` > pinned `language` > the main model's
	// languages under auto-detect) — an unloaded STT catalog degrades to the
	// lenient empty set (no de-rank), never to an error.
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const sttModels = useCatalogStore((s) => s.models);
	if (budgets === null) {
		return undefined;
	}
	const mainModel =
		sttModels.find((m) => m.id === modelSettings?.model) ?? null;
	return buildTtsSuggestions({
		budgets,
		device: (isGpuAccelerator ?? budgets.hasGpu) ? "gpu" : "cpu",
		models: args.models,
		preferredLanguages: resolveSelectedSourceLanguages(
			modelSettings,
			mainModel,
		),
		statesById: args.statesById,
	});
}
