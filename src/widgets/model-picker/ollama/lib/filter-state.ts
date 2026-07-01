import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";

/**
 * The two boolean catalog filters the Ollama picker exposes, ported from the
 * STT selector's {@link import("../../stt/lib/filter-state").SttFilterState}.
 *
 * `installedOnly` is the Ollama analogue of STT's `cachedOnly` — it hides every
 * card that isn't already on disk (recommended, typed-tag, library) so the list
 * collapses to just the models the user has downloaded. `fitsHardwareOnly`
 * mirrors STT's filter of the same name. STT's `realtimeOnly` / `languages`
 * filters have no Ollama analogue and are intentionally dropped.
 */
export interface OllamaFilterState {
	fitsHardwareOnly: boolean;
	installedOnly: boolean;
}

export const EMPTY_OLLAMA_FILTER_STATE: OllamaFilterState = {
	installedOnly: false,
	fitsHardwareOnly: false,
};

/** Boolean toggles in display order — keeps the count/active logic table-driven
 *  and is reused by the menu to render one checkbox per flag. */
const OLLAMA_FILTER_FLAGS = ["installedOnly", "fitsHardwareOnly"] as const;

export type OllamaFilterFlag = (typeof OLLAMA_FILTER_FLAGS)[number];

/** Active-filter count over a chosen flag subset (the menu passes only the
 *  flags it actually renders, so a stale `fitsHardwareOnly` from a host without
 *  system-fit data never inflates the trigger badge). */
export function ollamaActiveFilterCount(
	filters: OllamaFilterState,
	flags: readonly OllamaFilterFlag[] = OLLAMA_FILTER_FLAGS,
): number {
	return flags.filter((key) => filters[key]).length;
}

export function isOllamaFilterState(
	value: unknown,
): value is OllamaFilterState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<OllamaFilterState>;
	return (
		typeof candidate.installedOnly === "boolean" &&
		typeof candidate.fitsHardwareOnly === "boolean"
	);
}

/** Minimal shape of the host's fit lookup — kept structural so this lib stays
 *  free of the UI-layer `OllamaFitInfo` type (FSD: a lib slice must not reach
 *  up into `ui`). The selector's `systemFit` is structurally compatible. */
export type OllamaFitLookup = (sizeBytes: number) => { fits: boolean };

/**
 * An installed model "fits" when the host can actually run it. Unknown / zero
 * on-disk sizes — or a missing lookup — are treated as a fit, the same lenient
 * rule STT applies to models with an unknown footprint, so the filter never
 * hides a model purely because we lack the data to judge it.
 */
export function installedModelFitsHardware(
	m: OllamaModel,
	getFit: OllamaFitLookup | undefined,
): boolean {
	const bytes = m.size ?? 0;
	if (!getFit || bytes <= 0) {
		return true;
	}
	return getFit(bytes).fits;
}

/** Recommended-model variant of {@link installedModelFitsHardware} —
 *  recommended cards carry their download size on `sizeBytes`. */
export function recommendedModelFitsHardware(
	m: RecommendedOllamaModel,
	getFit: OllamaFitLookup | undefined,
): boolean {
	if (!getFit || m.sizeBytes <= 0) {
		return true;
	}
	return getFit(m.sizeBytes).fits;
}

/**
 * Apply the active filters to the installed-model list. Only `fitsHardwareOnly`
 * prunes installed models — they are, by definition, already downloaded, so
 * `installedOnly` is a no-op here. Returns the input reference untouched when no
 * pruning filter is active (avoids a per-render copy of the installed list).
 */
export function filterInstalledOllamaModels(
	models: readonly OllamaModel[],
	filters: OllamaFilterState,
	getFit: OllamaFitLookup | undefined,
): readonly OllamaModel[] {
	if (!filters.fitsHardwareOnly) {
		return models;
	}
	return models.filter((m) => installedModelFitsHardware(m, getFit));
}

/**
 * Apply the active filters to the recommended-model list. `installedOnly`
 * empties it (recommended cards are by definition not installed); otherwise
 * `fitsHardwareOnly` prunes the ones the host can't run.
 */
export function filterRecommendedOllamaModels(
	models: readonly RecommendedOllamaModel[],
	filters: OllamaFilterState,
	getFit: OllamaFitLookup | undefined,
): readonly RecommendedOllamaModel[] {
	if (filters.installedOnly) {
		return [];
	}
	if (!filters.fitsHardwareOnly) {
		return models;
	}
	return models.filter((m) => recommendedModelFitsHardware(m, getFit));
}
