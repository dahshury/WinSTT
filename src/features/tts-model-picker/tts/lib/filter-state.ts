import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { countActiveFlags } from "@/shared/ui/model-picker/core/lib/filter-state";

export interface TtsFilterState {
	availableOnly: boolean;
	cachedOnly: boolean;
	cloningOnly: boolean;
	languages: string[];
	multilingualOnly: boolean;
	quantizations: string[];
	/** Spec-based "Suggested" filter (default ON): hide models with NO quant
	 *  that fits this machine's memory budgets (bytes × runtime headroom
	 *  against the global accelerator's pool). The predicate itself is
	 *  injected by the host via {@link filterTtsModels}'s `suggested` param —
	 *  when the host hasn't wired one (budgets not loaded yet) the flag is
	 *  inert. */
	suggestedOnly: boolean;
	voiceDesignOnly: boolean;
}

export const EMPTY_TTS_FILTER_STATE: TtsFilterState = {
	availableOnly: false,
	cachedOnly: false,
	cloningOnly: false,
	languages: [],
	multilingualOnly: false,
	quantizations: [],
	suggestedOnly: true,
	voiceDesignOnly: false,
};

/** A persisted filter blob may predate the `suggestedOnly` flag. */
export type PersistedTtsFilterState = Omit<TtsFilterState, "suggestedOnly"> &
	Partial<Pick<TtsFilterState, "suggestedOnly">>;

/** Migration rule: persisted blobs written before the Suggested filter lack
 *  the key — a MISSING `suggestedOnly` defaults to `true` (ON for existing
 *  users), it is never treated as invalid state. */
export function normalizeTtsFilterState(
	filters: PersistedTtsFilterState,
): TtsFilterState {
	return {
		suggestedOnly: true,
		...filters,
		languages: [...filters.languages],
		quantizations: [...filters.quantizations],
	};
}

/**
 * Boolean toggles counted toward the trigger badge. `suggestedOnly` is
 * deliberately EXCLUDED: it is ON by default and surfaced by its own
 * always-visible chip, so counting it would permanently badge the filter
 * trigger with "1 active" and keep "Clear all" lit in the default state
 * (same convention as the STT menu's `TOGGLE_KEYS`).
 */
const FLAG_KEYS = [
	"availableOnly",
	"cachedOnly",
	"cloningOnly",
	"multilingualOnly",
	"voiceDesignOnly",
] as const;

export function activeTtsFilterCount(filters: TtsFilterState): number {
	return (
		countActiveFlags(filters, FLAG_KEYS) +
		filters.languages.length +
		filters.quantizations.length
	);
}

export function hasActiveTtsFilters(filters: TtsFilterState): boolean {
	return activeTtsFilterCount(filters) > 0;
}

/** Validates a persisted filter blob. A MISSING `suggestedOnly` is VALID (old
 *  blob, defaults to ON via {@link normalizeTtsFilterState}); a present but
 *  non-boolean one is not. */
export function isTtsFilterState(
	value: unknown,
): value is PersistedTtsFilterState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<TtsFilterState>;
	return (
		typeof candidate.availableOnly === "boolean" &&
		typeof candidate.cachedOnly === "boolean" &&
		typeof candidate.cloningOnly === "boolean" &&
		Array.isArray(candidate.languages) &&
		candidate.languages.every((value) => typeof value === "string") &&
		typeof candidate.multilingualOnly === "boolean" &&
		Array.isArray(candidate.quantizations) &&
		candidate.quantizations.every((value) => typeof value === "string") &&
		(candidate.suggestedOnly === undefined ||
			typeof candidate.suggestedOnly === "boolean") &&
		typeof candidate.voiceDesignOnly === "boolean"
	);
}

export function collectTtsLanguages(models: readonly TtsModelInfo[]): string[] {
	return [...new Set(models.flatMap((model) => model.languages))].toSorted();
}

export function collectTtsQuantizations(
	models: readonly TtsModelInfo[],
): string[] {
	return [
		...new Set(models.flatMap((model) => model.availableQuantizations)),
	].toSorted();
}

function isCached(state: TtsModelState | undefined): boolean {
	return Object.values(state?.cacheByQuantization ?? {}).some(
		(cache) => cache?.state === "cached",
	);
}

/**
 * Apply the menu filters. The Suggested predicate (`suggested`,
 * host-injected; `null`/absent = no verdict, flag inert) hides models with
 * NO quant fitting the memory budgets — it composes with every other filter,
 * mirroring `passesSuggestedFilter` in the STT filter path.
 */
export function filterTtsModels(
	models: readonly TtsModelInfo[],
	filters: TtsFilterState,
	statesById: Record<string, TtsModelState>,
	suggested?: ((model: TtsModelInfo) => boolean) | null,
): TtsModelInfo[] {
	const useSuggested = filters.suggestedOnly && suggested != null;
	return models.filter(
		(model) =>
			(!useSuggested || suggested(model)) &&
			(!filters.availableOnly || model.available) &&
			(!filters.cachedOnly || isCached(statesById[model.id])) &&
			(!filters.cloningOnly || model.cloning !== "none") &&
			(!filters.multilingualOnly || model.languages.length > 1) &&
			(!filters.voiceDesignOnly || model.voiceDesign) &&
			(filters.languages.length === 0 ||
				filters.languages.some((language) =>
					model.languages.includes(language),
				)) &&
			(filters.quantizations.length === 0 ||
				filters.quantizations.some((quantization) =>
					model.availableQuantizations.includes(quantization),
				)),
	);
}
